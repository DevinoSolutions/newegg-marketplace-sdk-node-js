import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IndeterminateFeedSubmissionError,
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggAuthorizationError,
  NeweggRateLimitError,
  NeweggValidationError,
} from "../src/index.js";
import { parseUpstreamError } from "../src/errors/parse-upstream.js";

function map(status: number, body: string) {
  return parseUpstreamError(status, body, new Headers(), { correlationId: "cid" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseUpstreamError", () => {
  it("parses a single JSON object error", () => {
    const error = map(400, JSON.stringify({ Code: "CT002", Message: "Invalid SellerPartNumber" }));
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBe("CT002");
  });

  it("parses a JSON array error", () => {
    const error = map(400, JSON.stringify([{ Code: "CE001", Message: "SellerID cannot be null" }]));
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBe("CE001");
  });

  it("parses an XML error body without an XML dependency", () => {
    const error = map(
      400,
      '<?xml version="1.0"?><Error><Code>DF006</Code><Message>bad id</Message></Error>',
    );
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBe("DF006");
  });

  it("maps a plain-text 401 to an authentication error", () => {
    const error = map(401, "Gateway: Seller Auth failed.");
    expect(error).toBeInstanceOf(NeweggAuthenticationError);
    expect(error.retryable).toBe(false);
  });

  it("maps InvalidToken to an authentication error", () => {
    const error = map(
      200,
      JSON.stringify([{ Code: "InvalidToken", Message: "Invalid secret key." }]),
    );
    expect(error).toBeInstanceOf(NeweggAuthenticationError);
  });

  it("maps 403 and deactivation/authorization messages to authorization errors", () => {
    expect(map(403, "")).toBeInstanceOf(NeweggAuthorizationError);
    expect(
      map(400, JSON.stringify({ Code: "X", Message: "You do not have authorization for this." })),
    ).toBeInstanceOf(NeweggAuthorizationError);
    expect(
      map(400, JSON.stringify({ Code: "X", Message: "This item has been deactivated." })),
    ).toBeInstanceOf(NeweggAuthorizationError);
  });

  it("maps 429 to a rate-limit error", () => {
    const error = map(429, JSON.stringify([{ Code: "429", Message: "Too many request." }]));
    expect(error).toBeInstanceOf(NeweggRateLimitError);
  });

  it("maps DF012 to a rate-limit error with a parsed retryAfterMs", () => {
    // Freeze "now" so the Pacific-wall-clock → UTC math is deterministic on any machine/timezone.
    // 2026-07-12T00:00:00Z == 2026-07-11 17:00:00 PDT (UTC-7), so the reset below is exactly +2min.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00Z"));
    const body = JSON.stringify([
      {
        Code: "DF012",
        Message:
          "exceeded hourly allowance. Please submit your feed again after 2026-07-11 17:02:00.",
      },
    ]);
    const error = map(429, body);
    expect(error).toBeInstanceOf(NeweggRateLimitError);
    // Assert the actual parsed delay, not merely that some rate-limit error was produced: the
    // "submit again after <Pacific time>" hint must be interpreted as PDT and honored as 120s.
    expect((error as NeweggRateLimitError).retryAfterMs).toBe(120_000);
  });

  it("maps an unknown 5xx body to a retryable API error", () => {
    const error = map(503, "");
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.retryable).toBe(true);
  });

  it("maps a 400 body to a non-retryable API error", () => {
    expect(map(400, "").retryable).toBe(false);
  });

  it("maps Newegg's transient 500 InternalError to a retryable API error (observed live)", () => {
    // Observed live (CA reportmgmt, 2026-07-18): HTTP 500 with code "InternalError" and a
    // body that literally asks the caller to retry.
    const body = JSON.stringify([
      {
        Code: "InternalError",
        Message:
          "Our servers are currently unavailable and cannot process your request at this " +
          "time. Please try again. We apologize for any inconvenience.",
      },
    ]);
    const error = map(500, body);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.retryable).toBe(true);
  });

  it("keeps a bare 500 without a transience signal non-retryable", () => {
    expect(map(500, "").retryable).toBe(false);
  });
});

describe("error toJSON contract", () => {
  it("serializes every error class as JSON without throwing", () => {
    const errors = [
      new NeweggApiError("api", { neweggErrorCode: "CT002", correlationId: "c", httpStatus: 400 }),
      new NeweggAuthenticationError("authn"),
      new NeweggAuthorizationError("authz"),
      new NeweggRateLimitError("rl", { retryAfterMs: 1000 }),
      new NeweggValidationError("v", [{ path: "quantity", message: "bad", inputIndex: 0 }]),
      new IndeterminateFeedSubmissionError("indeterminate", {
        payloadHash: "abc",
        marketplace: "us",
        submittedAtIso: new Date().toISOString(),
      }),
    ];
    for (const error of errors) {
      const json = error.toJSON();
      expect(() => JSON.stringify(json)).not.toThrow();
      expect(json.code).toBeTypeOf("string");
    }
  });

  it("exposes validation issues and indeterminate fields on toJSON", () => {
    const validation = new NeweggValidationError("v", [{ path: "quantity", message: "bad" }]);
    expect((validation.toJSON().issues as unknown[]).length).toBe(1);

    const indeterminate = new IndeterminateFeedSubmissionError("i", {
      payloadHash: "hash123",
      marketplace: "ca",
      submittedAtIso: "2026-01-01T00:00:00.000Z",
    });
    const json = indeterminate.toJSON();
    expect(json.payloadHash).toBe("hash123");
    expect(json.guidance).toBeTypeOf("string");
  });
});
