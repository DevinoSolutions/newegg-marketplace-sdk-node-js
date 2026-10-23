import { describe, expect, it } from "vitest";
import { redactLogText } from "../src/tools/log-redact.js";

// T-6267: query strings in text that is not a scheme:// URL.

describe("redactLogText query strings without a scheme", () => {
  it("redacts a request line with a bare path and query", () => {
    const out = redactLogText("GET /x?sellerid=SECRET-SELLER&page=2 HTTP/1.1");
    expect(out).not.toContain("SECRET-SELLER");
    expect(out).toContain("HTTP/1.1");
  });

  it("redacts the query when a space precedes the question mark", () => {
    const out = redactLogText(
      "failed https://x.example/y ?sellerid=SECRET-SELLER&token=SECRET-TOKEN end",
    );
    expect(out).not.toContain("SECRET-SELLER");
    expect(out).not.toContain("SECRET-TOKEN");
    expect(out.endsWith(" end")).toBe(true);
  });

  it("leaves prose with a question mark alone", () => {
    expect(redactLogText("is it ready? yes")).toBe("is it ready? yes");
  });
});
