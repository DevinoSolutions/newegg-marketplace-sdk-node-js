/** Reports Management (reportmgmt) endpoints + Item Lookup constants (contracts §12). */
export const REPORT_SUBMIT_PATH = "reportmgmt/report/submitrequest";
export const REPORT_STATUS_PATH = "reportmgmt/report/status";
export const REPORT_RESULT_PATH = "reportmgmt/report/result";

export const ITEM_LOOKUP_OPERATION_TYPE = "ItemLookupRequest";
export const REPORT_STATUS_OPERATION_TYPE = "GetReportStatusRequest";

/** Max Item entries per lookup submission (§12.1, error RP021 beyond this). */
export const ITEM_LOOKUP_MAX_ITEMS = 1000;
/** Max (and default) result page size (§12.3). */
export const ITEM_LOOKUP_PAGE_SIZE = 100;

/** resolve() polling defaults. */
export const RESOLVE_DEFAULT_TIMEOUT_MS = 120_000;
export const RESOLVE_DEFAULT_POLL_INTERVAL_MS = 2_000;
export const RESOLVE_DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
export const RESOLVE_POLL_BACKOFF_FACTOR = 1.5;
