// Public storefront buy-box / offers types (contracts §14). Re-exported from `../types.ts`.

// ----------------------------------------------------------------------------
// storefront (public buy-box / offers; contracts §14) — UNOFFICIAL, read-only
// ----------------------------------------------------------------------------

/** Per-request options for the storefront surface. The storefront is unauthenticated and
 * carries no correlation id or rate-limit headers, so only cancellation and timeout apply. */
export interface StorefrontRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One seller offer on a public storefront product page.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only.
 */
export interface StorefrontOffer {
  /** The offer's item number. Newegg first-party offers echo the PARENT catalog number;
   * marketplace offers carry the seller offer number (`9SI…`). */
  readonly offerItemNumber: string;
  /** Undefined for Newegg first-party offers (the storefront sends `null`). */
  readonly sellerName: string | undefined;
  /** Undefined for Newegg first-party offers (`Seller` is null or its `SellerId` is empty). */
  readonly sellerId: string | undefined;
  /** True when the offer is sold by Newegg itself rather than a marketplace seller. */
  readonly isNewegg: boolean;
  /** `UnitCost` — the offer price in the storefront's currency (CAD on newegg.ca). */
  readonly price: number;
  /** Raw `ShippingCharge`. CAUTION: `0.01` is observed even on offers the site labels
   * "Free Shipping", so a non-zero value does NOT reliably mean paid shipping. */
  readonly shippingCharge: number;
  readonly inStock: boolean;
  readonly active: boolean;
}

/**
 * All seller offers listed for one parent product on the public storefront.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only.
 */
export interface StorefrontOffersResult {
  /** The parent catalog identifier actually queried (post-normalization). */
  readonly parentItemNumber: string;
  /** Offers in the storefront's own order. */
  readonly offers: readonly StorefrontOffer[];
  /** **ASSUMPTION**: the first offer is the buy-box winner — the storefront's ordering looks
   * like its featured ranking and matched the page's buy box in every observation, but this
   * is not documented anywhere. `undefined` when there are no offers. */
  readonly buyBox: StorefrontOffer | undefined;
  /** The envelope's `Total` (offer count across all pages), falling back to `offers.length`. */
  readonly total: number;
}

/**
 * Either a parent catalog identifier or a seller offer number.
 *
 * `itemNumber` accepts the dashed catalog form (`20-156-294`), the product-page form
 * (`N82E16820156294`, normalized to dashed), or a marketplace-style parent CODE
 * (`3C6-00T1-002H0`). `offerNumber` is a `9SI…` seller offer number, which costs one extra
 * request: the SDK resolves it to its parent via the product page's 301 redirect first.
 */
export type GetOffersArgs = { itemNumber: string } | { offerNumber: string };

/**
 * Read the public storefront's buy box and competing seller offers for a product.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only. It sends no credentials and touches nothing on the seller
 * account. Only the `us` and `ca` marketplaces have a public storefront: on `b2b` every call
 * throws {@link UnsupportedMarketplaceOperationError}.
 */
export interface StorefrontApi {
  /**
   * Fetch every seller offer for a product (contracts §14.1). Throws
   * {@link NeweggApiError} on a non-2xx response, an unparsable body, or an offer number
   * whose product page does not redirect to a resolvable parent.
   */
  getOffers(
    args: GetOffersArgs,
    options?: StorefrontRequestOptions,
  ): Promise<StorefrontOffersResult>;
}
