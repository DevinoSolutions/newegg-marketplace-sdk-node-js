import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NeweggError, NeweggValidationError } from "../src/index.js";

// T-6901: leftovers from the PR #77 re-review. Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";
const TAIL = "TAILPART";
const NUMBER = 98765;

const causeOf = (cause: unknown): unknown => new NeweggError("api", "failed", { cause }).cause;
const messageOf = (message: string): string => new NeweggError("api", message).message;
const detailsOf = (details: unknown): unknown =>
  new NeweggError("api", "failed", { details }).details;
const render = (value: unknown): string => inspect(value, { depth: 12, showHidden: true });

describe("escaped quotes inside a quoted credential value (item 1)", () => {
  it("masks the whole value, tail included", () => {
    const cases: Array<[string, string]> = [
      [String.raw`{"SecretKey":"a\"b${TAIL}"}`, '{"SecretKey":"***"}'],
      [String.raw`{"token":"a\"b${TAIL}"}`, '{"token":"***"}'],
      [String.raw`{ token: 'a\'b${TAIL}' }`, "{ token: '***' }"],
      [`{ token: \`a'b"${TAIL}\` }`, "{ token: `***` }"],
      [String.raw`Authorization: "Bearer a\"b${TAIL}"`, 'Authorization: "***"'],
      [`token="a b ${TAIL}" done`, 'token="***" done'],
      [String.raw`password='x\\y\'${TAIL}'`, "password='***'"],
    ];
    for (const [text, expected] of cases) {
      expect(causeOf(text), text).toBe(expected);
      expect(messageOf(text), text).toBe(expected);
    }
  });

  it("stops an unterminated quote at the end of the line", () => {
    expect(causeOf(`token="abc${SEKRIT}\nnext line`)).toBe('token="***\nnext line');
  });

  it("keeps unquoted values and delimiters as before", () => {
    expect(causeOf(`sellerid=${SEKRIT}&page=2`)).toBe("sellerid=***&page=2");
    expect(causeOf(`Authorization: Bearer ${SEKRIT}, retrying`)).toBe(
      "Authorization: ***, retrying",
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
      expect(causeOf(text), text).toBe(text);
    }
  });

  it("still masks later keys of a multi-key object", () => {
    expect(causeOf(`{ a: 1, password: ${NUMBER} }`)).toBe("{ a: 1, password: *** }");
    expect(causeOf(`{ a: 1, password: ${NUMBER}, b: 2 }`)).toBe("{ a: 1, password: ***, b: 2 }");
    expect(causeOf(`{\n  a: 1,\n  token: true,\n  b: 2\n}`)).toBe(
      "{\n  a: 1,\n  token: ***,\n  b: 2\n}",
    );
    expect(causeOf(`{ token: ${NUMBER} }`)).toBe("{ token: *** }");
  });
});

describe("NeweggValidationError issues are redacted (item 3)", () => {
  it("masks credential values in issue paths and messages and keeps the rest", () => {
    const error = new NeweggValidationError("bad input", [
      {
        path: `query?sellerid=${SEKRIT}`,
        message: `Authorization: Bearer ${SEKRIT} rejected`,
        inputIndex: 2,
      },
      { path: "items[0].sku", message: "must be a string" },
      { path: "a", message: "Unexpected token: } in JSON" },
    ]);
    expect(JSON.stringify(error.issues)).not.toContain(SEKRIT);
    expect(JSON.stringify(error.toJSON())).not.toContain(SEKRIT);
    expect(error.issues[0]?.inputIndex).toBe(2);
    expect(error.issues[1]).toEqual({ path: "items[0].sku", message: "must be a string" });
    expect(error.issues[2]?.message).toBe("Unexpected token: } in JSON");
  });
});

describe("Error and Map values inside details are sanitized (item 4)", () => {
  it("masks the message, stack and cause of an Error", () => {
    const original = new Error(`failed sellerid=${SEKRIT}`, { cause: `token=${SEKRIT}` });
    const details = detailsOf({ error: original, list: [original] }) as {
      error: unknown;
      list: unknown[];
    };
    expect(render(details)).not.toContain(SEKRIT);
    expect(details.error instanceof Error).toBe(true);
    expect((details.error as Error).message).toBe("failed sellerid=***");
    expect(original.message).toContain(SEKRIT);
  });

  it("masks Map keys and values", () => {
    const details = detailsOf({
      map: new Map<string, unknown>([
        ["note", `token=${SEKRIT}`],
        ["sellerid", SEKRIT],
      ]),
    }) as { map: Map<string, unknown> };
    expect(render(details)).not.toContain(SEKRIT);
    expect(details.map instanceof Map).toBe(true);
    expect(details.map.get("sellerid")).toBe("***");
  });

  it("masks a class instance's credential-bearing properties", () => {
    class Holder {
      readonly link = `ftp://LabelUser:Zq7Kx9wLm@${["ftp03", "newegg", "com"].join(".")}/x`;
      readonly note = `sellerid=${SEKRIT}`;
    }
    const details = detailsOf({ holder: new Holder() });
    expect(render(details)).not.toContain(SEKRIT);
    expect(render(details)).not.toContain("Zq7Kx9wLm");
  });

  it("leaves plain data and Dates alone", () => {
    const when = new Date(0);
    const details = detailsOf({ n: 1, ok: true, list: [1, "x"], when }) as { when: Date };
    expect(details).toEqual({ n: 1, ok: true, list: [1, "x"], when });
  });
});

describe("numeric values under a credential key are masked (item 5)", () => {
  it("masks numbers and bigints in a cause object", () => {
    const cause = causeOf({ sellerId: NUMBER, token: 7n, page: 2 }) as Record<string, unknown>;
    expect(cause.sellerId).toBe("***");
    expect(cause.token).toBe("***");
    expect(cause.page).toBe(2);
    expect(render(cause)).not.toContain(String(NUMBER));
  });

  it("masks numbers and bigints in details", () => {
    const details = detailsOf({ nested: { sellerId: NUMBER, secret: 7n }, page: 2 }) as {
      nested: Record<string, unknown>;
      page: number;
    };
    expect(details.nested.sellerId).toBe("***");
    expect(details.nested.secret).toBe("***");
    expect(details.page).toBe(2);
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
      causeOf(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
