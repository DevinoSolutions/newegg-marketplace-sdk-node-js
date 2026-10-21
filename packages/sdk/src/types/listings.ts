/** Existing-item listing creation types (contracts §13). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { FeedSubmission } from "./feeds.js";

// ----------------------------------------------------------------------------
// listings (existing item creation; contracts §13) — WRITE surface
// ----------------------------------------------------------------------------
export type ListingCondition = "New" | "Refurbished";
export type ListingShipping = "Default" | "Free";

/** One seller offer to create on an item already in Newegg's catalog (contracts §13).
 * At least one identifier (neweggItemNumber / upc / manufacturerPartNumber) is required;
 * `manufacturer` is ALWAYS required and must match Newegg's predefined manufacturer name
 * (carry it from `catalog.resolve()` matches). */
export interface CreateListingInput {
  /** Seller SKU, <=40 chars, immutable once created. */
  sellerPartNumber: string;
  manufacturer: string;
  neweggItemNumber?: string;
  upc?: string;
  /** Maps to the wire field `ManufacturerPartsNumber`. */
  manufacturerPartNumber?: string;
  sellingPrice: number;
  /** Available quantity for the default warehouse. */
  quantity: number;
  /** Default "New". CA supports only New/Refurbished. Immutable once created. */
  condition?: ListingCondition;
  /** Default 1. Immutable once created. */
  packsOrSets?: number;
  /** Default "Default" (seller-portal shipping settings). */
  shipping?: ListingShipping;
  /** Default false: the offer is created DEACTIVATED (hidden, not for sale). */
  activate?: boolean;
  currency?: "USD" | "CAD";
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  /** ISO 3166-1 alpha-3. */
  countryOfOrigin?: string;
  /** Business days, 1-14. Newegg defaults to 2 when omitted. */
  leadTime?: number;
  shippingTemplate?: string;
}

/** A validated input with defaults resolved and its position recorded. */
export interface NormalizedCreateListing extends CreateListingInput {
  inputIndex: number;
  condition: ListingCondition;
  packsOrSets: number;
  shipping: ListingShipping;
  activate: boolean;
}

/** Offline plan for a listing creation — validation + envelopes, zero network. */
export interface ListingCreatePreview {
  marketplace: NeweggMarketplace;
  items: NormalizedCreateListing[];
  itemCount: number;
  chunkCount: number;
  warnings: string[];
  /** One §13.2 envelope per chunk — exactly what `create` would submit. */
  envelopes: unknown[];
}

/** Existing-item listing creation (contracts §13). WRITE: `create` mutates the account. */
/** Accepted by `previewCreate`/`create`: raw inputs OR the normalized output of a prior
 * `previewCreate` (round-trip safe — `inputIndex` is stripped internally). */
export type CreateListingInputOrNormalized = CreateListingInput | NormalizedCreateListing;

export interface ListingsApi {
  /** Validate + normalize + build envelopes without any network access. */
  previewCreate(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
  ): ListingCreatePreview;
  /** Submit the Existing Item Creation feed. Poll the returned requestId(s) with
   * `feeds.getStatus` / `feeds.getResult`. */
  create(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
}
