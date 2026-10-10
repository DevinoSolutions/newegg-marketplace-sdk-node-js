/** Reports Management (reportmgmt) endpoint paths + polling defaults shared by every report type. */
export const REPORT_SUBMIT_PATH = "reportmgmt/report/submitrequest";
export const REPORT_STATUS_PATH = "reportmgmt/report/status";
export const REPORT_RESULT_PATH = "reportmgmt/report/result";

/** `OperationType` of the (report-type independent) Get Report Status request (§12.2). */
export const REPORT_STATUS_OPERATION_TYPE = "GetReportStatusRequest";

/** Max rows per result page on every paged report (§12.3, §17). */
export const REPORT_RESULT_PAGE_SIZE = 100;

/** Default total budget for submit + poll + fetch, ms. */
export const REPORT_DEFAULT_TIMEOUT_MS = 120_000;
/** First poll delay, ms. */
export const REPORT_DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Poll delay ceiling, ms. */
export const REPORT_DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
/** Poll delay growth factor per poll. */
export const REPORT_POLL_BACKOFF_FACTOR = 1.5;
