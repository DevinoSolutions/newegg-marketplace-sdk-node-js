import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NeweggError } from "../src/index.js";

// T-6267: leftovers after PR #59 (T-6111). The SDK only ever puts fetch/undici errors in a cause
// (no Request, Headers or response is attached), so the Headers / Request shapes are defence in
// depth for callers that hand a richer cause to NeweggError. Fixture secrets are made up.

const SELLER = "SECRET-SELLER";
const API_KEY = "SECRET-API-KEY";
const SECRET_KEY = "SECRET-SECRET-KEY";
const USER = "LabelUser";
const PASS = "Zq7Kx9wLm";
const HOST = ["ftp03", "newegg", "com"].join(".");
const URL_WITH_SECRET = `ftp://${USER}:${PASS}@${HOST}/x`;

const render = (cause: unknown): string =>
  inspect(new NeweggError("api", "failed", { cause }), { depth: 12, showHidden: true });
const causeOf = (cause: unknown): unknown => new NeweggError("api", "failed", { cause }).cause;

function expectNoSecret(output: string): void {
  for (const secret of [SELLER, API_KEY, SECRET_KEY, USER, PASS]) {
    expect(output).not.toContain(secret);
  }
}

describe("function wrapper keeps its class identity (item 1)", () => {
  it("keeps instanceof and static #private methods working on the redacted copy", () => {
    class Original {
      static readonly link = URL_WITH_SECRET;
      static #counter = 41;
      static next(): number {
        return (Original.#counter += 1);
      }
    }
    const copy = causeOf(Original) as typeof Original;
    expect(copy).not.toBe(Original);
    expect(copy.link).toContain("***@");
    expect(new copy() instanceof Original).toBe(true);
    expect(copy.next()).toBe(42);
  });

  it("keeps a static method that reads this.#x working", () => {
    class Holder {
      static readonly link = URL_WITH_SECRET;
      static #secretCounter = 1;
      static bump(): number {
        return (this.#secretCounter += 1);
      }
    }
    const copy = causeOf(Holder) as typeof Holder;
    expect(copy.bump()).toBe(2);
    expectNoSecret(render(Holder));
  });
});

describe("a redaction never runs user code on the copy (item 2)", () => {
  it("does not call prototype getters or [util.inspect.custom]", () => {
    const calls = { getter: 0, custom: 0 };
    class Hostile {
      link = URL_WITH_SECRET;
      get boom(): number {
        calls.getter += 1;
        for (;;) {
          if (calls.getter > 0) throw new Error("must not run");
        }
      }
      [inspect.custom](): string {
        calls.custom += 1;
        return "custom";
      }
    }
    const out = causeOf(new Hostile());
    expect(calls).toEqual({ getter: 0, custom: 0 });
    expect(JSON.stringify(out)).not.toContain(PASS);
  });
});

describe("Headers, Request and query secrets (item 3)", () => {
  it("masks Authorization and SecretKey values inside Headers", () => {
    const headers = new Headers({
      Authorization: API_KEY,
      SecretKey: SECRET_KEY,
      Accept: "application/json",
    });
    expectNoSecret(render(headers));
    const copy = causeOf(headers) as Headers;
    expect(copy).toBeInstanceOf(Headers);
    expect(copy.get("accept")).toBe("application/json");
    expect(copy.get("authorization")).toBe("***");
    expect(copy.get("secretkey")).toBe("***");
    expect(headers.get("secretkey")).toBe(SECRET_KEY);
  });

  it("masks headers and the sellerid query of a Request", () => {
    const request = new Request(`https://api.example.test/x?sellerid=${SELLER}&page=2`, {
      headers: { Authorization: API_KEY, SecretKey: SECRET_KEY },
    });
    expectNoSecret(render(request));
    expectNoSecret(render({ request }));
  });

  it("redacts a sellerid query inside any cause string", () => {
    expectNoSecret(render(`GET /x?sellerid=${SELLER}&page=2 HTTP/1.1`));
    expectNoSecret(render(new Error(`fetch failed https://h.example/y?sellerid=${SELLER}`)));
    expect(String(causeOf(`GET /x?sellerid=${SELLER}&page=2`))).toContain("page=2");
  });

  it("redacts a RegExp source and a Symbol description", () => {
    expectNoSecret(render(new RegExp(`${USER}:${PASS}@${HOST}`.replace(/\./g, "\."))));
    expectNoSecret(render(Symbol(URL_WITH_SECRET)));
  });
});

describe("non-error causes stay sane (item 4)", () => {
  it("handles strings, numbers, plain objects and booleans", () => {
    expect(causeOf(URL_WITH_SECRET)).toBe("ftp://***@" + HOST + "/x");
    expect(causeOf(42)).toBe(42);
    expect(causeOf(true)).toBe(true);
    const plain = { code: 7, where: URL_WITH_SECRET };
    const copy = causeOf(plain) as typeof plain;
    expect(copy.code).toBe(7);
    expect(copy.where).not.toContain(PASS);
    expect(plain.where).toBe(URL_WITH_SECRET);
    const clean = { code: 7 };
    expect(causeOf(clean)).toBe(clean);
  });
});
