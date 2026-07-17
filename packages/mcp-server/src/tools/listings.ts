/**
 * The gated preview/apply pair for existing-item listing creation (contracts §13), mirroring the
 * inventory preview/apply flow (ADR 0005). `newegg_listing_preview_create` validates, normalizes,
 * chunks, and plans the creation offline (zero network), stores the normalized items under a
 * cryptographically random previewId, and returns the plan. `newegg_listing_apply_create`
 * atomically consumes that previewId and submits the ITEM_DATA&v2 data feed — it registers only
 * when writes are enabled.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { CreateListingInput, NormalizedCreateListing } from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type { ListingPreviewRecord } from "../preview-store/index.js";
import {
  businessError,
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
import { feedRequestStatusSchema } from "./operation-result.js";
import { TOOL_NAMES } from "./names.js";

// ---------------------------------------------------------------------------
// input schema (mirrors the SDK's CreateListingInput; identifiers required)
// ---------------------------------------------------------------------------
const createListingItemSchema = z
  .strictObject({
    sellerPartNumber: z
      .string()
      .min(1)
      .max(40)
      .describe("Seller SKU (<=40 chars, immutable once created)."),
    manufacturer: z
      .string()
      .min(1)
      .describe(
        "Manufacturer/brand name — must match Newegg's canonical name; carry it from a " +
          "newegg_catalog_resolve match.",
      ),
    neweggItemNumber: z
      .string()
      .min(1)
      .optional()
      .describe("Newegg catalog item number (from newegg_catalog_resolve)."),
    upc: z.string().min(1).max(40).optional().describe("UPC/EAN/GTIN identifying the catalog item."),
    manufacturerPartNumber: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Manufacturer part number (MPN)."),
    sellingPrice: z.number().positive().finite().describe("Seller price for this offer."),
    quantity: z
      .number()
      .int()
      .min(0)
      .describe("Available quantity for the default warehouse."),
    condition: z
      .enum(["New", "Refurbished"])
      .optional()
      .describe("Default New. CA supports only New/Refurbished. Immutable once created."),
    packsOrSets: z.number().int().min(1).optional().describe("Default 1. Immutable once created."),
    shipping: z
      .enum(["Default", "Free"])
      .optional()
      .describe("Default 'Default' (seller-portal shipping settings)."),
    activate: z
      .boolean()
      .optional()
      .describe(
        "Default false — offers are created DEACTIVATED and not for sale until explicitly " +
          "activated.",
      ),
    currency: z.enum(["USD", "CAD"]).optional().describe("Price currency."),
    msrp: z.number().positive().finite().optional().describe("Manufacturer suggested retail price."),
    map: z.number().min(0).finite().optional().describe("Minimum advertised price."),
    checkoutMap: z.boolean().optional().describe("Enforce MAP at checkout."),
    countryOfOrigin: z.string().length(3).optional().describe("ISO 3166-1 alpha-3 country code."),
    leadTime: z
      .number()
      .int()
      .min(1)
      .max(14)
      .optional()
      .describe("Handling time in business days (1-14); Newegg defaults to 2."),
    shippingTemplate: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Named seller shipping template to apply."),
  })
  .refine(
    (item) =>
      item.neweggItemNumber !== undefined ||
      item.upc !== undefined ||
      item.manufacturerPartNumber !== undefined,
    {
      message:
        "At least one catalog identifier is required: neweggItemNumber, upc, or " +
        "manufacturerPartNumber. Use newegg_catalog_resolve to obtain a NeweggItemNumber.",
    },
  )
  .describe("A single existing-item offer to create.");

function makeInputSchema(maxItems: number) {
  return z
    .strictObject({
      items: z
        .array(createListingItemSchema)
        .min(1)
        .max(maxItems)
        .describe(`1-${maxItems} existing-item offers to plan.`),
    })
    .describe("Existing-item offers to validate and plan (no listing is created here).");
}

type PreviewInputSchema = ReturnType<typeof makeInputSchema>;
type PreviewInput = z.infer<PreviewInputSchema>;

// ---------------------------------------------------------------------------
// output schema (permissive; fields are mode-dependent)
// ---------------------------------------------------------------------------
const listingItemOutputSchema = z
  .object({
    inputIndex: z.number().int(),
    sellerPartNumber: z.string(),
    manufacturer: z.string(),
    neweggItemNumber: z.string().optional(),
    upc: z.string().optional(),
    manufacturerPartNumber: z.string().optional(),
    sellingPrice: z.number(),
    quantity: z.number().int(),
    condition: z.enum(["New", "Refurbished"]),
    packsOrSets: z.number().int(),
    shipping: z.enum(["Default", "Free"]),
    activate: z.boolean(),
    currency: z.enum(["USD", "CAD"]).optional(),
    msrp: z.number().optional(),
    map: z.number().optional(),
    checkoutMap: z.boolean().optional(),
    countryOfOrigin: z.string().optional(),
    leadTime: z.number().int().optional(),
    shippingTemplate: z.string().optional(),
  })
  .loose();

const listingFeedJobSchema = z.object({
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

const listingOperationResultSchema = z.object({
  marketplace: marketplaceSchema,
  mode: z.enum(["preview", "apply"]),
  itemCount: z.number().int().optional(),
  chunkCount: z.number().int().optional(),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
  items: z.array(listingItemOutputSchema).optional(),
  feedJobs: z.array(listingFeedJobSchema).optional(),
  itemAssignments: z.array(itemAssignmentSchema).optional(),
  warnings: z.array(z.string()),
  rateLimit: rateLimitOutputSchema.optional(),
});

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------
function hashPayload(marketplace: string, items: NormalizedCreateListing[]): string {
  const canonical = JSON.stringify({ marketplace, items });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The SDK's strict create-validator rejects the `inputIndex` that normalization adds; drop it to
 * recover the `CreateListingInput` the feed submission re-validates and submits. */
function toCreateInput(item: NormalizedCreateListing): CreateListingInput {
  const { inputIndex: _inputIndex, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// newegg_listing_preview_create
// ---------------------------------------------------------------------------
async function previewHandler(input: PreviewInput, ctx: ToolContext): Promise<ToolResult> {
  const { limits } = ctx.config;

  let preview;
  try {
    preview = ctx.client.listings.previewCreate(input.items);
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const createdAt = ctx.now();
  const expiresAt = new Date(createdAt.getTime() + limits.previewTtlSeconds * 1000);
  const previewId = randomBytes(32).toString("base64url");

  const record: ListingPreviewRecord = {
    previewId,
    kind: "listingCreate",
    hash: hashPayload(preview.marketplace, preview.items),
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

export function createListingPreviewTool(
  config: McpServerConfig,
): ToolDefinition<PreviewInputSchema, typeof listingOperationResultSchema> {
  return {
    name: TOOL_NAMES.listingPreviewCreate,
    title: "Preview a listing creation",
    description:
      "Validate and plan the creation of seller offers on products that ALREADY EXIST in Newegg's " +
      "catalog (existing-item creation feed). Requires the Newegg catalog item identifiers — use " +
      "newegg_catalog_resolve first to turn a UPC or manufacturer+MPN into a NeweggItemNumber and " +
      "canonical manufacturer name. Returns a single-use previewId; nothing is created here.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: makeInputSchema(config.limits.maxItemsPerOperation),
    outputSchema: listingOperationResultSchema,
    handler: previewHandler,
  };
}

// ---------------------------------------------------------------------------
// newegg_listing_apply_create
// ---------------------------------------------------------------------------
const applyInputSchema = z
  .strictObject({
    previewId: z
      .string()
      .min(1)
      .describe("The single-use previewId returned by newegg_listing_preview_create."),
  })
  .describe("The previewId to apply. Listing details cannot be supplied here.");

const CONSUME_ERRORS: Record<
  "not_found" | "expired" | "already_used",
  { code: string; message: string }
> = {
  not_found: {
    code: "preview_not_found",
    message:
      "No preview matches that previewId. It may never have existed, was already consumed and " +
      "evicted, or the server restarted. Create a new preview and apply it.",
  },
  expired: {
    code: "preview_expired",
    message: "This preview has expired. Create a new preview and apply it within the TTL.",
  },
  already_used: {
    code: "preview_already_used",
    message: "This preview was already applied. Previews are single-use; create a new preview.",
  },
};

async function applyHandler(
  input: z.infer<typeof applyInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const consumed = await ctx.previewStore.consume(input.previewId);
  if (consumed.status !== "ok") {
    const mapped = CONSUME_ERRORS[consumed.status];
    return errorResult(businessError(mapped.code, mapped.message));
  }

  const record = consumed.record;
  if (record.kind !== "listingCreate") {
    return errorResult(
      businessError(
        "preview_kind_mismatch",
        "This previewId belongs to a different operation type; apply it with its matching tool.",
      ),
    );
  }

  try {
    const submission = await ctx.client.listings.create(record.items.map(toCreateInput));

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
    const payload = mapErrorToPayload(error, ctx.logger);
    payload.message = `${payload.message} The preview has been consumed and cannot be reused; create a new preview to retry.`;
    return errorResult(payload);
  }
}

export const listingApplyTool: ToolDefinition<
  typeof applyInputSchema,
  typeof listingOperationResultSchema
> = {
  name: TOOL_NAMES.listingApplyCreate,
  title: "Apply a previewed listing creation",
  description:
    "Create exactly the seller offers captured by a previewId from newegg_listing_preview_create. " +
    "Accepts only the previewId — listing details cannot be changed at apply time. The preview is " +
    "single-use and consumed atomically (replays and expired previews are rejected). Submits the " +
    "existing-item creation data feed and returns feed jobs to poll with newegg_feed_status / " +
    "newegg_feed_result. This tool exists only when the server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyInputSchema,
  outputSchema: listingOperationResultSchema,
  handler: applyHandler,
};
