import { z } from "zod";

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

export const submitInventoryFeedInputSchema = z.strictObject({
  items: z.array(inventoryUpdateSchema).min(1, "at least one item is required"),
});
