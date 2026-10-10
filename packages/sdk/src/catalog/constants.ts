/** Item Lookup report constants (contracts §12). Shared reportmgmt plumbing lives in `reportmgmt/`. */
export const ITEM_LOOKUP_OPERATION_TYPE = "ItemLookupRequest";

/** Max Item entries per lookup submission (§12.1, error RP021 beyond this). */
export const ITEM_LOOKUP_MAX_ITEMS = 1000;
/** Max (and default) result page size (§12.3). */
export const ITEM_LOOKUP_PAGE_SIZE = 100;
