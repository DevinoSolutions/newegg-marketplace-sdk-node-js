import { z } from "zod";
import type { NormalizedVolumeDiscountUpdate, VolumeDiscountUpdateOrNormalized } from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import { parseOrThrow } from "../inventory/validate.js";
import {
  SELLER_PART_NUMBER_MAX_LENGTH,
  VOLUME_DISCOUNT_MAX_QUANTITY,
  VOLUME_DISCOUNT_MAX_SELLING_PRICE,
  VOLUME_DISCOUNT_MAX_TIERS,
  VOLUME_DISCOUNT_MIN_QUANTITY,
} from "./constants.js";

const roundToCent = (value: number): number => Math.round(value * 100) / 100;

const tierSchema = z.strictObject({
  quantity: z.number().int().min(VOLUME_DISCOUNT_MIN_QUANTITY).max(VOLUME_DISCOUNT_MAX_QUANTITY),
  sellingPrice: z.number().positive().finite().max(VOLUME_DISCOUNT_MAX_SELLING_PRICE),
  freeShipping: z.boolean().optional(),
});

const updateSchema = z
  .strictObject({
    neweggItemNumber: z.string().min(1).optional(),
    sellerPartNumber: z.string().min(1).max(SELLER_PART_NUMBER_MAX_LENGTH).optional(),
    tiers: z.array(tierSchema).min(1).max(VOLUME_DISCOUNT_MAX_TIERS),
  })
  .refine((v) => v.neweggItemNumber !== undefined || v.sellerPartNumber !== undefined, {
    message: "At least one identifier is required: neweggItemNumber or sellerPartNumber.",
  });

const updatesSchema = z.array(updateSchema).min(1);

/** Recovers a `VolumeDiscountUpdate` from a normalized item by dropping the `inputIndex` and tier
 * `priority` the strict schema would reject, so a preview's output round-trips. Genuine unknown
 * keys still fail. */
function stripNormalizedFields(item: VolumeDiscountUpdateOrNormalized): unknown {
  if (typeof item !== "object" || item === null) return item;
  const { inputIndex: _inputIndex, tiers, ...rest } = item as unknown as Record<string, unknown>;
  return {
    ...rest,
    tiers: Array.isArray(tiers)
      ? tiers.map((tier: unknown) => {
          if (typeof tier !== "object" || tier === null) return tier;
          const { priority: _priority, ...tierRest } = tier as Record<string, unknown>;
          return tierRest;
        })
      : tiers,
  };
}

/**
 * Validates and normalizes volume-discount updates (docs rules, contracts §22.2): 1-3 tiers,
 * quantities are integers >= 2 and strictly ascending, prices > 0 and strictly descending (after
 * rounding to the cent), at least one identifier, no duplicate item in one call.
 */
export function normalizeVolumeDiscountUpdates(
  inputs: VolumeDiscountUpdateOrNormalized[],
): NormalizedVolumeDiscountUpdate[] {
  const parsed = parseOrThrow(
    updatesSchema,
    inputs.map(stripNormalizedFields),
    "volumeDiscounts.update input validation failed.",
  );
  const issues: NeweggValidationIssue[] = [];
  const seen = new Map<string, number>();
  parsed.forEach((item, index) => {
    item.tiers.forEach((tier, t) => {
      if (t === 0) return;
      const previous = item.tiers[t - 1];
      if (previous === undefined) return;
      if (tier.quantity <= previous.quantity) {
        issues.push({
          path: `[${index}].tiers.${t}.quantity`,
          message: `Tier quantities must be strictly ascending (${tier.quantity} <= ${previous.quantity}).`,
          inputIndex: index,
        });
      }
      if (roundToCent(tier.sellingPrice) >= roundToCent(previous.sellingPrice)) {
        issues.push({
          path: `[${index}].tiers.${t}.sellingPrice`,
          message: `Tier prices must be strictly descending (${tier.sellingPrice} >= ${previous.sellingPrice}).`,
          inputIndex: index,
        });
      }
    });
    for (const key of [
      item.neweggItemNumber === undefined ? undefined : `n:${item.neweggItemNumber.toUpperCase()}`,
      item.sellerPartNumber === undefined ? undefined : `s:${item.sellerPartNumber.toUpperCase()}`,
    ]) {
      if (key === undefined) continue;
      const first = seen.get(key);
      if (first !== undefined && first !== index) {
        issues.push({
          path: `[${index}]`,
          message: `Duplicate item (first occurrence at index ${first}).`,
          inputIndex: index,
        });
      } else {
        seen.set(key, index);
      }
    }
  });
  if (issues.length > 0) {
    throw new NeweggValidationError("Invalid volume-discount input.", issues);
  }
  return parsed.map((item, inputIndex) => {
    const out: NormalizedVolumeDiscountUpdate = {
      inputIndex,
      tiers: item.tiers.map((tier, t) => ({
        priority: t + 1,
        quantity: tier.quantity,
        sellingPrice: roundToCent(tier.sellingPrice),
        freeShipping: tier.freeShipping ?? false,
      })),
    };
    if (item.neweggItemNumber !== undefined) out.neweggItemNumber = item.neweggItemNumber;
    if (item.sellerPartNumber !== undefined) out.sellerPartNumber = item.sellerPartNumber;
    return out;
  });
}

/** Non-blocking notes about rules only Newegg can check, shared by preview and update. */
export function volumeDiscountWarnings(items: NormalizedVolumeDiscountUpdate[]): string[] {
  const warnings = [
    "Each item's whole volume discount is replaced by the tiers given; a tier price must be below " +
      "the item's current selling price (Newegg rejects it with CT062 otherwise) and the first " +
      "tier quantity must not be below the item's minimum purchase quantity (CT058).",
    "An active Newegg promotion priced below tier 1 disables the volume discount for shoppers.",
  ];
  const odd = items.filter((item) =>
    item.tiers.some((tier, t) => {
      const previous = item.tiers[t - 1];
      return previous !== undefined && tier.freeShipping && !previous.freeShipping;
    }),
  ).length;
  if (odd > 0) {
    warnings.push(
      `${odd} item(s) turn free shipping on at a higher tier after a lower tier without it; the ` +
        "docs state the shipping value must satisfy tier-1 >= tier-2 >= tier-3 (0 default, 1 " +
        "free), so Newegg may reject these (CT063).",
    );
  }
  return warnings;
}
