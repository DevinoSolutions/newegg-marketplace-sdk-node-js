import { describe, expect, it } from "vitest";
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
    const future = new Date(Date.now() + 120_000);
    const y = future.getFullYear();
    const mo = String(future.getMonth() + 1).padStart(2, "0");
    const d = String(future.getDate()).padStart(2, "0");
    const hh = String(future.getHours()).padStart(2, "0");
    const mi = String(future.getMinutes()).padStart(2, "0");
    const ss = String(future.getSeconds()).padStart(2, "0");
    // Express the "after" time in the local zone as a rough sanity check that parsing occurs.
    const body = JSON.stringify([
      {
        Code: "DF012",
        Message: `exceeded hourly allowance. Please submit your feed again after ${y}-${mo}-${d} ${hh}:${mi}:${ss}.`,
      },
    ]);
    const error = map(429, body);
    expect(error).toBeInstanceOf(NeweggRateLimitError);
  });

  it("maps an unknown 5xx body to a retryable API error", () => {
    const error = map(503, "");
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.retryable).toBe(true);
  });

  it("maps a 400 body to a non-retryable API error", () => {
    expect(map(400, "").retryable).toBe(false);
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
