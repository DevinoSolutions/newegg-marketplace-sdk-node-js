/**
 * `newegg_inventory_preview_update` — the read-only first half of the ADR 0005 write flow.
 * It validates and enforces server-side policies (max items, zero-quantity ban, warehouse
 * allowlist), asks the SDK to normalize/dedupe/plan the operation WITHOUT mutating Newegg,
 * stores the normalized operation under a cryptographically random previewId, and returns the
 * plan (including a prominent zero-quantity warning) for a human/model to review before apply.
 *
 * The input array's max length is bound to the configured max-items limit at registration time,
 * so an oversized request is rejected by the tool's own input schema.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  InventoryUpdate,
  InventoryUpdateStrategy,
  NormalizedInventoryUpdate,
} from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type { PreviewRecord } from "../preview-store/index.js";
import {
  businessError,
  errorResult,
  identifierInputSchema,
  mapErrorToPayload,
  okResult,
  toItemIdentifier,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { inventoryOperationResultSchema } from "./operation-result.js";
import { TOOL_NAMES } from "./names.js";

const updateSchema = z
  .strictObject({
    identifier: identifierInputSchema,
    quantity: z
      .number()
      .int()
      .min(0)
      .describe("New non-negative available quantity (0 zeroes it out)."),
    warehouseLocation: z
      .string()
      .min(1)
      .optional()
      .describe("Warehouse/region code (ISO alpha-3 for US; required for US ops)."),
    fulfillmentOption: z.literal("Seller").optional().describe('Only "Seller" is supported.'),
  })
  .describe("A single inventory update.");

function makeInputSchema(maxItems: number) {
  return z
    .strictObject({
      updates: z
        .array(updateSchema)
        .min(1)
        .max(maxItems)
        .describe(`1-${maxItems} inventory updates to plan.`),
      strategy: z
        .enum(["direct", "feed", "auto"])
        .optional()
        .describe(
          "Submission strategy; defaults to auto (direct for small batches, feed for large).",
        ),
      includeCurrentInventory: z
        .boolean()
        .optional()
        .describe("Also read current inventory for the identifiers (still performs zero writes)."),
    })
    .describe("Inventory updates to validate and plan (no writes happen here).");
}

type PreviewInputSchema = ReturnType<typeof makeInputSchema>;
type PreviewInput = z.infer<PreviewInputSchema>;

function canonicalUpdate(update: NormalizedInventoryUpdate): Record<string, unknown> {
  return {
    inputIndex: update.inputIndex,
    type: update.identifier.type,
    value: update.identifier.value,
    condition: update.identifier.type === "upc" ? (update.identifier.condition ?? null) : null,
    quantity: update.quantity,
    warehouseLocation: update.warehouseLocation ?? null,
    fulfillmentOption: update.fulfillmentOption ?? null,
  };
}

function hashPayload(
  marketplace: string,
  strategy: InventoryUpdateStrategy,
  updates: NormalizedInventoryUpdate[],
): string {
  const canonical = JSON.stringify({
    marketplace,
    strategy,
    updates: updates.map(canonicalUpdate),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function handler(input: PreviewInput, ctx: ToolContext): Promise<ToolResult> {
  const { limits } = ctx.config;

  // Policy enforcement BEFORE any SDK call, reported against the caller's input indexes.
  const zeroIndexes = input.updates
    .map((update, index) => (update.quantity === 0 ? index : -1))
    .filter((index) => index >= 0);
  if (!limits.allowZeroQuantity && zeroIndexes.length > 0) {
    return errorResult(
      businessError(
        "zero_quantity_not_allowed",
        `Zero-quantity updates are disabled (NEWEGG_MCP_ALLOW_ZERO_QUANTITY=false). ` +
          `Offending input index(es): ${zeroIndexes.join(", ")}.`,
      ),
    );
  }

  if (limits.allowedWarehouses.length > 0) {
    const allowed = new Set(limits.allowedWarehouses);
    const offending = input.updates
      .map((update, index) => ({ update, index }))
      .filter(
        ({ update }) =>
          update.warehouseLocation !== undefined &&
          !allowed.has(update.warehouseLocation.toUpperCase()),
      );
    if (offending.length > 0) {
      return errorResult(
        businessError(
          "warehouse_not_allowed",
          `One or more updates target warehouses outside the allowlist ` +
            `(${limits.allowedWarehouses.join(", ")}). Offending input index(es): ` +
            `${offending.map(({ index }) => index).join(", ")}.`,
        ),
      );
    }
  }

  const updates: InventoryUpdate[] = input.updates.map((update) => {
    const mapped: InventoryUpdate = {
      identifier: toItemIdentifier(update.identifier),
      quantity: update.quantity,
    };
    if (update.warehouseLocation !== undefined) {
      mapped.warehouseLocation = update.warehouseLocation;
    }
    if (update.fulfillmentOption !== undefined) {
      mapped.fulfillmentOption = update.fulfillmentOption;
    }
    return mapped;
  });

  const requestedStrategy: InventoryUpdateStrategy = input.strategy ?? "auto";

  let preview;
  try {
    preview = await ctx.client.inventory.previewUpdate(updates, {
      strategy: requestedStrategy,
      includeCurrentInventory: input.includeCurrentInventory ?? false,
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const deduplicatedItemCount = preview.deduplicated.reduce(
    (total, entry) => total + entry.droppedInputIndexes.length,
    0,
  );

  const warnings: string[] = [];
  if (zeroIndexes.length > 0) {
    warnings.push(
      `${zeroIndexes.length} update(s) set quantity to 0, which removes availability. ` +
        `Input index(es): ${zeroIndexes.join(", ")}.`,
    );
  }
  if (preview.plannedFeedCount > 0) {
    warnings.push(
      `This operation will be submitted asynchronously via ${preview.plannedFeedCount} data ` +
        `feed(s). After apply, poll newegg_feed_status and fetch newegg_feed_result.`,
    );
  }
  if (deduplicatedItemCount > 0) {
    warnings.push(`${deduplicatedItemCount} duplicate update(s) were removed (last-write-wins).`);
  }
  warnings.push(...preview.warnings);

  const createdAt = ctx.now();
  const expiresAt = new Date(createdAt.getTime() + limits.previewTtlSeconds * 1000);
  const previewId = randomBytes(32).toString("base64url");

  const record: PreviewRecord = {
    previewId,
    kind: "inventoryUpdate",
    hash: hashPayload(preview.marketplace, requestedStrategy, preview.normalizedUpdates),
    marketplace: preview.marketplace,
    strategy: requestedStrategy,
    normalizedUpdates: preview.normalizedUpdates,
    createdAt,
    expiresAt,
  };
  await ctx.previewStore.put(record);

  const items = preview.normalizedUpdates.map((update) => ({
    inputIndex: update.inputIndex,
    sellerPartNumber:
      update.identifier.type === "sellerPartNumber" ? update.identifier.value : undefined,
    warehouseLocation: update.warehouseLocation,
    quantity: update.quantity,
    status: "planned",
  }));

  return okResult({
    operationId: randomUUID(),
    correlationId: preview.correlationId,
    marketplace: preview.marketplace,
    mode: "preview",
    strategy: preview.strategy,
    submittedItemCount: preview.normalizedUpdates.length,
    acceptedItemCount: 0,
    failedItemCount: 0,
    deduplicatedItemCount,
    previewId,
    previewExpiresAt: expiresAt.toISOString(),
    items,
    warnings,
  });
}

export function createInventoryPreviewTool(
  config: McpServerConfig,
): ToolDefinition<PreviewInputSchema, typeof inventoryOperationResultSchema> {
  return {
    name: TOOL_NAMES.inventoryPreviewUpdate,
    title: "Preview an inventory update",
    description:
      "Validate, normalize, de-duplicate, and plan a Newegg inventory update WITHOUT changing " +
      "anything. Enforces server policies (max items, zero-quantity ban, warehouse allowlist), " +
      "decides direct-vs-feed submission, and surfaces a prominent warning for any zero-quantity " +
      "(zero-out) updates. Returns a single-use previewId (with an expiry) that " +
      "newegg_inventory_apply_update consumes to execute exactly this plan. No Newegg mutation " +
      "ever happens here.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: makeInputSchema(config.limits.maxItemsPerOperation),
    outputSchema: inventoryOperationResultSchema,
    handler,
  };
}
