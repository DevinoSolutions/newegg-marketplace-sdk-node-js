/** Reports Management (reportmgmt) endpoint paths + polling defaults shared by every report type. */
export const REPORT_SUBMIT_PATH = "reportmgmt/report/submitrequest";
export const REPORT_STATUS_PATH = "reportmgmt/report/status";
export const REPORT_RESULT_PATH = "reportmgmt/report/result";

/** `OperationType` of the (report-type independent) Get Report Status request (§12.2). */
export const REPORT_STATUS_OPERATION_TYPE = "GetReportStatusRequest";

/** Max rows per result page on every paged report (§12.3, §17). */
export const REPORT_RESULT_PAGE_SIZE = 100;

/** Default total budget for submit + poll + fetch, ms (item lookup and the file reports). */
export const REPORT_DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Default wait budget for the SETTLEMENT reports, ms. Live-verified 2026-10-10: a Settlement
 * Summary took about 170 s from SUBMITTED to FINISHED, so the generic 120 s budget timed out on a
 * real account. 300 s leaves headroom; poll cost is unchanged (backoff caps at 15 s).
 */
export const REPORT_SETTLEMENT_TIMEOUT_MS = 300_000;
/** First poll delay, ms. */
export const REPORT_DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Poll delay ceiling, ms. */
export const REPORT_DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
/** Poll delay growth factor per poll. */
export const REPORT_POLL_BACKOFF_FACTOR = 1.5;
