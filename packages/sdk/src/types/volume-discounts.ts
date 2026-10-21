/** Volume discount types (contracts §22). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { FeedSubmission } from "./feeds.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// volume discounts (contracts §22)
// ----------------------------------------------------------------------------

/** Identifies the item for a Get Volume Discount read. At least one field is required. */
export interface GetVolumeDiscountInput {
  /** Newegg item number. Wins when both identifiers are given. */
  neweggItemNumber?: string;
  sellerPartNumber?: string;
}

/** One quantity tier as read back from Newegg. */
export interface VolumeDiscountTierSnapshot {
  /** 1-based tier position. */
  priority: number;
  /** Minimum order quantity at which this tier's price applies. */
  quantity: number;
  /** Per-unit price at this tier. */
  sellingPrice: number;
  /** Whether shipping is free at this tier (`EnableFreeShipping` 1). */
  freeShipping: boolean;
}

/** Result of Get Volume Discount (contracts §22.1). */
export interface VolumeDiscountSnapshot {
  marketplace: NeweggMarketplace;
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  /** Ordered by priority. */
  tiers: VolumeDiscountTierSnapshot[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One requested tier. Priority is implied by array order (tier 1 first). */
export interface VolumeDiscountTier {
  /** Minimum order quantity: an integer >= 2, strictly above the previous tier's. */
  quantity: number;
  /** Per-unit price: > 0 and strictly below the previous tier's. */
  sellingPrice: number;
  /** Free shipping at this tier. Default false. */
  freeShipping?: boolean;
}

/** Create-or-replace the volume discount of ONE item (1-3 tiers). */
export interface VolumeDiscountUpdate {
  /** At least one of `neweggItemNumber` / `sellerPartNumber` is required. */
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  /** Tier 1 first. Replaces the item's whole current discount. */
  tiers: VolumeDiscountTier[];
}

/** A tier with defaults resolved and its priority assigned. */
export interface NormalizedVolumeDiscountTier {
  priority: number;
  quantity: number;
  /** Rounded to the cent. */
  sellingPrice: number;
  freeShipping: boolean;
}

/** A validated update with its position recorded. */
export interface NormalizedVolumeDiscountUpdate {
  inputIndex: number;
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  tiers: NormalizedVolumeDiscountTier[];
}

/** Accepted by `previewUpdate`/`update`: raw inputs OR the normalized output of a prior
 * `previewUpdate` (round-trip safe - `inputIndex` and tier `priority` are stripped internally). */
export type VolumeDiscountUpdateOrNormalized =
  VolumeDiscountUpdate | NormalizedVolumeDiscountUpdate;

/** Offline plan for a volume-discount update - validation + envelopes, zero network. */
export interface VolumeDiscountUpdatePreview {
  marketplace: NeweggMarketplace;
  items: NormalizedVolumeDiscountUpdate[];
  itemCount: number;
  chunkCount: number;
  warnings: string[];
  /** One `VOLUME_DISCOUNT_DATA` envelope per chunk - exactly what `update` would submit. */
  envelopes: unknown[];
}

/**
 * Volume discounts (contracts §22). `get`/`tryGet` are Get Volume Discount, a READ although it is
 * sent as `PUT`. `update` is a WRITE: it submits a `VOLUME_DISCOUNT_DATA` data feed (the direct
 * Submit Volume Discount API is not used - it errors on Newegg.ca, §22.2). `previewUpdate` is
 * offline. Writes are supported on Newegg.ca only (the only platform verified live).
 */
export interface VolumeDiscountsApi {
  /** One Get Volume Discount read. Throws {@link NeweggApiError} (CT060) when the item has none yet. */
  get(input: GetVolumeDiscountInput, options?: RequestOptions): Promise<VolumeDiscountSnapshot>;
  /** Like {@link VolumeDiscountsApi.get} but returns `undefined` when the item has no volume discount (CT060). */
  tryGet(
    input: GetVolumeDiscountInput,
    options?: RequestOptions,
  ): Promise<VolumeDiscountSnapshot | undefined>;
  /** Validate + normalize + build envelopes without any network access. */
  previewUpdate(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
  ): VolumeDiscountUpdatePreview;
  /** WRITE. Submit the volume-discount feed. Poll the returned requestId(s) with
   * `feeds.getStatus` / `feeds.getResult`. */
  update(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
}
