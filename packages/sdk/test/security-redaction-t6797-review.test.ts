import { describe, expect, it } from "vitest";
import { NeweggError } from "../src/index.js";

// T-6797 review follow-ups on PR #77. Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";
const NUMBER = "98765";

const causeOf = (cause: unknown): unknown => new NeweggError("api", "failed", { cause }).cause;
const messageOf = (message: string): string => new NeweggError("api", message).message;

describe("a seller id after a bare colon is a credential (review 1)", () => {
  it("masks SellerID / sellerid / sellerId followed by a colon", () => {
    expect(causeOf("SellerID: A0TEST is not authorized")).toBe("SellerID: *** is not authorized");
    for (const text of [`sellerid: ${SEKRIT}`, `sellerId: ${SEKRIT}`, `seller_id: ${SEKRIT}`]) {
      expect(causeOf(text), text).not.toContain(SEKRIT);
      expect(messageOf(text), text).not.toContain(SEKRIT);
    }
  });

  it("leaves a name that is merely quoted in a sentence alone", () => {
    const text = 'Configuration field "sellerId" must be a non-empty string';
    expect(messageOf(text)).toBe(text);
    expect(causeOf(text)).toBe(text);
  });
});

describe("compound credential names with a bare colon (review 2)", () => {
  it("masks hyphenated and underscored multi-word names", () => {
    const names = [
      "Auth-Token",
      "Access-Token",
      "Refresh-Token",
      "Client-Secret",
      "id_token",
      "access_token",
      "client_secret",
      "api_key",
      "Secret-Key",
      "X-Auth",
    ];
    for (const name of names) {
      const text = `${name}: ${SEKRIT}`;
      expect(causeOf(text), text).not.toContain(SEKRIT);
    }
  });

  it("still leaves single-word prose alone", () => {
    for (const text of [
      "Unexpected token: } in JSON",
      "password: must be at least 8 characters",
      "Failed, secret: not configured",
    ]) {
      expect(causeOf(text), text).toBe(text);
    }
  });
});

describe("a quoted cookie value with an escaped quote (review 3)", () => {
  it("masks the whole value, escaped quotes included", () => {
    const json = String.raw`{"cookie":"a=1; b=\"${SEKRIT}\""}`;
    expect(causeOf(json)).toBe('{"cookie":"***"}');
    const single = String.raw`{ cookie: 'a=1; b=\'${SEKRIT}\'' }`;
    expect(causeOf(single)).not.toContain(SEKRIT);
  });
});

describe("object-literal values that are not quoted strings (review 4)", () => {
  it("masks numbers, booleans and backtick values under a credential key", () => {
    const literals = [
      `{ password: ${NUMBER} }`,
      `{ sellerId: ${NUMBER} }`,
      `{ token: ${NUMBER} }`,
      "{ token: true }",
      `{ token: \`${SEKRIT}\` }`,
      `{password:${NUMBER}}`,
      `{ page: 2, secret: ${NUMBER}, other: 1 }`,
      `{ "sellerid": ${NUMBER} }`,
    ];
    for (const text of literals) {
      const out = causeOf(text) as string;
      expect(out, text).not.toContain(NUMBER);
      expect(out, text).not.toContain(SEKRIT);
      expect(out, text).not.toContain("true");
    }
    expect(causeOf(`{ page: 2, secret: ${NUMBER}, other: 1 }`)).toBe(
      "{ page: 2, secret: ***, other: 1 }",
    );
    expect(causeOf(`{ password: ${NUMBER} }`)).toBe("{ password: *** }");
  });

  it("does not touch prose without an object-literal prefix", () => {
    for (const text of [
      "token: 5 retries left",
      "Unexpected token: } in JSON",
      "Failed, token: expired",
      "page 2, password: must be at least 8 characters",
    ]) {
      expect(causeOf(text), text).toBe(text);
    }
  });
});

describe("stays linear on the new shapes", () => {
  it("handles repeated object-literal, backslash and whitespace shapes", () => {
    const shapes = [
      "{ token: ".repeat(60_000),
      `{${" ".repeat(300_000)}token`,
      ", token ".repeat(60_000),
      `{"cookie":"${String.raw`\"`.repeat(100_000)}`,
      `cookie:'${String.raw`\\`.repeat(100_000)}`,
      "sellerid: ".repeat(60_000),
    ];
    for (const text of shapes) {
      const started = performance.now();
      causeOf(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
