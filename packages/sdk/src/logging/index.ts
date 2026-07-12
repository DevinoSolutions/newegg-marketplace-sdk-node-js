import type { NeweggLogger } from "../types.js";

/** No-op logger used by default; the SDK emits structured events only when a logger is supplied. */
export const noopLogger: NeweggLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Canonical structured event names emitted by the SDK. */
export const LogEvent = {
  RequestStarted: "request_started",
  RequestCompleted: "request_completed",
  RetryScheduled: "retry_scheduled",
  RateLimitWait: "rate_limit_wait",
  FeedSubmitted: "feed_submitted",
  FeedStatusChanged: "feed_status_changed",
  FeedProcessingCompleted: "feed_processing_completed",
  PartialFailure: "partial_failure",
  IndeterminateSubmission: "indeterminate_submission",
} as const;
