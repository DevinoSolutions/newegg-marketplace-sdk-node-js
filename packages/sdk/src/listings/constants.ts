/** Existing Item Creation feed (contracts §13). */
export const ITEM_FEED_REQUEST_TYPE = "ITEM_DATA";
/** Bare query flag selecting the existing-item (v2) template — sent as `&v2`. */
export const EXISTING_ITEM_QUERY_FLAG = "v2";
export const EXISTING_ITEM_DOCUMENT_VERSION = "2.0";
export const EXISTING_ITEM_MESSAGE_TYPE = "BatchItemCreation";
/** Max records per Existing Item Creation feed file (§13.1; inventory feeds allow 10k). */
export const LISTING_FEED_MAX_RECORDS = 3_000;
export const SELLER_PART_NUMBER_MAX_LENGTH = 40;
