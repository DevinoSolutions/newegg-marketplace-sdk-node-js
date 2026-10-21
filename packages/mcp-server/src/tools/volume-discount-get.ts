/**
 * `newegg_volume_discount_get` — read the quantity-tier volume discount configured for one item via
 * the SDK's read-only `volumeDiscounts.tryGet` (Get Volume Discount; contracts §22.1). Never
 * returns the SDK `raw` payload and never mutates anything.
 */
import { z } from "zod";
import type { GetVolumeDiscountInput } from "@devino/newegg-marketplace-sdk";
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
import { TOOL_NAMES } from "./names.js";

const inputSchema = z
  .strictObject({
    neweggItemNumber: z
      .string()
      .min(1)
      .optional()
      .describe("Newegg item number. Wins when both identifiers are given."),
    sellerPartNumber: z.string().min(1).max(40).optional().describe("Seller SKU."),
  })
  .refine((input) => input.neweggItemNumber !== undefined || input.sellerPartNumber !== undefined, {
    message: "Provide neweggItemNumber or sellerPartNumber.",
  })
  .describe("The single item whose volume discount to read.");

const tierSchema = z.object({
  // Newegg documents 1-3, but the SDK reads it with asNumber, which also yields "2.0" -> 2 and
  // "1.5" -> 1.5. A read must never fail on an echoed upstream value, so no .int() here
  // (the write path's normalized tiers, which WE generate, stay integers).
  priority: z.number(),
  quantity: z.number(),
  sellingPrice: z.number(),
  freeShipping: z.boolean(),
});

const outputSchema = z.object({
  marketplace: marketplaceSchema,
  neweggItemNumber: z.string().optional(),
  sellerPartNumber: z.string().optional(),
  hasVolumeDiscount: z.boolean(),
  tiers: z.array(tierSchema),
  correlationId: z.string().optional(),
  rateLimit: rateLimitOutputSchema.optional(),
  warnings: z.array(z.string()),
});

async function handler(input: z.infer<typeof inputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const getInput: GetVolumeDiscountInput = {};
  if (input.neweggItemNumber !== undefined) {
    getInput.neweggItemNumber = input.neweggItemNumber;
  }
  if (input.sellerPartNumber !== undefined) {
    getInput.sellerPartNumber = input.sellerPartNumber;
  }
  try {
    const snapshot = await ctx.client.volumeDiscounts.tryGet(getInput);
    if (snapshot === undefined) {
      return okResult({
        marketplace: ctx.client.marketplace,
        neweggItemNumber: input.neweggItemNumber,
        sellerPartNumber: input.sellerPartNumber,
        hasVolumeDiscount: false,
        tiers: [],
        warnings: ["Newegg reports no volume discount for this item (CT060)."],
      });
    }
    return okResult({
      marketplace: snapshot.marketplace,
      neweggItemNumber: snapshot.neweggItemNumber,
      sellerPartNumber: snapshot.sellerPartNumber,
      hasVolumeDiscount: snapshot.tiers.length > 0,
      tiers: snapshot.tiers.map((tier) => ({
        priority: tier.priority,
        quantity: tier.quantity,
        sellingPrice: tier.sellingPrice,
        freeShipping: tier.freeShipping,
      })),
      correlationId: snapshot.correlationId,
      rateLimit: serializeRateLimit(snapshot.rateLimit),
      warnings: [
        "A discount submitted through the feed can take several minutes to become readable.",
      ],
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const volumeDiscountGetTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: TOOL_NAMES.volumeDiscountGet,
  title: "Get an item's volume discount",
  description:
    "Read the quantity-tier volume discount (up to 3 tiers of minimum quantity, per-unit price and " +
    "free-shipping flag) configured for ONE item, by Newegg item number or seller part number. " +
    "An item without a discount returns hasVolumeDiscount=false and an empty tiers list. " +
    "Read-only: this never changes a discount.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema,
  outputSchema,
  handler,
};
