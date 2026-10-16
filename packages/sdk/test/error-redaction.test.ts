import { describe, expect, it } from "vitest";
import { NeweggApiError, NeweggError } from "../src/index.js";
import { parseUpstreamBody, parseUpstreamError } from "../src/errors/parse-upstream.js";
import { redactUrlCredentials, sanitizeRaw } from "../src/errors/redact.js";
import { makeClient, paths } from "./helpers.js";

const FTP_URL = "ftp://LabelUser:Pa55word@ftp03.newegg.com/x.pdf";
const HTTPS_URL = "https://LabelUser:Pa55word@files.newegg.com/x.pdf";

function bodyFor(format: "object" | "array" | "xml" | "text", url: string): string {
  const message = `Label ready at ${url} - download it`;
  switch (format) {
    case "object":
      return JSON.stringify({ Code: "CT002", Message: message });
    case "array":
      return JSON.stringify([{ Code: "CT002", Message: message }]);
    case "xml":
      return `<?xml version="1.0"?><Error><Code>CT002</Code><Message>${message}</Message></Error>`;
    case "text":
      return message;
  }
}

function expectNoCredentials(serialized: string, host: string): void {
  expect(serialized).not.toContain("Pa55word");
  expect(serialized).not.toContain("LabelUser");
  expect(serialized).toContain(host);
  expect(serialized).toContain("***@");
}

describe("upstream error redaction", () => {
  for (const format of ["object", "array", "xml", "text"] as const) {
    for (const [label, url, host] of [
      ["ftp", FTP_URL, "ftp03.newegg.com"],
      ["https", HTTPS_URL, "files.newegg.com"],
    ] as const) {
      it(`redacts a ${label} URL with credentials from a ${format} error body`, async () => {
        const { client } = makeClient("ca", [
          {
            method: "GET",
            pathPattern: paths.serviceStatus,
            reply: () => ({ status: 400, body: bodyFor(format, url) }),
          },
        ]);
        const error: unknown = await client.service.getStatus().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(NeweggError);
        const thrown = error as NeweggError;
        expectNoCredentials(JSON.stringify(thrown), host);
        expectNoCredentials(JSON.stringify(thrown.toJSON()), host);
        expect(thrown.message).not.toContain("Pa55word");
      });
    }
  }

  it("redacts when the credential would be split by the 500-char clip", () => {
    const body = `${"x".repeat(480)} ${FTP_URL}`;
    const serialized = JSON.stringify(parseUpstreamBody(body));
    expect(serialized).not.toContain("Pa55word");
    expect(serialized).not.toContain("LabelUser");
    expect(serialized).not.toContain("ftp://Label");
    expect(serialized).not.toContain("Pa5");
  });

  it("redacts credentials that only become visible after unescaping", () => {
    const entries = parseUpstreamBody(
      '{"Message":"see ftp://LabelUser:Pa55word\\u0040ftp03.newegg.com/x.pdf"}',
    );
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("Pa55word");
    expect(serialized).toContain("***@ftp03.newegg.com");
    expect(serialized).toContain("ftp03.newegg.com");
  });

  it("redacts a JSON-escaped URL inside an invalid-JSON body", () => {
    const entries = parseUpstreamBody(
      '{"Message": "ftp:\\/\\/LabelUser:Pa55word@ftp03.newegg.com\\/x',
    );
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("Pa55word");
    expect(serialized).toContain("ftp03.newegg.com");
  });

  it("redacts a password that itself contains an @", () => {
    expect(redactUrlCredentials("ftp://LabelUser:Pa@55word@ftp03.newegg.com/x.pdf")).toBe(
      "ftp://***@ftp03.newegg.com/x.pdf",
    );
  });

  it("redacts a URL glued to a word character", () => {
    expect(redactUrlCredentials("link_ftp://u:p@h/x")).toBe("link_ftp://***@h/x");
    expect(redactUrlCredentials("1ftp://u:p@h")).toBe("1ftp://***@h");
  });

  it("does not swallow text after a JSON-escaped line break", () => {
    const s = "ftp:\\/\\/h.example.com\\ncontact:a@b.com";
    expect(redactUrlCredentials(s)).toBe(s);
  });

  it("keeps the parsed code usable for classification", () => {
    const error = parseUpstreamError(400, bodyFor("object", FTP_URL), new Headers(), {
      correlationId: "cid",
    });
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBe("CT002");
  });

  it("redacts message and details handed straight to an error class", () => {
    const error = new NeweggApiError(`failed fetching ${FTP_URL}`, {
      details: { message: `see ${FTP_URL}`, nested: [{ url: HTTPS_URL }] },
    });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain("Pa55word");
    expect(serialized).not.toContain("LabelUser");
    expect(error.message).toContain("ftp03.newegg.com");
  });
});

describe("redactUrlCredentials", () => {
  it("leaves URLs without credentials untouched", () => {
    const samples = [
      "https://www.newegg.com/p/N82E16820000000",
      "https://apis.newegg.com/marketplace/contentmgmt/item/inventory?sellerid=A006",
      "ftp://ftp03.newegg.com/x.pdf",
      "https://example.com/path/@user/profile",
      "https://example.com?email=a@b.com",
      "https://example.com/#frag@x",
      "mailto:someone@example.com",
      "contact someone@example.com or see http://example.com",
      "",
      "plain text with no url",
    ];
    for (const sample of samples) expect(redactUrlCredentials(sample)).toBe(sample);
  });

  it("redacts every credentialed URL in a string and keeps the rest", () => {
    expect(redactUrlCredentials(`a ${FTP_URL} b ${HTTPS_URL} c https://www.newegg.com/x`)).toBe(
      "a ftp://***@ftp03.newegg.com/x.pdf b https://***@files.newegg.com/x.pdf c https://www.newegg.com/x",
    );
  });

  it("does not throw on odd input", () => {
    const hostile = ["://@", "ftp://@", "a:////@@@", "@".repeat(100_000), "a.".repeat(100_000)];
    for (const text of hostile) expect(() => redactUrlCredentials(text)).not.toThrow();
    expect(redactUrlCredentials(undefined as unknown as string)).toBeUndefined();
    expect(redactUrlCredentials(42 as unknown as string)).toBe(42);
  });
});

describe("sanitizeRaw", () => {
  it("redacts nested strings and preserves other values", () => {
    const date = new Date(0);
    const out = sanitizeRaw({ a: [FTP_URL, 1, null, true], d: date, n: { u: HTTPS_URL } }) as {
      a: unknown[];
      d: Date;
      n: { u: string };
    };
    expect(out.a).toEqual(["ftp://***@ftp03.newegg.com/x.pdf", 1, null, true]);
    expect(out.d).toBe(date);
    expect(out.n.u).toBe("https://***@files.newegg.com/x.pdf");
  });

  it("survives cyclic and very deep structures", () => {
    const cyclic: Record<string, unknown> = { url: FTP_URL };
    cyclic.self = cyclic;
    expect(() => sanitizeRaw(cyclic)).not.toThrow();
    let deep: unknown = FTP_URL;
    for (let i = 0; i < 5_000; i++) deep = { deep };
    expect(() => sanitizeRaw(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeRaw(cyclic))).not.toContain("Pa55word");
  });

  it("does not mark a shared (non-cyclic) reference as circular", () => {
    const shared = { u: FTP_URL };
    const out = sanitizeRaw({ a: shared, b: shared }) as { a: { u: string }; b: { u: string } };
    expect(out.a.u).toBe("ftp://***@ftp03.newegg.com/x.pdf");
    expect(out.b.u).toBe("ftp://***@ftp03.newegg.com/x.pdf");
  });
});
