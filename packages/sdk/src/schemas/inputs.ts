import { z } from "zod";
import {
  GET_PRICE_MANY_MAX_IDENTIFIERS,
  PRICE_UPDATE_MAX_SELLING_PRICE,
} from "../pricing/constants.js";

/**
 * Zod v4 strict schemas for public inputs. Unknown keys are rejected (`strictObject`);
 * quantity is a non-negative safe integer (0 valid); `warehouseLocation`, when present, must
 * be an uppercase ISO 3166-1 alpha-3 code; `condition` is only meaningful on UPC identifiers.
 */

const itemConditionSchema = z.enum([
  "new",
  "refurbished",
  "usedLikeNew",
  "usedVeryGood",
  "usedGood",
  "usedAcceptable",
]);

const itemIdentifierSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("sellerPartNumber"),
    value: z
      .string()
      .min(1, "value must be non-empty")
      .max(40, "sellerPartNumber must be <= 40 characters"),
  }),
  z.strictObject({
    type: z.literal("neweggItemNumber"),
    value: z.string().min(1, "value must be non-empty"),
  }),
  z.strictObject({
    type: z.literal("upc"),
    value: z.string().min(1, "value must be non-empty"),
    condition: itemConditionSchema.optional(),
  }),
]);

const quantitySchema = z
  .number()
  .int("quantity must be an integer")
  .min(0, "quantity must be >= 0")
  .max(Number.MAX_SAFE_INTEGER, "quantity must be a safe integer");

const warehouseLocationSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "warehouseLocation must be an uppercase ISO 3166-1 alpha-3 code");

export const inventoryUpdateSchema = z
  .strictObject({
    identifier: itemIdentifierSchema,
    quantity: quantitySchema,
    warehouseLocation: warehouseLocationSchema.optional(),
    fulfillmentOption: z.literal("Seller").optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    // `inputIndex` is tolerated and stripped on intake so callers can round-trip
    // `previewUpdate(...).normalizedUpdates` (which carry `inputIndex`) straight back into
    // `updateMany`/`updateItem`/`submitInventoryFeed`. The SDK always re-derives the
    // authoritative index from the caller's array order, so any supplied value is ignored.
    // All OTHER unknown keys are still rejected (strictObject).
    inputIndex: z.number().int().optional(),
  })
  .transform(({ inputIndex: _inputIndex, ...update }) => update);

export const getItemInputSchema = z.strictObject({
  identifier: itemIdentifierSchema,
  warehouses: z.array(z.string()).optional(),
});

export const getManyInputSchema = z.strictObject({
  identifiers: z.array(itemIdentifierSchema),
  warehouses: z.array(z.string()).optional(),
});

const priceCountrySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "countries must be uppercase ISO 3166-1 alpha-3 codes");

export const getPriceInputSchema = z.strictObject({
  identifier: itemIdentifierSchema,
  countries: z.array(priceCountrySchema).min(1, "countries must not be empty").optional(),
});

export const getPriceManyInputSchema = z.strictObject({
  identifiers: z
    .array(itemIdentifierSchema)
    .min(1, "at least one identifier is required")
    .max(GET_PRICE_MANY_MAX_IDENTIFIERS, `at most ${GET_PRICE_MANY_MAX_IDENTIFIERS} identifiers`),
  countries: z.array(priceCountrySchema).min(1, "countries must not be empty").optional(),
});

/** Newegg accepts 0.00-99999.99 (CT007); a selling price can never be 0 (CT032). */
const sellingPriceSchema = z
  .number()
  .gt(0, "sellingPrice must be > 0")
  .max(PRICE_UPDATE_MAX_SELLING_PRICE, `sellingPrice must be <= ${PRICE_UPDATE_MAX_SELLING_PRICE}`)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    "sellingPrice must have at most 2 decimal places",
  );

export const priceUpdateSchema = z
  .strictObject({
    identifier: itemIdentifierSchema,
    sellingPrice: sellingPriceSchema,
    countryCode: priceCountrySchema.optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "currency must be an uppercase ISO 4217 code")
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    // Tolerated and stripped like `inventoryUpdateSchema.inputIndex`: previewUpdate output
    // round-trips straight back into update(); the authoritative index is re-derived.
    inputIndex: z.number().int().optional(),
  })
  .transform(({ inputIndex: _inputIndex, ...update }) => update);

export const submitInventoryFeedInputSchema = z.strictObject({
  items: z.array(inventoryUpdateSchema).min(1, "at least one item is required"),
});
