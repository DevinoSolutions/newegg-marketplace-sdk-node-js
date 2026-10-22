import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRetryDelay, fullJitterDelay } from "../../src/client/retry.js";
import { NeweggApiError, NeweggRateLimitError } from "../../src/errors/index.js";

const RETRY = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fullJitterDelay", () => {
  it("returns random(0, base * 2^attempt) floored", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(fullJitterDelay(0, RETRY)).toBe(50);
    expect(fullJitterDelay(1, RETRY)).toBe(100);
    expect(fullJitterDelay(2, RETRY)).toBe(200);
  });

  it("caps the ceiling at maxDelayMs", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(fullJitterDelay(10, RETRY)).toBe(999);
  });

  it("is zero when random is zero or the delays are zero", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(fullJitterDelay(3, RETRY)).toBe(0);
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    expect(fullJitterDelay(3, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 })).toBe(0);
  });

  it("stays within [0, ceiling) for real random values", () => {
    for (let i = 0; i < 200; i++) {
      const value = fullJitterDelay(2, RETRY);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(400);
    }
  });
});

describe("computeRetryDelay", () => {
  it("honors an explicit retryAfterMs on a rate-limit error, ignoring the backoff cap", () => {
    const error = new NeweggRateLimitError("slow down", { retryAfterMs: 4_321 });
    expect(computeRetryDelay(error, 0, RETRY)).toBe(4_321);
  });

  it("falls back to jitter when a rate-limit error carries no retryAfterMs", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const error = new NeweggRateLimitError("slow down", {});
    expect(computeRetryDelay(error, 1, RETRY)).toBe(100);
  });

  it("uses jitter for every other error type", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeRetryDelay(new NeweggApiError("boom", { retryable: true }), 2, RETRY)).toBe(200);
  });
});
