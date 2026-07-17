import { z } from "zod";
import type { CreateListingInput, NormalizedCreateListing } from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import { parseOrThrow } from "../inventory/validate.js";
import { SELLER_PART_NUMBER_MAX_LENGTH } from "./constants.js";

const createListingSchema = z
  .strictObject({
    sellerPartNumber: z.string().min(1).max(SELLER_PART_NUMBER_MAX_LENGTH),
    manufacturer: z.string().min(1),
    neweggItemNumber: z.string().min(1).optional(),
    upc: z.string().min(1).max(40).optional(),
    manufacturerPartNumber: z.string().min(1).max(40).optional(),
    sellingPrice: z.number().positive().finite(),
    quantity: z.number().int().min(0),
    condition: z.enum(["New", "Refurbished"]).optional(),
    packsOrSets: z.number().int().min(1).optional(),
    shipping: z.enum(["Default", "Free"]).optional(),
    activate: z.boolean().optional(),
    currency: z.enum(["USD", "CAD"]).optional(),
    msrp: z.number().positive().finite().optional(),
    map: z.number().min(0).finite().optional(),
    checkoutMap: z.boolean().optional(),
    countryOfOrigin: z.string().length(3).optional(),
    leadTime: z.number().int().min(1).max(14).optional(),
    shippingTemplate: z.string().min(1).max(200).optional(),
  })
  .refine(
    (v) =>
      v.neweggItemNumber !== undefined ||
      v.upc !== undefined ||
      v.manufacturerPartNumber !== undefined,
    {
      message:
        "At least one identifier is required: neweggItemNumber, upc, or manufacturerPartNumber.",
    },
  );

const createListingsSchema = z.array(createListingSchema).min(1);

/** Validates and normalizes creation inputs (defaults: New / 1 / Default / deactivated). */
export function normalizeCreateListings(inputs: CreateListingInput[]): NormalizedCreateListing[] {
  const parsed = parseOrThrow(
    createListingsSchema,
    inputs,
    "listings.create input validation failed.",
  );
  const seen = new Map<string, number>();
  const duplicates: NeweggValidationIssue[] = [];
  parsed.forEach((item, index) => {
    const key = item.sellerPartNumber.toUpperCase();
    const first = seen.get(key);
    if (first !== undefined) {
      duplicates.push({
        path: `[${index}].sellerPartNumber`,
        message: `Duplicate sellerPartNumber (first occurrence at index ${first}).`,
        inputIndex: index,
      });
    } else {
      seen.set(key, index);
    }
  });
  if (duplicates.length > 0) {
    throw new NeweggValidationError(
      "Duplicate sellerPartNumber(s) in listing creation input.",
      duplicates,
    );
  }
  return parsed.map((item, inputIndex) => ({
    ...item,
    inputIndex,
    condition: item.condition ?? "New",
    packsOrSets: item.packsOrSets ?? 1,
    shipping: item.shipping ?? "Default",
    activate: item.activate ?? false,
  }));
}
