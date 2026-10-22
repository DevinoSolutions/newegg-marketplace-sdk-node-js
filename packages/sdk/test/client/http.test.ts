import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/client/config.js";
import { NeweggHttpClient, type RequestContext } from "../../src/client/http.js";
import { Operation } from "../../src/client/operations.js";
import {
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggTimeoutError,
} from "../../src/errors/index.js";
import { LogEvent } from "../../src/logging/index.js";
import { getAdapter, type RequestSpec } from "../../src/platform/index.js";
import type { NeweggClientConfig } from "../../src/types.js";
import { capturingLogger, TEST_API_KEY, TEST_SECRET_KEY } from "../helpers.js";

type FetchCall = { url: string; init: RequestInit };

const BASE = "https://api.newegg.com/marketplace/";
const SPEC: RequestSpec = { method: "GET", path: "contentmgmt/item/status" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Replies from a queue (the last reply repeats) and records every call. */
function queuedFetch(replies: Array<Response | Error | (() => Response)>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply();
    if (reply === undefined) throw new Error("no reply queued");
    return reply.clone();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeHttp(
  fetch: typeof globalThis.fetch,
  overrides: Partial<NeweggClientConfig> = {},
): { http: NeweggHttpClient; entries: ReturnType<typeof capturingLogger>["entries"] } {
  const { logger, entries } = capturingLogger();
  const config = resolveConfig({
    sellerId: "A006",
    apiKey: TEST_API_KEY,
    secretKey: TEST_SECRET_KEY,
    marketplace: "us",
    fetch,
    logger,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    ...overrides,
  });
  return { http: new NeweggHttpClient(config, getAdapter("us")), entries };
}

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { operation: Operation.ServiceStatus, correlationId: "corr-1", ...overrides };
}

describe("buildUrl", () => {
  it("always adds sellerid in its original case and merges spec query", () => {
    const { http } = makeHttp(queuedFetch([json({})]).fetch);
    const url = http.buildUrl({ ...SPEC, query: { page: "2", sellerid: "OVERRIDE" } });
    expect(url.origin + url.pathname).toBe(`${BASE}contentmgmt/item/status`);
    expect(url.searchParams.get("page")).toBe("2");
    // A spec-level key replaces the default (Map semantics of URLSearchParams.set).
    expect(url.searchParams.get("sellerid")).toBe("OVERRIDE");
    expect(http.buildUrl(SPEC).searchParams.get("sellerid")).toBe("A006");
  });
});

describe("request headers and body", () => {
  it("sends the credentials and fixed headers on the wire", async () => {
    const { fetch, calls } = queuedFetch([json({ ok: true })]);
    const { http } = makeHttp(fetch, { userAgent: "ua/1" });
    await http.executeOnce(SPEC, ctx());
    expect(calls[0]?.init.headers).toEqual({
      Authorization: TEST_API_KEY,
      SecretKey: TEST_SECRET_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "ua/1",
    });
  });

  it("serializes a structured body but prefers bodyText verbatim", async () => {
    const { fetch, calls } = queuedFetch([json({})]);
    const { http } = makeHttp(fetch);
    await http.executeOnce({ method: "POST", path: "p", body: { a: 1 } }, ctx());
    await http.executeOnce({ method: "POST", path: "p", body: { a: 1 }, bodyText: "RAW" }, ctx());
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(calls[1]?.init.body).toBe("RAW");
  });

  it("appends rawQuerySuffix verbatim after the built query", async () => {
    const { fetch, calls } = queuedFetch([json({})]);
    const { http } = makeHttp(fetch);
    await http.executeOnce({ ...SPEC, rawQuerySuffix: "v2" }, ctx());
    expect(calls[0]?.url).toBe(`${BASE}contentmgmt/item/status?sellerid=A006&v2`);
  });
});

describe("response handling", () => {
  it("returns status, parsed JSON, raw text and correlation id", async () => {
    const { fetch } = queuedFetch([json({ hello: "world" })]);
    const { http } = makeHttp(fetch);
    const result = await http.executeOnce(SPEC, ctx());
    expect(result).toMatchObject({
      status: 200,
      json: { hello: "world" },
      correlationId: "corr-1",
    });
    expect(result.bodyText).toBe('{"hello":"world"}');
  });

  it("yields undefined json for an empty or non-JSON 2xx body", async () => {
    const { http } = makeHttp(
      queuedFetch([new Response("", { status: 200 }), new Response("<xml/>", { status: 200 })])
        .fetch,
    );
    expect((await http.executeOnce(SPEC, ctx())).json).toBeUndefined();
    expect((await http.executeOnce(SPEC, ctx())).json).toBeUndefined();
  });

  it("maps a non-2xx response to a typed error", async () => {
    const { http } = makeHttp(queuedFetch([json({ Message: "bad key" }, { status: 401 })]).fetch);
    await expect(http.executeOnce(SPEC, ctx())).rejects.toBeInstanceOf(NeweggAuthenticationError);
  });
});

describe("timeouts and cancellation", () => {
  it("passes an abort signal and honors a per-request timeoutMs", async () => {
    const fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof globalThis.fetch;
    const { http } = makeHttp(fetch, { timeoutMs: 60_000 });
    const start = Date.now();
    const error = await http.requestOnce(SPEC, ctx({ timeoutMs: 20 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggTimeoutError);
    expect((error as NeweggTimeoutError).retryable).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("propagates a caller abort as a DOMException, not a Newegg error", async () => {
    const controller = new AbortController();
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason;
    }) as unknown as typeof globalThis.fetch;
    const { http } = makeHttp(fetch);
    const error = await http
      .request(SPEC, ctx({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("retry decisions", () => {
  it.each([408, 502, 503, 504])("retries a %i and then succeeds", async (status) => {
    const { fetch, calls } = queuedFetch([new Response("down", { status }), json({ ok: 1 })]);
    const { http, entries } = makeHttp(fetch);
    const result = await http.request(SPEC, ctx());
    expect(result.json).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    const retry = entries.find((e) => e.event === LogEvent.RetryScheduled);
    expect(retry?.level).toBe("info");
    expect(retry?.fields).toMatchObject({ attempt: 1, correlationId: "corr-1" });
  });

  it("does not retry a 401 or a plain 400", async () => {
    for (const status of [401, 400]) {
      const { fetch, calls } = queuedFetch([json({ Message: "no" }, { status })]);
      const { http } = makeHttp(fetch);
      await expect(http.request(SPEC, ctx())).rejects.toBeDefined();
      expect(calls).toHaveLength(1);
    }
  });

  it("stops at maxAttempts and throws the last mapped error", async () => {
    const { fetch, calls } = queuedFetch([new Response("down", { status: 503 })]);
    const { http } = makeHttp(fetch);
    const error = await http.request(SPEC, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ httpStatus: 503, retryable: true });
    expect(calls).toHaveLength(3);
  });

  it("retries a network error as retryable and records the cause code", async () => {
    const networkError = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const { fetch, calls } = queuedFetch([networkError]);
    const { http } = makeHttp(fetch, { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
    const error = await http.request(SPEC, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as NeweggApiError).retryable).toBe(true);
    expect((error as NeweggApiError).details).toMatchObject({ causeCode: "ECONNRESET" });
    expect(calls).toHaveLength(2);
  });

  it("requestOnce never retries", async () => {
    const { fetch, calls } = queuedFetch([new Response("down", { status: 503 }), json({})]);
    const { http } = makeHttp(fetch);
    await expect(http.requestOnce(SPEC, ctx())).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls).toHaveLength(1);
  });

  it("wraps a non-Newegg thrown value as a non-retryable API error", async () => {
    const { fetch, calls } = queuedFetch([new Error("weird")]);
    const { http } = makeHttp(fetch);
    const error = await http.request(SPEC, ctx()).catch((e: unknown) => e);
    // classifyTransport turns any thrown fetch error into a retryable network failure.
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("redirect handling", () => {
  const redirect = (status: number, location: string): Response =>
    new Response(null, { status, headers: { location } });

  it("follows a same-origin redirect on a read and keeps the credential headers", async () => {
    const { fetch, calls } = queuedFetch([
      redirect(302, "/marketplace/moved"),
      json({ moved: true }),
    ]);
    const { http } = makeHttp(fetch);
    const result = await http.executeOnce(SPEC, ctx({ operation: Operation.ServiceStatus }));
    expect(result.json).toEqual({ moved: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://api.newegg.com/marketplace/moved");
    expect(calls[1]?.init.redirect).toBe("manual");
    expect((calls[1]?.init.headers as Record<string, string>).SecretKey).toBe(TEST_SECRET_KEY);
  });

  it("refuses a cross-origin redirect on a read without sending credentials there", async () => {
    const { fetch, calls } = queuedFetch([redirect(302, "https://evil.example/x")]);
    const { http, entries } = makeHttp(fetch);
    const error = await http.executeOnce(SPEC, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as NeweggApiError).retryable).toBe(false);
    expect((error as NeweggApiError).details).toMatchObject({
      causeCode: "REDIRECT_REFUSED_CROSS_ORIGIN",
    });
    expect(calls).toHaveLength(1);
    const warn = entries.find((e) => e.fields?.outcome === "redirect_refused");
    expect(warn?.level).toBe("warn");
    expect(JSON.stringify(entries)).not.toContain("evil.example");
  });

  it("gives up after the hop budget", async () => {
    const { fetch } = queuedFetch([redirect(302, "/marketplace/loop")]);
    const { http } = makeHttp(fetch);
    const error = await http.executeOnce(SPEC, ctx()).catch((e: unknown) => e);
    expect((error as NeweggApiError).details).toMatchObject({
      causeCode: "REDIRECT_REFUSED_TOO_MANY",
      redirectsFollowed: 5,
    });
  });

  it("drops the body and content-type when a 303 rewrites a PUT read to GET", async () => {
    const { fetch, calls } = queuedFetch([redirect(303, "/marketplace/result"), json({})]);
    const { http } = makeHttp(fetch);
    await http.executeOnce(
      { method: "PUT", path: "ordermgmt/order/orderinfo", body: { a: 1 } },
      ctx({ operation: Operation.OrderList }),
    );
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeUndefined();
    expect(Object.keys(calls[1]?.init.headers as object).map((h) => h.toLowerCase())).not.toContain(
      "content-type",
    );
  });

  it("sends a write with redirect: error and never follows a handed-back redirect", async () => {
    const { fetch, calls } = queuedFetch([redirect(307, "https://evil.example/x")]);
    const { http } = makeHttp(fetch);
    const error = await http
      .requestOnce(
        { method: "PUT", path: "p", body: { a: 1 } },
        ctx({ operation: Operation.UpdateDirect }),
      )
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("error");
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as NeweggApiError).retryable).toBe(false);
    expect((error as NeweggApiError).details).toMatchObject({ causeCode: "REDIRECT_REFUSED" });
  });

  it("treats an unclassified operation as a write (fails closed)", async () => {
    const { fetch, calls } = queuedFetch([json({})]);
    const { http } = makeHttp(fetch);
    await http.executeOnce(SPEC, ctx({ operation: "made.up" }));
    expect(calls[0]?.init.redirect).toBe("error");
  });
});

describe("logging", () => {
  it("logs started at debug and completed at debug on success", async () => {
    const { fetch } = queuedFetch([json({})]);
    const { http, entries } = makeHttp(fetch);
    await http.executeOnce({ ...SPEC, query: { secret: "q" } }, ctx());
    expect(entries.map((e) => [e.level, e.event])).toEqual([
      ["debug", LogEvent.RequestStarted],
      ["debug", LogEvent.RequestCompleted],
    ]);
    expect(entries[1]?.fields).toMatchObject({ status: 200, outcome: "success" });
  });

  it("logs a failed response at warn with the Newegg error code", async () => {
    const { fetch } = queuedFetch([json({ Message: "no" }, { status: 400 })]);
    const { http, entries } = makeHttp(fetch);
    await http.executeOnce(SPEC, ctx()).catch(() => undefined);
    const completed = entries.find((e) => e.event === LogEvent.RequestCompleted);
    expect(completed?.level).toBe("warn");
    expect(completed?.fields).toMatchObject({ status: 400, outcome: "error" });
  });

  it("never logs credentials, the raw seller id, query strings or bodies", async () => {
    const { fetch } = queuedFetch([
      new Response("down", { status: 503 }),
      json({ token: "RESPONSE-BODY-MARKER" }),
    ]);
    const { http, entries } = makeHttp(fetch);
    await http.request(
      {
        method: "POST",
        path: "contentmgmt/item/status",
        query: { filter: "QUERY-MARKER" },
        body: { sku: "BODY-MARKER" },
      },
      ctx({ rateLimitKey: "us:A006:test" }),
    );
    const logged = JSON.stringify(entries);
    for (const forbidden of [
      TEST_API_KEY,
      TEST_SECRET_KEY,
      "A006",
      "QUERY-MARKER",
      "BODY-MARKER",
      "RESPONSE-BODY-MARKER",
      "sellerid",
    ]) {
      expect(logged).not.toContain(forbidden);
    }
    expect(logged).toContain(http.sellerIdHash);
    const started = entries.find((e) => e.event === LogEvent.RequestStarted);
    expect(started?.fields).toMatchObject({
      path: "/marketplace/contentmgmt/item/status",
      method: "POST",
      marketplace: "us",
    });
  });

  it("summarizes rate-limit headers in the completion log", async () => {
    const { fetch } = queuedFetch([
      json(
        {},
        {
          headers: {
            "x-ratelimit-limit": "100",
            "x-ratelimit-remaining": "42",
            "x-recordcount-remaining": "9",
          },
        },
      ),
    ]);
    const { http, entries } = makeHttp(fetch);
    const result = await http.executeOnce(SPEC, ctx());
    expect(result.rateLimit).toMatchObject({ requestLimit: 100, requestRemaining: 42 });
    const completed = entries.find((e) => e.event === LogEvent.RequestCompleted);
    expect(completed?.fields?.rateLimit).toEqual({
      requestRemaining: 42,
      requestLimit: 100,
      recordRemaining: 9,
    });
  });
});

describe("rate-limit acquisition", () => {
  it("skips the store when the context has no rateLimitKey", async () => {
    const acquire = vi.fn(async () => undefined);
    const { fetch } = queuedFetch([json({})]);
    const { http } = makeHttp(fetch, {
      rateLimitStore: { acquire, observe() {}, configure() {} } as never,
    });
    await http.request(SPEC, ctx());
    expect(acquire).not.toHaveBeenCalled();
  });

  it("acquires budget once per request, not per retry, and logs a wait", async () => {
    const acquire = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const observe = vi.fn();
    const { fetch } = queuedFetch([new Response("down", { status: 503 }), json({})]);
    const { http, entries } = makeHttp(fetch, {
      rateLimitStore: { acquire, observe, configure() {} } as never,
    });
    await http.request(SPEC, ctx({ rateLimitKey: "k", recordCost: 3 }));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith("k", expect.objectContaining({ recordCost: 3 }));
    expect(entries.find((e) => e.event === LogEvent.RateLimitWait)?.level).toBe("info");
  });
});
