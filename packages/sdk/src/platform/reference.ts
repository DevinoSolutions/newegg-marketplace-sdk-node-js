/**
 * Per-marketplace differences of the seller / category reference reads (contracts §19). The
 * three platforms share paths, verbs and OperationTypes; what differs is the `version` query of
 * Seller Status Check (Newegg.com only) and the international Get Subcategory Status variant
 * (Newegg.com only). Keeping that here (ADR 0002) means the API layer has no per-marketplace
 * `if`s.
 */
import type { NeweggMarketplace } from "../types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";
import {
  SUBCATEGORY_STATUS_INTERNATIONAL_PATH,
  SUBCATEGORY_STATUS_PATH,
} from "../reference/constants.js";

export interface ReferencePlatform {
  readonly marketplace: NeweggMarketplace;
  /** Query params of Seller Status Check besides `sellerid` (`version=307` is Newegg.com only). */
  readonly sellerStatusQuery: Record<string, string> | undefined;
  /** Whether Get Subcategory Status for International Country exists on this platform. */
  readonly supportsInternationalSubcategories: boolean;
}

const usReference: ReferencePlatform = {
  marketplace: "us",
  sellerStatusQuery: { version: "307" },
  supportsInternationalSubcategories: true,
};

const b2bReference: ReferencePlatform = {
  marketplace: "b2b",
  sellerStatusQuery: undefined,
  supportsInternationalSubcategories: false,
};

const caReference: ReferencePlatform = {
  marketplace: "ca",
  sellerStatusQuery: undefined,
  supportsInternationalSubcategories: false,
};

/** Returns the reference-read platform data for a marketplace. */
export function getReferencePlatform(marketplace: NeweggMarketplace): ReferencePlatform {
  switch (marketplace) {
    case "us":
      return usReference;
    case "b2b":
      return b2bReference;
    case "ca":
      return caReference;
  }
}

/**
 * Path (after the platform prefix) of Get Subcategory Status. A `countryCode` selects the
 * international variant, which only Newegg.com has: B2B/CAN throw rather than silently
 * answering for the seller's home country.
 */
export function subcategoryStatusPath(
  platform: ReferencePlatform,
  countryCode: string | undefined,
): string {
  if (countryCode === undefined) return SUBCATEGORY_STATUS_PATH;
  if (!platform.supportsInternationalSubcategories) {
    throw new UnsupportedMarketplaceOperationError(
      `Get Subcategory Status for International Country is Newegg.com only; ` +
        `"countryCode" is not supported on the ${platform.marketplace} marketplace.`,
    );
  }
  return SUBCATEGORY_STATUS_INTERNATIONAL_PATH;
}
