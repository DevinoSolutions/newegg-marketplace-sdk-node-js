import { describe, expect, it } from "vitest";
import { createMockFetch } from "../src/testing/index.js";

describe("createMockFetch", () => {
  it("matches on method + string path substring and records the parsed body", async () => {
    const { fetch, calls } = createMockFetch([
      {
        method: "POST",
        pathPattern: "widgets",
        reply: () => ({ status: 200, body: { ok: true } }),
      },
    ]);
    const response = await fetch("https://example.com/api/widgets?x=1", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.bodyJson).toEqual({ a: 1 });
    expect(calls[0]!.url.searchParams.get("x")).toBe("1");
  });

  it("matches a RegExp against pathname + search", async () => {
    const { fetch } = createMockFetch([
      {
        method: "GET",
        pathPattern: /\/items\?page=2/,
        reply: () => ({ status: 200, body: { page: 2 } }),
      },
    ]);
    const response = await fetch("https://example.com/items?page=2");
    await expect(response.json()).resolves.toEqual({ page: 2 });
  });

  it("returns a 501 for unmatched requests", async () => {
    const { fetch } = createMockFetch([]);
    const response = await fetch("https://example.com/nope");
    expect(response.status).toBe(501);
  });

  it("passes response headers through", async () => {
    const { fetch } = createMockFetch([
      {
        method: "GET",
        pathPattern: "h",
        reply: () => ({ status: 200, body: {}, headers: { "X-RateLimit-Remaining": "5" } }),
      },
    ]);
    const response = await fetch("https://example.com/h");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("5");
  });
});
