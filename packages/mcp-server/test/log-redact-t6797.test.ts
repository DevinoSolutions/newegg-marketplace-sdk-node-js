import { NeweggError } from "@devino/newegg-marketplace-sdk";
import { describe, expect, it } from "vitest";
import { redactLogText } from "../src/tools/log-redact.js";
import { mapErrorToPayload } from "../src/tools/shared.js";

// T-6797: leftovers from the PR #74 re-review. Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";
const TAIL = "TAILPART";

describe("redactLogText prose and header-like names (item 1)", () => {
  it("leaves error prose that pairs a credential word with a colon alone", () => {
    const prose = [
      "Unexpected token: } in JSON",
      "password: must be at least 8 characters",
      "secret: not configured",
    ];
    for (const text of prose) expect(redactLogText(text), text).toBe(text);
  });

  it("still redacts header lines, '=', quoted JSON and object literals", () => {
    const spellings = [
      `Authorization: Bearer ${SEKRIT}`,
      `SecretKey: ${SEKRIT}`,
      `x-api-key: ${SEKRIT}`,
      `api-key: ${SEKRIT}`,
      `token=${SEKRIT}`,
      `password = ${SEKRIT}`,
      `{"token":"${SEKRIT}"}`,
      `{ password: '${SEKRIT}' }`,
    ];
    for (const text of spellings) expect(redactLogText(text), text).not.toContain(SEKRIT);
    expect(redactLogText(`Authorization: Bearer ${SEKRIT}, retrying`)).toBe(
      "Authorization: [redacted], retrying",
    );
  });
});

describe("redactLogText cookie lines (item 2)", () => {
  it("redacts the value and keeps the neighbouring lines", () => {
    const cookies = [
      `Cookie: sid=${SEKRIT}`,
      `Set-Cookie: sid=${SEKRIT}; Path=/; HttpOnly`,
      `{"cookie":"sid=${SEKRIT}; a=b"}`,
      `{ cookie: 'sid=${SEKRIT}' }`,
    ];
    for (const text of cookies) expect(redactLogText(text), text).not.toContain(SEKRIT);
    const multi = redactLogText(`GET /x\nCookie: sid=${SEKRIT}\nAccept: */*`);
    expect(multi).not.toContain(SEKRIT);
    expect(multi.endsWith("\nAccept: */*")).toBe(true);
    expect(redactLogText("cookies: 3 stored")).toBe("cookies: 3 stored");
  });
});

describe("redactLogText encoded delimiters inside a value (item 4)", () => {
  it("redacts the whole value, tail included", () => {
    for (const delimiter of ["%26", "%3B", "%2C", "%23", "%20"]) {
      const spellings = [
        `sellerid=${SEKRIT}${delimiter}${TAIL}`,
        `%73ellerid=${SEKRIT}${delimiter}${TAIL}`,
        `sellerid%3D${SEKRIT}${delimiter}${TAIL}`,
      ];
      for (const text of spellings) {
        const out = redactLogText(text);
        expect(out, text).not.toContain(SEKRIT);
        expect(out, text).not.toContain(TAIL);
      }
    }
    expect(redactLogText(`sellerid=${SEKRIT}%26${TAIL}&page=2`)).toBe("sellerid=[redacted]&page=2");
  });
});

describe("NeweggError message in a tool error payload (item 5)", () => {
  it("does not carry credential values", () => {
    const error = new NeweggError(
      "api",
      `failed GET /x?sellerid=${SEKRIT}&page=2, SecretKey: ${SEKRIT}`,
    );
    const payload = mapErrorToPayload(error, () => undefined);
    expect(JSON.stringify(payload)).not.toContain(SEKRIT);
    expect(payload.message).toContain("page=2");
  });
});

describe("stays linear on adversarial cookie and colon text", () => {
  it("handles repeated and unterminated shapes", () => {
    const shapes = [
      'cookie:"'.repeat(60_000),
      "cookie: ".repeat(60_000),
      `cookie:'${"a".repeat(200_000)}
${"cookie: '".repeat(30_000)}`,
      "token: '".repeat(60_000),
      "x-api-key:".repeat(60_000),
      `${"%26".repeat(100_000)}sellerid=${"%73".repeat(100_000)}`,
    ];
    for (const text of shapes) {
      const started = performance.now();
      redactLogText(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
