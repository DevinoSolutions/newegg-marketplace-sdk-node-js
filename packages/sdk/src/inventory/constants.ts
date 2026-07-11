/**
 * Inventory-operation constants. Documented ASSUMPTION (see `newegg-api-contracts.md`
 * §5.3): the per-request maximum for batch reads did not render in extraction; the SDK
 * chunks batch reads at 100 identifiers per request. Isolated here so a doc correction is
 * a one-file change.
 */

/** Maximum identifier `Values` per batch inventory read request. */
export const GET_BATCH_INVENTORY_MAX_VALUES = 100;

/** Default bounded concurrency for direct (per-item) inventory writes. */
export const DEFAULT_DIRECT_CONCURRENCY = 4;

/** Default post-dedup item count above which `updateMany` "auto" switches to feeds. */
export const DEFAULT_AUTO_FEED_THRESHOLD = 8;
