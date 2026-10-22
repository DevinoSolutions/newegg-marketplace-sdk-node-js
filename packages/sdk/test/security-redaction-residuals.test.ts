import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NeweggError } from "../src/index.js";
import { redactUrlCredentials } from "../src/errors/redact.js";

// T-6111: residual leak shapes from the PR #56 review. A NeweggError cause must not print URL
// credentials when they sit in a function's own properties, URLSearchParams, Headers, an object
// with #private fields or a fetch Response / Request; and the redaction patterns must not stop at
// an arbitrary length while staying linear.

const USER = "LabelUser";
const PASS = "Zq7Kx9wLm";
// Built from parts: a bare host name string reads as an unescaped host regexp to static analysis.
const HOST = ["ftp03", "newegg", "com"].join(".");
const URL_WITH_SECRET = `ftp://${USER}:${PASS}@${HOST}/x`;

function expectNoSecret(output: string): void {
  expect(output).not.toContain(USER);
  expect(output).not.toContain(PASS);
}

const render = (cause: unknown): string =>
  inspect(new NeweggError("api", "failed", { cause }), { depth: 12, showHidden: true });

const causeOf = (cause: unknown): unknown => new NeweggError("api", "failed", { cause }).cause;

describe("function-valued causes (T-6111 item 1)", () => {
  it("redacts the own properties of a function cause and keeps it callable", () => {
    const original = Object.assign(
      function failedRequest(value: number): number {
        return value + 1;
      },
      { url: URL_WITH_SECRET },
    );
    expectNoSecret(render(original));
    const sanitized = causeOf(original) as typeof original;
    expect(typeof sanitized).toBe("function");
    expect(sanitized.name).toBe("failedRequest");
    expect(sanitized(1)).toBe(2);
    expect(sanitized.url).toContain("***@");
    // The original is never mutated.
    expect(original.url).toBe(URL_WITH_SECRET);
  });

  it("redacts a function held by an error property or by a plain object", () => {
    const handler = Object.assign(() => undefined, { target: { href: URL_WITH_SECRET } });
    expectNoSecret(render(Object.assign(new Error("outer"), { handler })));
    expectNoSecret(render({ nested: [{ handler }] }));
  });

  it("returns a function with nothing to redact as it is", () => {
    const fn = Object.assign(() => undefined, { retries: 3, label: "plain" });
    expect(causeOf(fn)).toBe(fn);
  });

  it("does not treat a function's own prototype object as a secret holder", () => {
    function Plain(): void {}
    expect(causeOf(Plain)).toBe(Plain);
    class Klass {
      static readonly link = URL_WITH_SECRET;
    }
    expectNoSecret(render(Klass));
  });
});

describe("URLSearchParams and Headers (T-6111 item 1)", () => {
  it("redacts a URL carried in URLSearchParams", () => {
    const params = new URLSearchParams({ next: URL_WITH_SECRET, other: "1" });
    expect(inspect(params)).toContain(PASS);
    expectNoSecret(render(params));
    const sanitized = causeOf(params) as URLSearchParams;
    expect(sanitized).toBeInstanceOf(URLSearchParams);
    expect(sanitized.get("next")).toContain("***@");
    expect(sanitized.get("other")).toBe("1");
    expect(params.get("next")).toBe(URL_WITH_SECRET);
  });

  it("redacts a URL carried in Headers", () => {
    const headers = new Headers({ "x-link": URL_WITH_SECRET, accept: "text/plain" });
    expect(inspect(headers)).toContain(PASS);
    expectNoSecret(render(headers));
    const sanitized = causeOf(headers) as Headers;
    expect(sanitized).toBeInstanceOf(Headers);
    expect(sanitized.get("x-link")).toContain("***@");
    expect(sanitized.get("accept")).toBe("text/plain");
    expect(headers.get("x-link")).toBe(URL_WITH_SECRET);
  });

  it("reaches them through properties of an error and of plain objects", () => {
    const params = new URLSearchParams({ next: URL_WITH_SECRET });
    const headers = new Headers({ "x-link": URL_WITH_SECRET });
    expectNoSecret(render(Object.assign(new Error("e"), { params, headers })));
    expectNoSecret(render({ request: { headers, query: params } }));
  });

  it("returns them as they are when there is nothing to redact", () => {
    const params = new URLSearchParams({ page: "2" });
    const headers = new Headers({ accept: "text/plain" });
    expect(causeOf(params)).toBe(params);
    expect(causeOf(headers)).toBe(headers);
  });
});

describe("keys and own properties of the rebuilt objects (T-6111 review)", () => {
  it("redacts a URLSearchParams KEY as well as its values", () => {
    const params = new URLSearchParams([[URL_WITH_SECRET, "1"]]);
    expectNoSecret(render(params));
    const sanitized = causeOf(params) as URLSearchParams;
    expect([...sanitized.keys()].join(",")).not.toContain(PASS);
    expect(sanitized.get("x")).toBeNull();
    expect([...params.keys()]).toEqual([URL_WITH_SECRET]);
  });

  it("redacts own enumerable properties of URLSearchParams and Headers, and keeps them readable", () => {
    const params = Object.assign(new URLSearchParams({ page: "2" }), { link: URL_WITH_SECRET });
    const headers = Object.assign(new Headers({ accept: "text/plain" }), { link: URL_WITH_SECRET });
    for (const original of [params, headers]) {
      const sanitized = causeOf(original) as typeof original & { link: string };
      expect(sanitized.link).toContain("***@");
      expectNoSecret(JSON.stringify(sanitized));
      expectNoSecret(render(original));
    }
    expect((causeOf(headers) as Headers).get("accept")).toBe("text/plain");
    expect((causeOf(params) as URLSearchParams).get("page")).toBe("2");
  });

  it("does not leave a secret property on a Response or Request that is kept or replaced", () => {
    for (const original of [
      Object.assign(new Response("body"), { link: URL_WITH_SECRET }),
      Object.assign(new Request("https://example.com/y"), { link: URL_WITH_SECRET }),
    ]) {
      const sanitized = causeOf(original);
      expectNoSecret(JSON.stringify(sanitized));
      expectNoSecret(typeof sanitized === "string" ? sanitized : render(sanitized));
      expect((sanitized as { link?: string }).link ?? "").not.toContain(PASS);
    }
  });
});

describe("objects whose clone would break (T-6111 item 2)", () => {
  class WithPrivate {
    readonly link = URL_WITH_SECRET;
    #count = 3;
    get count(): number {
      return this.#count;
    }
  }

  it("does not throw on an object with #private fields and still hides the secret", () => {
    const original = new WithPrivate();
    expect(() => render(original)).not.toThrow();
    expectNoSecret(render(original));
    expect(() => causeOf(original)).not.toThrow();
    // Whatever replaces it must not be a copy whose getters throw "Cannot read private member".
    const sanitized = causeOf(original) as WithPrivate;
    expect(() => sanitized.count).not.toThrow();
    expect(() => inspect(sanitized, { getters: true })).not.toThrow();
    expect(original.link).toBe(URL_WITH_SECRET);
    expect(original.count).toBe(3);
  });

  it("does not throw on an Error subclass with #private fields", () => {
    class PrivateError extends Error {
      #code = 7;
      get code(): number {
        return this.#code;
      }
    }
    const original = Object.assign(new PrivateError(`bad ${URL_WITH_SECRET}`), {
      url: URL_WITH_SECRET,
    });
    expect(() => render(original)).not.toThrow();
    expectNoSecret(render(original));
    const sanitized = causeOf(original) as PrivateError;
    expect(() => sanitized.code).not.toThrow();
    expect(() => inspect(sanitized, { getters: true })).not.toThrow();
  });

  it("keeps an object with #private fields and nothing to redact as it is", () => {
    class Clean {
      #n = 1;
      get n(): number {
        return this.#n;
      }
    }
    const clean = new Clean();
    expect(causeOf(clean)).toBe(clean);
  });

  it("redacts a Response without throwing (headers, statusText, own property)", () => {
    const withHeader = new Response("body", { headers: { "x-link": URL_WITH_SECRET } });
    expect(() => render(withHeader)).not.toThrow();
    expectNoSecret(render(withHeader));
    const sanitized = causeOf(withHeader) as Response;
    expect(() => sanitized.status).not.toThrow();
    expect(() => inspect(sanitized, { getters: true })).not.toThrow();

    const withStatusText = new Response("", { status: 502, statusText: `see ${URL_WITH_SECRET}` });
    expect(() => render(withStatusText)).not.toThrow();
    expectNoSecret(render(withStatusText));

    const withProperty = Object.assign(new Response("body"), { link: URL_WITH_SECRET });
    expect(() => render(withProperty)).not.toThrow();
    expectNoSecret(render(withProperty));
  });

  it("redacts a Request without throwing", () => {
    const request = new Request("https://example.com/x", {
      method: "POST",
      body: "payload",
      headers: { "x-link": URL_WITH_SECRET },
    });
    expect(() => render(request)).not.toThrow();
    expectNoSecret(render(request));
    const property = Object.assign(new Request("https://example.com/y"), { link: URL_WITH_SECRET });
    expect(() => render(property)).not.toThrow();
    expectNoSecret(render(property));
  });

  it("reaches a Response held by an error property", () => {
    const response = new Response("", { headers: { "x-link": URL_WITH_SECRET } });
    expectNoSecret(render(Object.assign(new Error("fetch failed"), { response })));
  });

  it("keeps a Response and a Request with nothing to redact as they are", () => {
    const response = new Response("ok", { headers: { accept: "text/plain" } });
    const request = new Request("https://example.com/z");
    expect(causeOf(response)).toBe(response);
    expect(causeOf(request)).toBe(request);
  });
});

describe("credential patterns have no length limit (T-6111 item 5)", () => {
  const LONG = "p".repeat(5000);

  it("redacts a scheme URL whose userinfo or password is far longer than 2048 characters", () => {
    expect(redactUrlCredentials(`see ftp://${USER}:${LONG}@${HOST}/x now`)).toBe(
      `see ftp://***@${HOST}/x now`,
    );
    expect(redactUrlCredentials(`https://${"u".repeat(5000)}@${HOST}/x`)).toBe(
      `https://***@${HOST}/x`,
    );
    expect(redactUrlCredentials(`ftp://${USER}:${"p@".repeat(3000)}z@${HOST}/x`)).toBe(
      `ftp://***@${HOST}/x`,
    );
  });

  it("redacts a single-slash scheme URL with a user longer than 256 characters", () => {
    expect(redactUrlCredentials(`ftp:/${"u".repeat(400)}:${LONG}@${HOST}/x`)).toBe(
      `ftp:/***@${HOST}/x`,
    );
  });

  it("redacts a password holding reserved characters beyond 256 characters", () => {
    const password = "ab/c?d#e".repeat(200);
    expect(redactUrlCredentials(`x ftp://${USER}:${password}@${HOST}/x y`)).toBe(
      `x ftp://***@${HOST}/x y`,
    );
  });

  it("redacts a scheme-relative credential with a user over 256 and a password over 2048", () => {
    expect(redactUrlCredentials(`fetch //${"u".repeat(400)}:${LONG}@${HOST}/x`)).toBe(
      `fetch //***@${HOST}/x`,
    );
  });

  it("redacts a schemeless credential with a long user, password and host label", () => {
    expect(redactUrlCredentials(`go ${"u".repeat(300)}:${LONG}@${HOST}/x`)).toBe(
      `go ***@${HOST}/x`,
    );
    const longHost = `ftp${"a".repeat(300)}.newegg.com`;
    expect(redactUrlCredentials(`go ${USER}:${PASS}@${longHost}/x`)).toBe(`go ***@${longHost}/x`);
  });

  it("still leaves look-alikes alone", () => {
    const samples = [
      `https://example.com/${"a".repeat(5000)}@b`,
      `${"u".repeat(300)}:${LONG}@example.org/x`,
      `contact ${"u".repeat(300)}@example.com`,
      `//${"u".repeat(400)}@example.com/x`,
    ];
    for (const sample of samples) expect(redactUrlCredentials(sample)).toBe(sample);
  });
});

/** The fastest of `runs` timings: discards scheduler and GC noise on a busy runner. */
function bestOf(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("lifted limits stay linear (T-6111 item 5, CodeQL js/polynomial-redos)", () => {
  /** `unit` repeated until it is at least `size` characters long. */
  const repeated = (unit: string) => (size: number) => unit.repeat(Math.ceil(size / unit.length));
  const shapes: Array<[string, (size: number) => string]> = [
    ["password region shared by many candidates", (size) => `${repeated("u:,")(size)}@${HOST}`],
    ["schemeless candidates, one far @", (size) => `${repeated("a:b ")(size)}@${HOST}`],
    ["schemeless @ runs", (size) => `x:${"@".repeat(size)}`],
    ["scheme candidates, one far @", (size) => `${repeated("a://x")(size)}@${HOST}`],
    ["scheme candidates with spaces", (size) => `${repeated("a:// ")(size)}@${HOST}`],
    ["reserved password candidates", (size) => `${repeated("ftp://a/b ")(size)}@${HOST}`],
    ["single-slash candidates", (size) => `${repeated("a:/b:")(size)}@${HOST}`],
    ["scheme-relative candidates", (size) => `${repeated("//u:")(size)}@${HOST}`],
    ["long host runs behind many @", (size) => `x:${repeated(`@${"a.".repeat(40)}`)(size)}`],
    ["@ followed by newegg hosts", (size) => `x:${repeated(`@a.${HOST}`)(size)}`],
    ["one long userinfo run", (size) => `ftp://${repeated("u:")(size)}`],
    ["one long schemeless password", (size) => `u:${"p".repeat(size)}`],
    // No whitespace anywhere: the whole input is ONE run for the reserved-password pass.
    [
      "no-whitespace run, a Newegg host after each @",
      (size) => repeated(`a://p/w@x.${HOST},`)(size),
    ],
    ["no-whitespace run, @ then ? and a host", (size) => repeated(`ftp://?@x.${HOST}@,:`)(size)],
    ["no-whitespace run, doubled @ and a quote", (size) => repeated(`p@@ftp.${HOST}"a:\\`)(size)],
    ["no-whitespace run, no host at all", (size) => repeated("a://p/w@x.example,")(size)],
  ];

  const SMALL = 200_000;
  const LARGE = 1_600_000;

  it("takes time proportional to the input, not its square", { timeout: 300_000 }, () => {
    for (const [name, make] of shapes) {
      redactUrlCredentials(make(20_000)); // warm up
      const small = make(SMALL);
      const large = make(LARGE);
      // At least 2 ms, so a sub-millisecond reading cannot make the cap meaningless.
      const smallMs = Math.max(
        bestOf(5, () => redactUrlCredentials(small)),
        2,
      );
      const largeMs = bestOf(5, () => redactUrlCredentials(large));
      // 8x the input: linear is about 8x (cap 24x); a quadratic scan is about 64x.
      expect(largeMs, `${name}: ratio`).toBeLessThan(smallMs * 24);
      // A backstop for the ratio: linear takes well under a second at 1.6M characters.
      expect(largeMs, `${name}: absolute`).toBeLessThan(3000);
    }
  });
});
