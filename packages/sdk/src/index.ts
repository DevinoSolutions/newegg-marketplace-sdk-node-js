/**
 * `@devino/newegg-marketplace-sdk` — transport-independent TypeScript SDK for the Newegg
 * Marketplace API with first-class inventory management (US, B2B, Canada).
 *
 * The public surface is defined by `docs/research/sdk-public-api.md`. Testing helpers are
 * exported separately from `@devino/newegg-marketplace-sdk/testing`.
 */

// Public types (interfaces, unions) — all type-only.
export type * from "./types.js";

// Error hierarchy + error code union (classes are values, used with `instanceof`).
export * from "./errors/index.js";

// Factory.
export { createNeweggClient } from "./client/index.js";

// Store implementations.
export { InMemoryRateLimitStore } from "./rate-limit/index.js";
export { InMemoryOperationStore } from "./operation-store/index.js";

// Documented constants (chunk sizes; single source of truth for adjustable limits).
export { GET_BATCH_INVENTORY_MAX_VALUES } from "./inventory/constants.js";
export { INVENTORY_FEED_MAX_RECORDS } from "./feeds/constants.js";

// Version.
export { SDK_VERSION } from "./version.js";
