import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NeweggApiError, NeweggError } from "../src/index.js";
import { redactUrlCredentials } from "../src/errors/redact.js";

// T-5665 (L1) and T-5666 (L2): URL-credential redaction must not be bound to one URL spelling, and
// a NeweggError's cause chain must not carry credentials into util.inspect / console.log output.

const USER = "LabelUser";
const PASS_A = "Zq7Kx";
const PASS_B = "9wLm";
const HOST = "ftp03.newegg.com";

/** Every fragment of the secret that must be gone from the output. */
function expectNoSecret(output: string): void {
  expect(output).not.toContain(USER);
  expect(output).not.toContain(PASS_A);
  expect(output).not.toContain(PASS_B);
}

// [label, input, whether the host must survive redaction]
const LEAKING_FORMS: Array<[string, string]> = [
  [
    "fully percent-encoded URL",
    `see ftp%3A%2F%2F${USER}%3A${PASS_A}${PASS_B}%40${HOST}%2Fx.pdf now`,
  ],
  ["lowercase percent-encoded URL", `ftp%3a%2f%2f${USER}%3a${PASS_A}${PASS_B}%40${HOST}%2fx.pdf`],
  ["scheme-relative //u:p@h", `fetch //${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf please`],
  ["schemeless u:p@h", `connect ${USER}:${PASS_A}${PASS_B}@${HOST} now`],
  ["schemeless u:p@h at the start", `${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["schemeless in a key=value", `url=${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["backslashes after the scheme", `ftp:\\\\${USER}:${PASS_A}${PASS_B}@${HOST}\\x.pdf`],
  ["triple slash", `ftp:///${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["encoded @ terminator (%40)", `ftp://${USER}:${PASS_A}${PASS_B}%40${HOST}/x.pdf`],
  ["HTML entity @ terminator (&#64;)", `ftp://${USER}:${PASS_A}${PASS_B}&#64;${HOST}/x.pdf`],
  ["HTML hex entity @ terminator (&#x40;)", `ftp://${USER}:${PASS_A}${PASS_B}&#x40;${HOST}/x.pdf`],
  ["fullwidth @ terminator", `ftp://${USER}:${PASS_A}${PASS_B}\uFF20${HOST}/x.pdf`],
  ["password containing /", `ftp://${USER}:${PASS_A}/${PASS_B}@${HOST}/x.pdf`],
  ["password containing ?", `ftp://${USER}:${PASS_A}?${PASS_B}@${HOST}/x.pdf`],
  ["password containing #", `ftp://${USER}:${PASS_A}#${PASS_B}@${HOST}/x.pdf`],
  ["password containing a double-quote", `ftp://${USER}:${PASS_A}"${PASS_B}@${HOST}/x.pdf`],
  ["single slash after the scheme", `ftp:/${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["single backslash after the scheme", `ftp:\\${USER}:${PASS_A}${PASS_B}@${HOST}\\x.pdf`],
  [
    "named entities (&colon; &sol; &commat;)",
    `ftp&colon;&sol;&sol;${USER}&colon;${PASS_A}${PASS_B}&commat;${HOST}/x.pdf`,
  ],
  ["&commat; terminator only", `ftp://${USER}:${PASS_A}${PASS_B}&commat;${HOST}/x.pdf`],
  [
    "numeric entities for the scheme separator (&#58; &#47;)",
    `ftp&#58;&#47;&#47;${USER}&#58;${PASS_A}${PASS_B}&#64;${HOST}/x.pdf`,
  ],
  ["padded numeric entity (&#058;)", `ftp&#058;//${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["double-encoded @ (%2540)", `ftp://${USER}:${PASS_A}${PASS_B}%2540${HOST}/x.pdf`],
  ["triple-encoded @ (%252540)", `ftp://${USER}:${PASS_A}${PASS_B}%252540${HOST}/x.pdf`],
  ["quintuple-encoded @ (%2525252540)", `ftp://${USER}:${PASS_A}${PASS_B}%2525252540${HOST}/x.pdf`],
  [
    "fully triple-encoded URL",
    `ftp%25253A%25252F%25252F${USER}%25253A${PASS_A}${PASS_B}%252540${HOST}%25252Fx.pdf`,
  ],
];

const COVERED_FORMS: Array<[string, string]> = [
  ["plain ftp", `ftp://${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["upper-case scheme", `FTP://${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["percent-encoded userinfo", `ftp://${USER}:${PASS_A}%40${PASS_B}@${HOST}/x.pdf`],
  ["JSON-escaped", `ftp:\\/\\/${USER}:${PASS_A}${PASS_B}@${HOST}\\/x.pdf`],
  ["https", `https://${USER}:${PASS_A}${PASS_B}@${HOST}/x.pdf`],
  ["two on one line", `ftp://a:${PASS_A}@h1 and ftp://${USER}:${PASS_B}@${HOST}/y`],
  ["nested in a query", `https://proxy.example/?u=ftp://${USER}:${PASS_A}${PASS_B}@${HOST}/x`],
];

const UNTOUCHED: Array<[string, string]> = [
  ["@ in a path", "https://files.newegg.com/a@b"],
  ["@ in a query", "https://files.newegg.com/x?email=a@b.com"],
  ["plain e-mail", "contact support at help@newegg.com for details"],
  ["time and colon text", "failed at 12:30 with code: 17"],
  ["encoded path", "https://files.newegg.com/dir%2Ffile%40x.csv?a=b%3Ac"],
  ["no URL at all", "Item not found: SKU-1"],
];

describe("redactUrlCredentials (T-5665 / L1)", () => {
  for (const [label, input] of [...LEAKING_FORMS, ...COVERED_FORMS]) {
    it(`redacts: ${label}`, () => {
      const out = redactUrlCredentials(input);
      expectNoSecret(out);
      expect(out).toContain("***@");
    });
  }

  it("keeps the host of a redacted URL so the message stays useful", () => {
    for (const [, input] of [...LEAKING_FORMS, ...COVERED_FORMS].slice(0, 12)) {
      expect(redactUrlCredentials(input)).toContain(HOST);
    }
  });

  for (const [label, input] of UNTOUCHED) {
    it(`leaves text without credentials alone: ${label}`, () => {
      expect(redactUrlCredentials(input)).toBe(input);
    });
  }

  it("is linear time on adversarial 500k-character inputs", () => {
    const size = 500_000;
    const shapes = [
      "a:".repeat(size / 2),
      "a://".repeat(size / 4),
      "a=".repeat(size / 2),
      "%40".repeat(Math.floor(size / 3)),
      "//".repeat(size / 2),
      `ftp://${"u:".repeat(size / 4)}`,
      `${"x".repeat(size - 10)}ftp://a:b`,
      "a:b ".repeat(size / 4),
      "ftp://a:".repeat(size / 8),
      "&#64;".repeat(size / 5),
    ];
    for (const shape of shapes) {
      const started = performance.now();
      redactUrlCredentials(shape);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe("NeweggError.cause (T-5666 / L2)", () => {
  const secretUrl = `boom ftp://${USER}:${PASS_A}${PASS_B}@${HOST}/x`;

  it("does not leak URL credentials through util.inspect of the cause chain", () => {
    const cause = new Error(secretUrl);
    const error = new NeweggApiError("download failed", { cause });
    expectNoSecret(inspect(error, { depth: 10 }));
    expectNoSecret(inspect({ wrapped: error }, { depth: 10 }));
  });

  it("redacts the stack of the cause, not only its message", () => {
    const cause = new Error(secretUrl);
    expect(cause.stack).toContain(PASS_A);
    const error = new NeweggApiError("download failed", { cause });
    const sanitized = error.cause as Error;
    expectNoSecret(sanitized.stack ?? "");
    expectNoSecret(inspect(error, { depth: 10 }));
  });

  it("sanitizes nested causes and string properties of the cause", () => {
    const inner = Object.assign(new Error(secretUrl), { url: `ftp://${USER}:${PASS_A}@${HOST}/` });
    const cause = new Error("outer", { cause: inner });
    const error = new NeweggError("api", "failed", { cause });
    expectNoSecret(inspect(error, { depth: 10 }));
  });

  it("sanitizes a string cause and a plain-object cause", () => {
    expectNoSecret(inspect(new NeweggError("api", "failed", { cause: secretUrl })));
    expectNoSecret(
      inspect(new NeweggError("api", "failed", { cause: { reason: secretUrl } }), { depth: 10 }),
    );
  });

  it("keeps the cause and its identity when there is nothing to redact", () => {
    const cause = new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
    const error = new NeweggError("api", "failed", { cause });
    expect(error.cause).toBe(cause);
  });

  it("keeps a sanitized Error cause (same class and name, redacted message)", () => {
    const error = new NeweggError("api", "failed", { cause: new RangeError(secretUrl) });
    expect(error.cause).toBeInstanceOf(RangeError);
    expect((error.cause as Error).message).toContain("***@");
  });
});

describe("NeweggError.cause covers every shape a cause can take (T-5666 review)", () => {
  const url = `ftp://${USER}:${PASS_A}${PASS_B}@${HOST}/x`;
  const leaks = (cause: unknown): string =>
    inspect(new NeweggError("api", "failed", { cause }), { depth: 12, showHidden: true });

  it("redacts the stack of a freshly built error, whose stack is an own accessor", () => {
    const cause = new Error(`boom ${url}`);
    expect(cause.stack).toContain(PASS_A);
    const sanitized = new NeweggError("api", "failed", { cause }).cause as Error;
    expectNoSecret(sanitized.stack ?? "");
    expectNoSecret(sanitized.message);
    // The clone keeps a (redacted) stack with its frames instead of silently losing it.
    expect(sanitized.stack).toContain("***@");
    expect(sanitized.stack).toMatch(/\n\s+at /);
    expectNoSecret(leaks(cause));
  });

  it("redacts a stack that was assigned as a plain string", () => {
    const cause = new Error("a");
    cause.stack = `Error: a\n    at ${url}`;
    expectNoSecret(leaks(cause));
  });

  it("recurses into the errors of an AggregateError", () => {
    const cause = new AggregateError(
      [new Error(url), new TypeError(`again ${url}`)],
      `many ${url}`,
    );
    const out = new NeweggError("api", "failed", { cause }).cause as AggregateError;
    expect(out).toBeInstanceOf(AggregateError);
    expect(out.errors).toHaveLength(2);
    expect(out.errors[1]).toBeInstanceOf(TypeError);
    expectNoSecret(leaks(cause));
  });

  it("recurses into arrays and plain objects that hold errors", () => {
    expectNoSecret(leaks([new Error(url), { deeper: [new Error(url)] }]));
    expectNoSecret(leaks({ err: new Error(url), meta: { link: url } }));
  });

  it("recurses into errors held by an error's own properties", () => {
    const cause = Object.assign(new Error("outer"), {
      errors: [new Error(url)],
      response: { request: { url } },
    });
    expectNoSecret(leaks(cause));
  });

  it("redacts a URL object, a Map, a Set and a Buffer", () => {
    expectNoSecret(leaks(new URL(url)));
    expectNoSecret(leaks(new Map([["u", url]])));
    expectNoSecret(leaks(new Map([[url, 1]])));
    expectNoSecret(leaks(new Set([url])));
    expectNoSecret(leaks(Buffer.from(url)));
  });

  it("redacts a class instance and the class instances an error points at", () => {
    class Holder {
      readonly link = url;
    }
    class Request {
      readonly path = url;
    }
    expectNoSecret(leaks(new Holder()));
    const cause = Object.assign(new Error("hi"), { response: { request: new Request() } });
    expectNoSecret(leaks(cause));
    expect(new NeweggError("api", "failed", { cause: new Holder() }).cause).toBeInstanceOf(Holder);
  });

  it("redacts accessor properties, non-enumerable properties and symbol keys", () => {
    const withGetter = new Error("m");
    Object.defineProperty(withGetter, "acc", { get: () => url, enumerable: true });
    Object.defineProperty(withGetter, "hidden", { value: url, enumerable: false });
    Object.defineProperty(withGetter, Symbol("s"), { value: url, enumerable: true });
    expectNoSecret(leaks(withGetter));
  });

  it("redacts the message of an Error subclass and keeps its class", () => {
    class MyError extends Error {
      constructor() {
        super(`bad ${url}`);
        this.name = "MyError";
      }
    }
    const out = new NeweggError("api", "failed", { cause: new MyError() }).cause;
    expect(out).toBeInstanceOf(MyError);
    expectNoSecret(leaks(new MyError()));
  });

  it("survives a cyclic cause, a throwing getter and a very large graph", () => {
    const cyclic: Record<string, unknown> = { url };
    cyclic.self = cyclic;
    expectNoSecret(leaks(cyclic));
    const throwing = new Error("m");
    Object.defineProperty(throwing, "boom", {
      get() {
        throw new Error("nope");
      },
      enumerable: true,
    });
    expect(() => leaks(throwing)).not.toThrow();
    const wide = Array.from({ length: 5000 }, (_, index) => ({ index, url }));
    const started = Date.now();
    expectNoSecret(leaks(wide));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
