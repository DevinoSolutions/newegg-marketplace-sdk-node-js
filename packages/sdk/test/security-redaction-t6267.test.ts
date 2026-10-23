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
        throw new Error("must not run");
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

  it("redacts a RegExp source (escaped dots included) and a Symbol description", () => {
    const escapedHost = ["ftp03", "newegg", "com"].join("\\.");
    const regexp = new RegExp(`${USER}:${PASS}@${escapedHost}`);
    expect(regexp.source).toContain("\\.");
    expect(causeOf(regexp)).toBe("[Redacted RegExp]");
    expectNoSecret(render(regexp));
    expectNoSecret(render(Symbol(URL_WITH_SECRET)));
    const plain = /abc/g;
    expect(causeOf(plain)).toBe(plain);
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

const KEYED = "SEKRIT";
const deep = (cause: unknown): string =>
  inspect(new NeweggError("api", "failed", { cause }), { depth: 20, showHidden: true });

describe("review follow-ups (T-6267)", () => {
  it("falls back to a text summary when a hook reaches #private through another method", () => {
    class A {
      #x = 1;
      link = URL_WITH_SECRET;
      describe(): number {
        return this.#x;
      }
      [inspect.custom](): number {
        return this.describe();
      }
    }
    const out = deep(new A());
    expect(out).not.toContain(PASS);
    expect(() => inspect(causeOf(new A()))).not.toThrow();
  });

  it("falls back for toJSON through a #private method and for a WeakMap-private getter", () => {
    class B {
      #x = 1;
      link = URL_WITH_SECRET;
      read(): number {
        return this.#x;
      }
      toJSON(): unknown {
        return { n: this.read() };
      }
    }
    const store = new WeakMap<object, { n: number }>();
    class C {
      link = URL_WITH_SECRET;
      constructor() {
        store.set(this, { n: 1 });
      }
      get n(): number {
        return (store.get(this) as { n: number }).n;
      }
      toJSON(): unknown {
        return { n: this.n };
      }
    }
    for (const value of [new B(), new C()]) {
      const cause = causeOf(value);
      expect(() => JSON.stringify(cause)).not.toThrow();
      expect(() => inspect(cause, { getters: true })).not.toThrow();
      expect(deep(value)).not.toContain(PASS);
    }
  });

  it("masks values kept under a credential name", () => {
    const url = `https://h.example/y?sellerid=${KEYED}&page=2`;
    const causes: unknown[] = [
      new URLSearchParams({ sellerid: KEYED }),
      new URL(url).searchParams,
      { query: { sellerid: KEYED } },
      { headers: { SecretKey: KEYED, Authorization: KEYED } },
      { config: { headers: { Authorization: KEYED, SecretKey: KEYED, Cookie: KEYED } } },
      new Headers({ "x-secretkey": KEYED, "x-auth": KEYED, "x-api-key": KEYED, "api-key": KEYED }),
    ];
    for (const cause of causes) expect(deep(cause)).not.toContain(KEYED);
    const params = causeOf(new URLSearchParams({ sellerid: KEYED, page: "2" })) as URLSearchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("sellerid")).toBe("***");
  });

  it("covers encoded, header-line, JSON and bearer spellings", () => {
    const spellings = [
      `sellerid%3D${KEYED}`,
      `%73ellerid=${KEYED}`,
      `https%3A%2F%2Fh%2F%3Fsellerid%3D${KEYED}`,
      `Authorization: Bearer ${KEYED}`,
      `Authorization=Bearer ${KEYED}`,
      `SecretKey: ${KEYED}`,
      `{"SecretKey":"${KEYED}"}`,
      `client_secret=${KEYED}`,
      `refresh_token=${KEYED}`,
      `id_token=${KEYED}`,
      `access-token=${KEYED}`,
      `api-key=${KEYED}`,
      `x-api-key: ${KEYED}`,
    ];
    for (const text of spellings) expect(causeOf(text), text).not.toContain(KEYED);
    expect(causeOf(`Authorization=Bearer ${KEYED} next`)).toBe("Authorization=*** next");
  });

  it("stays linear on adversarial credential-looking text", () => {
    const shapes = [
      "token".repeat(60_000),
      "token ".repeat(60_000),
      "token=".repeat(60_000),
      `sellerid${" ".repeat(300_000)}x`,
      "%73".repeat(100_000),
      "Authorization: ".repeat(30_000),
    ];
    for (const text of shapes) {
      const started = performance.now();
      causeOf(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});
