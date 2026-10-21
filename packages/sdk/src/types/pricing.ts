/** Item pricing read and write types (contracts §15, §16). Re-exported from `../types.ts`. */

import type { ItemIdentifier, NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// pricing reads (Get Item Price; contracts §15) — READ-only
// ----------------------------------------------------------------------------
/** Active promotion lock/type reported by `OnPromotion` (wire codes 1–5). */
export type PricePromotion =
  "priceLock" | "promotionCode" | "autoAddToCart" | "combo" | "volumeDiscount";

export interface GetPriceInput {
  identifier: ItemIdentifier;
  /**
   * US only: ISO 3166-1 alpha-3 destination countries to return prices for (e.g. `["USA"]`).
   * Omit for every country the item sells to. Ignored on B2B/CAN (single-market).
   */
  countries?: string[];
}

export interface GetPriceManyInput {
  /** 1–100 distinct identifiers are priced with one read request each (no wire batch; §15.3). */
  identifiers: ItemIdentifier[];
  /** US only; see {@link GetPriceInput.countries}. */
  countries?: string[];
}

export interface GetPriceManyOptions extends RequestOptions {
  /** Bounded parallelism of the per-item reads. Default 4. */
  concurrency?: number;
}

/** One price record: a US destination country, or the single B2B/CAN market. */
export interface PriceEntry {
  /** US only (ISO alpha-3). Absent on B2B/CAN. */
  countryCode?: string;
  /**
   * ISO 4217 code. US: as reported by Newegg per country. B2B/CAN responses carry no
   * currency, so it is inferred from the marketplace (USD for `b2b`, CAD for `ca`; the
   * documented default of the inventory-and-price feed) and `currencyInferred` is true.
   */
  currency?: string;
  currencyInferred: boolean;
  /** Whether the item is active (listed) in this country/market. */
  active?: boolean;
  /** Manufacturer's suggested retail price; documented but absent from the sample payloads. */
  msrp?: number;
  /** Minimum advertised price; 0 / absent means none. Ignored when `checkoutMap` is true. */
  map?: number;
  /** True: the price is shown only at checkout and `map` is ignored. */
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `EnableFreeShipping`: true = free shipping, false = the default shipping rule. */
  freeShipping?: boolean;
  promotions: PricePromotion[];
  /** Max units per customer per 48 hours (max 500). */
  limitQuantity?: number;
}

export interface ItemPriceSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  /** B2B/CAN only (`ShipByNewegg`). */
  shippedByNewegg?: boolean;
  /** US: one per destination country. B2B/CAN: exactly one, without `countryCode`. */
  prices: PriceEntry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Only when `includeRaw`. */
  raw?: unknown;
}

/** A per-identifier read failure inside a {@link PriceBatchSnapshot} (never secret-bearing). */
export interface PriceReadFailure {
  identifier: ItemIdentifier;
  errorCode?: string;
  httpStatus?: number;
  message: string;
}

export interface PriceBatchSnapshot {
  marketplace: NeweggMarketplace;
  /** Successful reads, in the order the (de-duplicated) identifiers were requested. */
  items: ItemPriceSnapshot[];
  bySellerPartNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  byItemNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  /** Identifiers Newegg reported as unknown to this seller (CT026 / CT010). */
  missingIdentifiers: ItemIdentifier[];
  /** Identifiers whose read failed for any other reason; the rest of the batch still returns. */
  failures: PriceReadFailure[];
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// pricing writes (contracts §16) — WRITE surface
// ----------------------------------------------------------------------------
/** One selling-price assignment. Only `SellingPrice` is ever sent — never MAP/MSRP/shipping/Active. */
export interface PriceUpdate {
  identifier: ItemIdentifier;
  /** New selling price: > 0, <= 99999.99, at most 2 decimal places. Absolute, not a delta. */
  sellingPrice: number;
  /** US only (required there): uppercase ISO 3166-1 alpha-3 destination country. Rejected on B2B/CA. */
  countryCode?: string;
  /** US only (required there): ISO 4217 code that must match the country (CT075 otherwise). Rejected on B2B/CA. */
  currency?: string;
  /** Caller bookkeeping, never sent to Newegg. */
  metadata?: Record<string, string>;
}

export interface NormalizedPriceUpdate extends PriceUpdate {
  /** Index in the caller's original array. */
  inputIndex: number;
}

export interface PreviewPriceOptions extends RequestOptions {
  /** Read each item's current price to compute the change and flag risks (reads only). Default true. */
  includeCurrentPrice?: boolean;
}

/** `blocked`: do not apply (see `blockers`). `warning`: applies, but read `warnings`. */
export type PriceChangeStatus = "ok" | "warning" | "blocked" | "unchecked";

export interface PriceChange {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  newSellingPrice: number;
  /** Currency the new price is read as: the update's (US) or the current one's / inferred one's. */
  currency?: string;
  currentSellingPrice?: number;
  /** Signed percent change vs the current price; undefined when the current price is 0/unknown. */
  changePercent?: number;
  active?: boolean;
  map?: number;
  msrp?: number;
  checkoutMap?: boolean;
  promotions: PricePromotion[];
  status: PriceChangeStatus;
  blockers: string[];
  warnings: string[];
}

export interface PriceUpdatePreview {
  marketplace: NeweggMarketplace;
  /** Post-validation, post-dedup (last-write-wins). Blocked items are still listed here. */
  normalizedUpdates: NormalizedPriceUpdate[];
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  /** One per normalized update, in the same order. */
  changes: PriceChange[];
  warnings: string[];
  correlationId: string;
}

export interface UpdatePricesOptions extends RequestOptions {
  /** Read each price back after the write and compare. Default true. */
  verify?: boolean;
  /** Bounded parallelism of the per-item writes. Default 2. */
  concurrency?: number;
}

/**
 * `verified`: Newegg accepted the write AND a read-back shows the new price.
 * `accepted`: Newegg accepted it; read-back skipped (`verify: false`).
 * `unverified`: Newegg accepted it but the read-back differs or failed (deactivated items are
 *   silently ignored while reported as success, contracts §6.2; reads can also lag).
 * `unknown`: the request may or may not have reached Newegg (timeout / 5xx after retries).
 * `failed`: Newegg rejected it, or it provably never left.
 */
export type PriceOutcomeStatus = "verified" | "accepted" | "unverified" | "unknown" | "failed";

export interface PriceUpdateOutcome {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  requestedSellingPrice: number;
  status: PriceOutcomeStatus;
  /** The price the read-back (or, failing that, the write response) reported. */
  observedSellingPrice?: number;
  errorCode?: string;
  message?: string;
}

export interface PriceUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  submittedItemCount: number;
  /** `verified` + `accepted`. */
  appliedItemCount: number;
  failedItemCount: number;
  /** `unverified` + `unknown`: re-read the price before trusting or retrying. */
  unresolvedItemCount: number;
  deduplicatedItemCount: number;
  items: PriceUpdateOutcome[];
  warnings: string[];
  rateLimit?: RateLimitInfo;
}

/** Pricing: Get Item Price reads (contracts §15) plus gated selling-price writes (§16). */
export interface PricingApi {
  /** One Get Item Price read. Throws {@link NeweggApiError} (e.g. CT026) for unknown items. */
  get(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot>;
  /** Like {@link PricingApi.get} but returns `undefined` for an unknown item (CT026 / CT010). */
  tryGet(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot | undefined>;
  /**
   * Prices many identifiers. Newegg documents batch-price endpoints but their wire shape is
   * unverified (contracts §15.3), so this fans out single reads with bounded concurrency.
   * Unknown items land in `missingIdentifiers`, other per-item failures in `failures`;
   * credential errors, rate-limit exhaustion and aborts still throw.
   */
  getMany(input: GetPriceManyInput, options?: GetPriceManyOptions): Promise<PriceBatchSnapshot>;
  /**
   * Validates, de-duplicates (last-write-wins) and risk-checks selling-price updates WITHOUT
   * writing. Reads each current price (unless `includeCurrentPrice: false`) to compute the
   * change and flag blockers (unknown item, currency mismatch, price above MSRP) and warnings
   * (inactive item, promotion lock, below MAP, no-op).
   */
  previewUpdate(
    updates: PriceUpdate | PriceUpdate[],
    options?: PreviewPriceOptions,
  ): Promise<PriceUpdatePreview>;
  /**
   * WRITE. Assigns absolute selling prices, one request per item (1-100 per call). Price
   * assignments are idempotent, so the direct-operation retry policy applies (ADR 0004); an
   * ambiguous failure that survives the retries is reported per item as `unknown` (after a
   * read-back attempt), never thrown; Newegg rejections (including credential errors) are
   * reported per item as `failed`. Only validation errors and caller aborts throw. Does NOT
   * apply preview blockers - callers (the MCP tools) enforce those.
   */
  update(
    updates: PriceUpdate | PriceUpdate[],
    options?: UpdatePricesOptions,
  ): Promise<PriceUpdateResult>;
}
