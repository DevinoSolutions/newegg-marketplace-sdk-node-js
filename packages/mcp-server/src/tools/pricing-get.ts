/**
 * `newegg_pricing_get` — read current selling price, MAP/MSRP, shipping flag, promotion locks
 * and activation state for up to 100 identifiers via the SDK's read-only `pricing.getMany`
 * (Get Item Price; contracts §15). Never returns SDK `raw` payloads (fields are mapped
 * explicitly) and never mutates anything.
 */
import { z } from "zod";
import type { GetPriceManyInput } from "@devino/newegg-marketplace-sdk";
import {
  conditionOf,
  errorResult,
  identifierInputSchema,
  identifierOutputSchema,
  mapErrorToPayload,
  marketplaceSchema,
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
    countries: z
      .array(z.string().regex(/^[A-Z]{3}$/, "uppercase ISO 3166-1 alpha-3 code"))
      .min(1)
      .optional()
      .describe("Optional destination-country filter, e.g. ['USA'] (US only; ignored elsewhere)."),
  })
  .describe("Identifiers (and optional US destination-country filter) to read prices for.");

const promotionSchema = z.enum([
  "priceLock",
  "promotionCode",
  "autoAddToCart",
  "combo",
  "volumeDiscount",
]);

const priceSchema = z.object({
  countryCode: z.string().optional(),
  currency: z.string().optional(),
  currencyInferred: z.boolean(),
  active: z.boolean().optional(),
  msrp: z.number().optional(),
  map: z.number().optional(),
  checkoutMap: z.boolean().optional(),
  sellingPrice: z.number().optional(),
  freeShipping: z.boolean().optional(),
  promotions: z.array(promotionSchema),
  limitQuantity: z.number().optional(),
});

const itemSchema = z.object({
  itemNumber: z.string().optional(),
  sellerPartNumber: z.string().optional(),
  shippedByNewegg: z.boolean().optional(),
  prices: z.array(priceSchema),
});

const failureSchema = z.object({
  identifier: identifierOutputSchema,
  errorCode: z.string().optional(),
  httpStatus: z.number().optional(),
  message: z.string(),
});

const outputSchema = z.object({
  marketplace: marketplaceSchema,
  items: z.array(itemSchema),
  missingIdentifiers: z.array(identifierOutputSchema),
  failures: z.array(failureSchema),
  totalCount: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function handler(input: z.infer<typeof inputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const getInput: GetPriceManyInput = { identifiers: input.identifiers.map(toItemIdentifier) };
  if (input.countries !== undefined) {
    getInput.countries = input.countries;
  }
  try {
    const batch = await ctx.client.pricing.getMany(getInput);
    return okResult({
      marketplace: batch.marketplace,
      items: batch.items.map((item) => ({
        itemNumber: item.itemNumber,
        sellerPartNumber: item.sellerPartNumber,
        shippedByNewegg: item.shippedByNewegg,
        prices: item.prices.map((price) => ({
          countryCode: price.countryCode,
          currency: price.currency,
          currencyInferred: price.currencyInferred,
          active: price.active,
          msrp: price.msrp,
          map: price.map,
          checkoutMap: price.checkoutMap,
          sellingPrice: price.sellingPrice,
          freeShipping: price.freeShipping,
          promotions: price.promotions,
          limitQuantity: price.limitQuantity,
        })),
      })),
      missingIdentifiers: batch.missingIdentifiers.map((identifier) => ({
        type: identifier.type,
        value: identifier.value,
        condition: conditionOf(identifier),
      })),
      failures: batch.failures.map((failure) => ({
        identifier: {
          type: failure.identifier.type,
          value: failure.identifier.value,
          condition: conditionOf(failure.identifier),
        },
        errorCode: failure.errorCode,
        httpStatus: failure.httpStatus,
        message: failure.message,
      })),
      totalCount: batch.totalCount,
      correlationId: batch.correlationId,
      rateLimit: serializeRateLimit(batch.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const pricingGetTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: TOOL_NAMES.pricingGet,
  title: "Get Newegg item prices",
  description:
    "Read current Newegg Marketplace prices for up to 100 items by seller part number, " +
    "Newegg item number, or UPC. Returns per item the selling price, MSRP, MAP and checkout-MAP " +
    "flag, free-shipping flag, active flag, per-customer purchase limit and any active promotion " +
    "locks (a locked item cannot be repriced); the US marketplace returns one price per " +
    "destination country with its currency, while B2B/CA return a single price whose currency " +
    "is inferred from the marketplace (currencyInferred=true). Identifiers Newegg does not know " +
    "are listed in missingIdentifiers and other per-item errors in failures. Each identifier " +
    "costs one read request against Newegg's 10,000/hour budget. Read-only: this never changes " +
    "a price.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema,
  outputSchema,
  handler,
};
