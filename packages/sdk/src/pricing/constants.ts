/**
 * Pricing-operation constants (see `newegg-api-contracts.md` §15).
 */
import type { NeweggMarketplace } from "../types.js";

/**
 * Newegg error codes meaning "no such item for this seller" on a price read. Same evidence as
 * inventory reads (§5.2): CT026 for an unknown seller part / item number, CT010 for a UPC the
 * seller has no offer on. Get Item Price documents both (§15.1). `tryGet` and `getMany`
 * convert ONLY these; every other error still surfaces.
 */
export const PRICE_NOT_FOUND_ERROR_CODES: ReadonlySet<string> = new Set(["CT026", "CT010"]);

/**
 * Maximum identifiers per `getMany`. SDK policy, not a Newegg rule: every identifier costs one
 * read against the documented 10,000 requests/hour budget (§15.3), so a runaway list is
 * rejected instead of silently burning it.
 */
export const GET_PRICE_MANY_MAX_IDENTIFIERS = 100;

/** Default bounded concurrency for the per-item reads of `getMany`. */
export const DEFAULT_PRICE_READ_CONCURRENCY = 4;

/**
 * Currency inferred for B2B/CAN price records, whose Get Item Price response carries none.
 * Source: the Inventory And Price Feed (B2B and CAN) page's `Currency` field — default "CAD"
 * for Newegg.ca and "USD" for Neweggbusiness.com (contracts §15.2). A documented ASSUMPTION
 * that the direct read reports in the same currency; surfaced as `currencyInferred: true`.
 */
export const INFERRED_CURRENCY: Readonly<Partial<Record<NeweggMarketplace, string>>> = {
  b2b: "USD",
  ca: "CAD",
};
