import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NeweggError } from "../src/index.js";

// T-6797: leftovers from the PR #74 re-review of sanitizeCause. Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";
const TAIL = "TAILPART";
const HOST = ["ftp03", "newegg", "com"].join(".");
const URL_WITH_SECRET = `ftp://LabelUser:Zq7Kx9wLm@${HOST}/x`;

const causeOf = (cause: unknown): unknown => new NeweggError("api", "failed", { cause }).cause;

describe("prose that pairs a credential word with a colon is kept (item 1)", () => {
  it("leaves error prose alone", () => {
    const prose = [
      "Unexpected token: } in JSON",
      "password: must be at least 8 characters",
      "secret: not configured",
      "token: expired",
    ];
    for (const text of prose) expect(causeOf(text), text).toBe(text);
  });

  it("still redacts header-like names with a colon", () => {
    const lines = [
      `Authorization: Bearer ${SEKRIT}`,
      `Proxy-Authorization: Basic ${SEKRIT}`,
      `SecretKey: ${SEKRIT}`,
      `x-api-key: ${SEKRIT}`,
      `X-Auth-Token: ${SEKRIT}`,
      `api-key: ${SEKRIT}`,
    ];
    for (const text of lines) expect(causeOf(text), text).not.toContain(SEKRIT);
    expect(causeOf(`Authorization: Bearer ${SEKRIT}, retrying`)).toBe(
      "Authorization: ***, retrying",
    );
  });

  it("keeps '=', quoted-JSON and object-literal matching for the generic words", () => {
    const spellings = [
      `token=${SEKRIT}`,
      `password=${SEKRIT}`,
      `secret = ${SEKRIT}`,
      `{"token":"${SEKRIT}"}`,
      `{"password" : "${SEKRIT}"}`,
      `{ password: '${SEKRIT}' }`,
      `{ token: "${SEKRIT}" }`,
    ];
    for (const text of spellings) expect(causeOf(text), text).not.toContain(SEKRIT);
  });
});

describe("Cookie and Set-Cookie lines (item 2)", () => {
  it("redacts the value of a cookie line and keeps the neighbouring lines", () => {
    const cookies = [
      `Cookie: sid=${SEKRIT}`,
      `cookie: sid=${SEKRIT}; theme=dark`,
      `Set-Cookie: sid=${SEKRIT}; Path=/; HttpOnly`,
      `set-cookie=sid=${SEKRIT}`,
      `{"cookie":"sid=${SEKRIT}; a=b"}`,
      `{ cookie: 'sid=${SEKRIT}' }`,
    ];
    for (const text of cookies) expect(causeOf(text), text).not.toContain(SEKRIT);
    const multi = causeOf(`GET /x\nCookie: sid=${SEKRIT}\nAccept: */*`) as string;
    expect(multi).not.toContain(SEKRIT);
    expect(multi.startsWith("GET /x\nCookie: ")).toBe(true);
    expect(multi.endsWith("\nAccept: */*")).toBe(true);
  });

  it("does not touch words that merely start with cookie", () => {
    expect(causeOf("cookies: 3 stored")).toBe("cookies: 3 stored");
  });
});

describe("Function.prototype.toString is captured at load (item 3)", () => {
  function withHostileToString(run: () => void): number {
    const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("no Function.prototype.toString");
    }
    let calls = 0;
    Object.defineProperty(Function.prototype, "toString", {
      ...descriptor,
      value: function hostile(): string {
        calls += 1;
        throw new Error("hostile toString");
      },
    });
    try {
      run();
    } finally {
      Object.defineProperty(Function.prototype, "toString", descriptor);
    }
    return calls;
  }

  it("never calls an overridden toString while scanning a class with a hook", () => {
    class Hooked {
      readonly link = URL_WITH_SECRET;
      toJSON(): number {
        return 1;
      }
    }
    let copy: unknown;
    const calls = withHostileToString(() => {
      copy = causeOf(new Hooked());
    });
    expect(calls).toBe(0);
    expect((copy as Hooked).link).toContain("***@");
  });

  it("never calls an overridden toString while wrapping a function with a changed property", () => {
    class Holder {
      static readonly link = URL_WITH_SECRET;
      static bump(): number {
        return 1;
      }
    }
    let copy: unknown;
    const calls = withHostileToString(() => {
      copy = causeOf(Holder);
    });
    expect(calls).toBe(0);
    expect((copy as typeof Holder).link).toContain("***@");
    expect((copy as typeof Holder).bump()).toBe(1);
  });
});

describe("encoded delimiters inside a credential value (item 4)", () => {
  it("redacts the whole value, tail included", () => {
    for (const delimiter of ["%26", "%3B", "%3b", "%2C", "%23", "%20", "%22", "%27"]) {
      const spellings = [
        `sellerid=${SEKRIT}${delimiter}${TAIL}`,
        `%73ellerid=${SEKRIT}${delimiter}${TAIL}`,
        `sellerid%3D${SEKRIT}${delimiter}${TAIL}`,
        `https%3A%2F%2Fh%2F%3Fsellerid%3D${SEKRIT}${delimiter}${TAIL}`,
      ];
      for (const text of spellings) {
        const out = causeOf(text) as string;
        expect(out, text).not.toContain(SEKRIT);
        expect(out, text).not.toContain(TAIL);
      }
    }
  });

  it("keeps a literal delimiter after the value", () => {
    expect(causeOf(`sellerid=${SEKRIT}%26${TAIL}&page=2`)).toBe("sellerid=***&page=2");
  });
});

describe("NeweggError message and details get the credential-name redaction (item 5)", () => {
  it("redacts credential values in the message", () => {
    const messages = [
      `request failed: GET /x?sellerid=${SEKRIT}&page=2`,
      `Authorization: Bearer ${SEKRIT}`,
      `SecretKey: ${SEKRIT}`,
      `%73ellerid=${SEKRIT}%26${TAIL}`,
      `Cookie: sid=${SEKRIT}`,
    ];
    for (const message of messages) {
      const error = new NeweggError("api", message);
      expect(error.message, message).not.toContain(SEKRIT);
      expect(error.message, message).not.toContain(TAIL);
      expect(JSON.stringify(error.toJSON()), message).not.toContain(SEKRIT);
      expect(inspect(error), message).not.toContain(SEKRIT);
    }
  });

  it("leaves ordinary messages alone", () => {
    const text = "Unexpected token: } in JSON at position 4";
    expect(new NeweggError("api", text).message).toBe(text);
  });

  it("redacts credential values in details, nested and under credential keys", () => {
    const error = new NeweggError("api", "failed", {
      details: {
        url: `https://h.example/y?sellerid=${SEKRIT}&page=2`,
        nested: [`token=${SEKRIT}`, { line: `Authorization: Bearer ${SEKRIT}` }],
        SecretKey: SEKRIT,
        page: 2,
        note: "Unexpected token: } in JSON",
      },
    });
    expect(JSON.stringify(error.details)).not.toContain(SEKRIT);
    expect(JSON.stringify(error.toJSON())).not.toContain(SEKRIT);
    const details = error.details as { page: number; note: string };
    expect(details.page).toBe(2);
    expect(details.note).toBe("Unexpected token: } in JSON");
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
      causeOf(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
