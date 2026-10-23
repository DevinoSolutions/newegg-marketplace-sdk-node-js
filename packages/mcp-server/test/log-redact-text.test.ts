import { NeweggError } from "@devino/newegg-marketplace-sdk";
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

describe("redactLogText credential spellings (T-6267 review)", () => {
  it("covers encoded, header-line, JSON and bearer spellings and keeps a comma", () => {
    const spellings = [
      "sellerid%3DSEKRIT",
      "%73ellerid=SEKRIT",
      "https%3A%2F%2Fh%2F%3Fsellerid%3DSEKRIT",
      "Authorization: Bearer SEKRIT",
      "Authorization=Bearer SEKRIT",
      "SecretKey: SEKRIT",
      '{"SecretKey":"SEKRIT"}',
      "client_secret=SEKRIT",
      "refresh_token=SEKRIT",
      "id_token=SEKRIT",
      "access-token=SEKRIT",
      "api-key=SEKRIT",
      "x-api-key: SEKRIT",
    ];
    for (const text of spellings) expect(redactLogText(text), text).not.toContain("SEKRIT");
    expect(redactLogText("token=abc, next")).toBe("token=[redacted], next");
  });

  it("stays linear on adversarial text", () => {
    const shapes = [
      "token ".repeat(60_000),
      "%73".repeat(100_000),
      `sellerid${" ".repeat(300_000)}x`,
    ];
    for (const text of shapes) {
      const started = performance.now();
      redactLogText(text);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });

  it("covers the same credential names as the SDK cause redaction", () => {
    const names = [
      "sellerid",
      "seller_id",
      "secretkey",
      "secret_key",
      "x-secret-key",
      "apikey",
      "api_key",
      "api-key",
      "x-api-key",
      "authorization",
      "proxy-authorization",
      "x-auth",
      "x-auth-token",
      "auth_token",
      "access_token",
      "access-token",
      "refresh_token",
      "id_token",
      "client_secret",
      "token",
      "password",
      "passwd",
      "secret",
    ];
    for (const name of names) {
      const text = `${name}=SEKRIT`;
      expect(redactLogText(text), name).not.toContain("SEKRIT");
      const cause = new NeweggError("api", "x", { cause: text }).cause as string;
      expect(cause, name).not.toContain("SEKRIT");
    }
  });
});
