/**
 * `newegg_inventory_get` — read current inventory for up to 100 identifiers. Read-only; never
 * returns SDK `raw` payloads (fields are mapped explicitly).
 */
import { z } from "zod";
import type { GetManyInput } from "@devino/newegg-marketplace-sdk";
import {
  conditionOf,
  conditionSchema,
  errorResult,
  identifierInputSchema,
  identifierOutputSchema,
  marketplaceSchema,
  mapErrorToPayload,
  okResult,
  rateLimitOutputSchema,
  serializeRateLimit,
  toItemIdentifier,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { TOOL_NAMES } from "./names.js";

const inputSchema = z
  .strictObject({
    identifiers: z
      .array(identifierInputSchema)
      .min(1)
      .max(100)
      .describe("1-100 item identifiers to look up."),
    warehouses: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional warehouse filter (US marketplace only; ignored elsewhere)."),
  })
  .describe("Identifiers (and optional US warehouse filter) to read inventory for.");

const warehouseSchema = z.object({
  location: z.string(),
  quantity: z.number(),
  fulfillment: z.enum(["seller", "newegg"]),
});

const itemSchema = z.object({
  itemNumber: z.string().optional(),
  sellerPartNumber: z.string().optional(),
  condition: conditionSchema.optional(),
  active: z.boolean().optional(),
  totalAvailableQuantity: z.number(),
  warehouses: z.array(warehouseSchema),
});

const outputSchema = z.object({
  marketplace: marketplaceSchema,
  items: z.array(itemSchema),
  missingIdentifiers: z.array(identifierOutputSchema),
  totalCount: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function handler(input: z.infer<typeof inputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const getInput: GetManyInput = { identifiers: input.identifiers.map(toItemIdentifier) };
  if (input.warehouses !== undefined) {
    getInput.warehouses = input.warehouses;
  }
  try {
    const batch = await ctx.client.inventory.getMany(getInput);
    return okResult({
      marketplace: batch.marketplace,
      items: batch.items.map((item) => ({
        itemNumber: item.itemNumber,
        sellerPartNumber: item.sellerPartNumber,
        condition: item.condition,
        active: item.active,
        totalAvailableQuantity: item.totalAvailableQuantity,
        warehouses: item.warehouses.map((warehouse) => ({
          location: warehouse.location,
          quantity: warehouse.quantity,
          fulfillment: warehouse.fulfillment,
        })),
      })),
      missingIdentifiers: batch.missingIdentifiers.map((identifier) => ({
        type: identifier.type,
        value: identifier.value,
        condition: conditionOf(identifier),
      })),
      totalCount: batch.totalCount,
      correlationId: batch.correlationId,
      rateLimit: serializeRateLimit(batch.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const inventoryGetTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: TOOL_NAMES.inventoryGet,
  title: "Get Newegg inventory",
  description:
    "Read current Newegg Marketplace inventory for up to 100 items by seller part number, " +
    "Newegg item number, or UPC. Returns per-warehouse available quantities, fulfillment " +
    "channel, and (for B2B/CA) the active flag, plus any identifiers Newegg did not return. " +
    "Read-only: this never changes inventory.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema,
  outputSchema,
  handler,
};
