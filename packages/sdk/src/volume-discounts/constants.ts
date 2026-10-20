/** Volume-discount constants (see `newegg-api-contracts.md` §22). */

/** `requesttype` of the volume-discount data feed (live-verified on Newegg.ca, §22.3). */
export const VOLUME_DISCOUNT_FEED_REQUEST_TYPE = "VOLUME_DISCOUNT_DATA";

/** Feed envelope `MessageType` (§22.3). */
export const VOLUME_DISCOUNT_MESSAGE_TYPE = "VolumeDiscount";

export const VOLUME_DISCOUNT_DOCUMENT_VERSION = "1.0";

/** Maximum tiers per item (docs: "3-tier calculation", Priority 1-3). */
export const VOLUME_DISCOUNT_MAX_TIERS = 3;

/** Smallest tier quantity: the docs require 1 pc < 1st Qty (CT061). */
export const VOLUME_DISCOUNT_MIN_QUANTITY = 2;

/** Highest quantity and price the SDK accepts (sanity bounds, not Newegg rules). */
export const VOLUME_DISCOUNT_MAX_QUANTITY = 1_000_000;
export const VOLUME_DISCOUNT_MAX_SELLING_PRICE = 99999.99;

/** Max items per feed file. ASSUMPTION: the generic data-feed record limit (§7.4); the volume
 * discount pages state none. */
export const VOLUME_DISCOUNT_FEED_MAX_RECORDS = 10_000;

export const SELLER_PART_NUMBER_MAX_LENGTH = 40;

/** Error codes meaning "this item has no volume discount (yet)" on a read (CT060, §22.1). */
export const VOLUME_DISCOUNT_NOT_FOUND_ERROR_CODES: ReadonlySet<string> = new Set(["CT060"]);
