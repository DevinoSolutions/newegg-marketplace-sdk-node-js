import { describe, expect, it } from "vitest";
import { redactLogText } from "../src/tools/log-redact.js";

// T-6901: leftovers from the PR #77 re-review. Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";
const TAIL = "TAILPART";
const NUMBER = 98765;

describe("escaped quotes inside a quoted credential value (item 1)", () => {
  it("masks the whole value, tail included", () => {
    const cases: Array<[string, string]> = [
      [String.raw`{"SecretKey":"a\"b${TAIL}"}`, '{"SecretKey":"[redacted]"}'],
      [String.raw`{"token":"a\"b${TAIL}"}`, '{"token":"[redacted]"}'],
      [String.raw`{ token: 'a\'b${TAIL}' }`, "{ token: '[redacted]' }"],
      [`{ token: \`a'b"${TAIL}\` }`, "{ token: `[redacted]` }"],
      [String.raw`Authorization: "Bearer a\"b${TAIL}"`, 'Authorization: "[redacted]"'],
      [`token="a b ${TAIL}" done`, 'token="[redacted]" done'],
    ];
    for (const [text, expected] of cases) expect(redactLogText(text), text).toBe(expected);
  });

  it("stops an unterminated quote at the end of the line", () => {
    expect(redactLogText(`token="abc${SEKRIT}\nnext line`)).toBe('token="[redacted]\nnext line');
  });

  it("keeps unquoted values and delimiters as before", () => {
    expect(redactLogText(`sellerid=${SEKRIT}&page=2`)).toBe("sellerid=[redacted]&page=2");
    expect(redactLogText(`Authorization: Bearer ${SEKRIT}, retrying`)).toBe(
      "Authorization: [redacted], retrying",
    );
  });
});

describe("a number or boolean after a comma needs an object-literal shape (item 2)", () => {
  it("leaves prose with a comma alone", () => {
    for (const text of [
      "Failed, token: 3 attempts left",
      "Retry, password: 12345 characters long",
      "Failed, secret: true story",
    ]) {
      expect(redactLogText(text), text).toBe(text);
    }
  });

  it("still masks later keys of a multi-key object", () => {
    expect(redactLogText(`{ a: 1, password: ${NUMBER} }`)).toBe("{ a: 1, password: [redacted] }");
    expect(redactLogText(`{\n  a: 1,\n  token: true,\n  b: 2\n}`)).toBe(
      "{\n  a: 1,\n  token: [redacted],\n  b: 2\n}",
    );
    expect(redactLogText(`{ token: ${NUMBER} }`)).toBe("{ token: [redacted] }");
  });
});

describe("stays linear on the new shapes", () => {
  it("handles repeated quotes, backslashes and unterminated values", () => {
    const shapes = [
      'token="'.repeat(60_000),
      `token="${String.raw`\"`.repeat(100_000)}`,
      `token='${String.raw`\\`.repeat(100_000)}`,
      `token=${String.raw`\ `.repeat(100_000)}`,
      "{ a: 1, token: ".repeat(40_000),
      `token: \`${"a".repeat(300_000)}`,
    ];
    for (const text of shapes) {
      const started = performance.now();
      redactLogText(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
