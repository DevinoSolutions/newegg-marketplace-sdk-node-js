/** Data-feed limits and request types (see `newegg-api-contracts.md` §7). */

/** Maximum records per feed file. */
export const INVENTORY_FEED_MAX_RECORDS = 10_000;

/** Local budget: feed submissions per minute, per `${marketplace}:${sellerId}`. */
export const FEED_SUBMISSIONS_PER_MINUTE = 10;

/** Local budget: inventory records per hour, per `${marketplace}:${sellerId}`. */
export const FEED_RECORDS_PER_HOUR = 100_000;

/** US inventory feed request type. */
export const US_FEED_REQUEST_TYPE = "INVENTORY_DATA";

/** B2B/CAN inventory-and-price feed request type (inventory-only use). */
export const B2B_CA_FEED_REQUEST_TYPE = "INVENTORY_AND_PRICE_DATA";
