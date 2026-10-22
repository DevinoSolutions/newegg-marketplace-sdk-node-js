import { describe, expect, it } from "vitest";
import { LogEvent, noopLogger } from "../../src/logging/index.js";

describe("noopLogger", () => {
  it("implements every level and returns nothing", () => {
    expect(noopLogger.debug("e", { a: 1 })).toBeUndefined();
    expect(noopLogger.info("e")).toBeUndefined();
    expect(noopLogger.warn("e", {})).toBeUndefined();
    expect(noopLogger.error("e")).toBeUndefined();
  });
});

describe("LogEvent", () => {
  it("keeps the canonical snake_case event names stable", () => {
    expect(LogEvent).toEqual({
      RequestStarted: "request_started",
      RequestCompleted: "request_completed",
      RetryScheduled: "retry_scheduled",
      RateLimitWait: "rate_limit_wait",
      FeedSubmitted: "feed_submitted",
      FeedStatusChanged: "feed_status_changed",
      FeedProcessingCompleted: "feed_processing_completed",
      PartialFailure: "partial_failure",
      IndeterminateSubmission: "indeterminate_submission",
    });
  });
});
