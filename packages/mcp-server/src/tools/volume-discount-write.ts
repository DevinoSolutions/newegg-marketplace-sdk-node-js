/**
 * The gated preview/apply pair for volume-discount updates (contracts §22), mirroring the listing
 * preview/apply flow (ADR 0005). `newegg_volume_discount_preview_update` validates and normalizes
 * the tiers offline (zero network), stores them under a cryptographically random previewId, and
 * returns the plan. `newegg_volume_discount_apply_update` atomically consumes that previewId and
 * submits the VOLUME_DISCOUNT_DATA feed — it registers only when writes are enabled.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServerConfig } from "../config/index.js";
import type { VolumeDiscountPreviewRecord } from "../preview-store/index.js";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  rateLimitOutputSchema,
  serializeRateLimit,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { appendConsumedNote, consumeTypedPreview } from "./preview-apply-core.js";
import { feedRequestStatusSchema } from "./operation-result.js";
import { TOOL_NAMES } from "./names.js";
import { hashItemsPreview, sealFor } from "./preview-hash.js";

// ---------------------------------------------------------------------------
// input schema (mirrors the SDK's VolumeDiscountUpdate)
// ---------------------------------------------------------------------------
const tierInputSchema = z.strictObject({
  quantity: z
    .number()
    .int()
    .min(2)
    .describe("Minimum order quantity for this tier (integer >= 2, above the previous tier's)."),
  sellingPrice: z
    .number()
    .positive()
    .finite()
    .describe("Per-unit price at this tier (below the previous tier's price)."),
  freeShipping: z.boolean().optional().describe("Free shipping at this tier. Default false."),
});

const updateItemSchema = z
  .strictObject({
    neweggItemNumber: z.string().min(1).optional().describe("Newegg item number."),
    sellerPartNumber: z.string().min(1).max(40).optional().describe("Seller SKU."),
    tiers: z
      .array(tierInputSchema)
      .min(1)
      .max(3)
      .describe("1-3 tiers, tier 1 first. Replaces the item's whole current discount."),
  })
  .refine((item) => item.neweggItemNumber !== undefined || item.sellerPartNumber !== undefined, {
    message: "Provide neweggItemNumber or sellerPartNumber.",
  })
  .describe("The volume discount to set on one item.");

function makeInputSchema(maxItems: number) {
  return z
    .strictObject({
      items: z
        .array(updateItemSchema)
        .min(1)
        .max(maxItems)
        .describe(`1-${maxItems} items whose volume discount to set.`),
    })
    .describe("Volume discounts to validate and plan (nothing is changed here).");
}

type PreviewInputSchema = ReturnType<typeof makeInputSchema>;
type PreviewInput = z.infer<PreviewInputSchema>;

// ---------------------------------------------------------------------------
// output schema (permissive; fields are mode-dependent)
// ---------------------------------------------------------------------------
const normalizedTierSchema = z.object({
  priority: z.number().int(),
  quantity: z.number().int(),
  sellingPrice: z.number(),
  freeShipping: z.boolean(),
});

const normalizedItemSchema = z.object({
  inputIndex: z.number().int(),
  neweggItemNumber: z.string().optional(),
  sellerPartNumber: z.string().optional(),
  tiers: z.array(normalizedTierSchema),
});

const feedJobSchema = z.object({
  requestId: z.string(),
  requestType: z.string(),
  status: feedRequestStatusSchema,
  itemCount: z.number().int(),
  chunkIndex: z.number().int(),
});

const itemAssignmentSchema = z.object({
  inputIndex: z.number().int(),
  requestId: z.string(),
  chunkIndex: z.number().int(),
});

const operationResultSchema = z.object({
  marketplace: marketplaceSchema,
  mode: z.enum(["preview", "apply"]),
  itemCount: z.number().int().optional(),
  chunkCount: z.number().int().optional(),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
  items: z.array(normalizedItemSchema).optional(),
  feedJobs: z.array(feedJobSchema).optional(),
  itemAssignments: z.array(itemAssignmentSchema).optional(),
  warnings: z.array(z.string()),
  rateLimit: rateLimitOutputSchema.optional(),
});

// ---------------------------------------------------------------------------
// newegg_volume_discount_preview_update
// ---------------------------------------------------------------------------
async function previewHandler(input: PreviewInput, ctx: ToolContext): Promise<ToolResult> {
  const { limits } = ctx.config;

  let preview;
  try {
    preview = ctx.client.volumeDiscounts.previewUpdate(input.items);
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const createdAt = ctx.now();
  const expiresAt = new Date(createdAt.getTime() + limits.previewTtlSeconds * 1000);
  const previewId = randomBytes(32).toString("base64url");

  const record: VolumeDiscountPreviewRecord = {
    previewId,
    kind: "volumeDiscountUpdate",
    hash: hashItemsPreview(
      sealFor(ctx, previewId, expiresAt),
      "volumeDiscountUpdate",
      preview.marketplace,
      preview.items,
    ),
    marketplace: preview.marketplace,
    items: preview.items,
    createdAt,
    expiresAt,
  };
  await ctx.previewStore.put(record);

  const warnings = [
    ...preview.warnings,
    "Apply submits an asynchronous data feed; poll newegg_feed_status / newegg_feed_result.",
  ];

  return okResult({
    marketplace: preview.marketplace,
    mode: "preview",
    itemCount: preview.itemCount,
    chunkCount: preview.chunkCount,
    previewId,
    previewExpiresAt: expiresAt.toISOString(),
    items: preview.items,
    warnings,
  });
}

export function createVolumeDiscountPreviewTool(
  config: McpServerConfig,
): ToolDefinition<PreviewInputSchema, typeof operationResultSchema> {
  return {
    name: TOOL_NAMES.volumeDiscountPreviewUpdate,
    title: "Preview a volume discount update",
    description:
      "Validate and plan setting the quantity-tier volume discount (1-3 tiers of minimum quantity, " +
      "per-unit price and free-shipping flag) on existing items. Quantities must strictly ascend " +
      "and prices strictly descend. Each item's tiers REPLACE its whole current discount. " +
      "Returns the normalized tiers and a single-use previewId; nothing is changed here. Only the " +
      "Canadian marketplace supports the update.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: makeInputSchema(config.limits.maxItemsPerOperation),
    outputSchema: operationResultSchema,
    handler: previewHandler,
  };
}

// ---------------------------------------------------------------------------
// newegg_volume_discount_apply_update
// ---------------------------------------------------------------------------
const applyInputSchema = z
  .strictObject({
    previewId: z
      .string()
      .min(1)
      .describe("The single-use previewId returned by newegg_volume_discount_preview_update."),
  })
  .describe("The previewId to apply. Discount tiers cannot be supplied here.");

async function applyHandler(
  input: z.infer<typeof applyInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, input.previewId, "volumeDiscountUpdate");
  if ("error" in outcome) {
    return outcome.error;
  }

  const record = outcome.record;
  try {
    // The SDK round-trips its own normalized output (strips inputIndex/priority internally).
    const submission = await ctx.client.volumeDiscounts.update(record.items);

    const warnings = [...submission.warnings];
    if (submission.feeds.length > 0) {
      warnings.push(
        "Feed accepted; poll newegg_feed_status with the requestId(s) and fetch " +
          "newegg_feed_result once FINISHED.",
      );
    }

    return okResult({
      marketplace: record.marketplace,
      mode: "apply",
      previewId: record.previewId,
      feedJobs: submission.feeds.map((feed) => ({
        requestId: feed.requestId,
        requestType: feed.requestType,
        status: feed.status,
        itemCount: feed.itemCount,
        chunkIndex: feed.chunkIndex,
      })),
      itemAssignments: submission.itemAssignments,
      warnings,
      rateLimit: serializeRateLimit(submission.rateLimit),
    });
  } catch (error) {
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}

export const volumeDiscountApplyTool: ToolDefinition<
  typeof applyInputSchema,
  typeof operationResultSchema
> = {
  name: TOOL_NAMES.volumeDiscountApplyUpdate,
  title: "Apply a previewed volume discount update",
  description:
    "Set exactly the volume discounts captured by a previewId from " +
    "newegg_volume_discount_preview_update. Accepts only the previewId — tiers cannot be changed at " +
    "apply time. The preview is single-use and consumed atomically (replays and expired previews " +
    "are rejected). Submits the VOLUME_DISCOUNT_DATA data feed and returns feed jobs to poll with " +
    "newegg_feed_status / newegg_feed_result. This tool exists only when the server is started " +
    "with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyInputSchema,
  outputSchema: operationResultSchema,
  handler: applyHandler,
};
