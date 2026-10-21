/**
 * Public type surface for `@devino/newegg-marketplace-sdk`.
 *
 * This module is a barrel over the per-domain modules in `./types/`; together they hold every
 * exported interface/type alias from the binding public API contract (see
 * `docs/research/sdk-public-api.md`). Error classes live in `errors/`, store implementations in
 * `rate-limit/` and `operation-store/`, and the factory in `client/`. Everything here is
 * re-exported from the package root.
 */

export type * from "./types/ads.js";
export type * from "./types/catalog.js";
export type * from "./types/client.js";
export type * from "./types/common.js";
export type * from "./types/feeds.js";
export type * from "./types/inventory.js";
export type * from "./types/listings.js";
export type * from "./types/orders.js";
export type * from "./types/pricing.js";
export type * from "./types/reference.js";
export type * from "./types/reports.js";
export type * from "./types/rma.js";
export type * from "./types/runtime.js";
export type * from "./types/sbn.js";
export type * from "./types/service.js";
export type * from "./types/shipping-labels.js";
export type * from "./types/storefront.js";
export type * from "./types/volume-discounts.js";
