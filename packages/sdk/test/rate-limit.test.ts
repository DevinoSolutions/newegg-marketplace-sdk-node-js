import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimitStore, NeweggRateLimitError } from "../src/index.js";
import type { RateLimitStore } from "../src/types.js";
import { FEED_RECORDS_PER_HOUR, FEED_SUBMISSIONS_PER_MINUTE } from "../src/feeds/constants.js";
import { makeClient, paths, US_SINGLE_ITEM } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("rate limiting — HTTP integration", () => {
  it("retries a 429 then throws NeweggRateLimitError after attempts are exhausted", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 429, body: [{ Code: "429", Message: "Too many request." }] }),
      },
    ]);
    await expect(
      client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } }),
    ).rejects.toBeInstanceOf(NeweggRateLimitError);
    expect(calls).toHaveLength(3);
  });

  it("parses server rate-limit headers into RateLimitInfo", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({
          status: 200,
          body: US_SINGLE_ITEM,
          headers: {
            "X-RateLimit-Limit": "100",
            "X-RateLimit-Remaining": "95",
            "X-RecordCount-Remaining": "5000",
          },
        }),
      },
    ]);
    const snapshot = await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
    });
    expect(snapshot.rateLimit?.requestLimit).toBe(100);
    expect(snapshot.rateLimit?.requestRemaining).toBe(95);
    expect(snapshot.rateLimit?.recordRemaining).toBe(5000);
  });

  it("holds a 429 retry for the server-directed reset interval, not local backoff", async () => {
    // Freeze now at 2026-07-11 17:00:00 PDT; the DF012 hint below resolves to exactly +30s.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00Z"));
    let attempts = 0;
    const { client, calls } = makeClient(
      "us",
      [
        {
          method: "PUT",
          pathPattern: paths.usInventory,
          reply: () => {
            attempts++;
            if (attempts === 1) {
              return {
                status: 429,
                body: [
                  { Code: "DF012", Message: "submit your feed again after 2026-07-11 17:00:30." },
                ],
              };
            }
            return { status: 200, body: US_SINGLE_ITEM };
          },
        },
      ],
      // Large per-attempt timeout so the fake-timer advance never trips it; 0ms local backoff so
      // ONLY the server-directed 30s can explain any delay before the retry fires.
      { timeoutMs: 600_000, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
    );

    const promise = client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
    });
    // Let the first attempt run and schedule its retry, without advancing the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    // Just short of the reset: the retry must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);
    // Crossing the 30s reset releases the retry, which succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    const snapshot = await promise;
    expect(calls).toHaveLength(2);
    expect(snapshot.marketplace).toBe("us");
  });
});

describe("InMemoryRateLimitStore", () => {
  it("enforces a per-minute budget with FIFO waiting", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    const key = "us:A006:feed.submit";
    store.configure(key, { maxPerMinute: 10 });
    for (let i = 0; i < 10; i++) {
      await store.acquire(key, { recordCost: 1 });
    }
    let resolved = false;
    const pending = store.acquire(key, { recordCost: 1 }).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(resolved).toBe(true);
  });

  it("waits until the reset time when observed remaining is 0", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    const key = "us:A006:inventory.getItem";
    store.observe(key, { requestRemaining: 0, requestResetAt: new Date(Date.now() + 30_000) });
    let resolved = false;
    const pending = store.acquire(key, {}).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(resolved).toBe(true);
  });

  it("isolates budgets per key (per-seller isolation)", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    store.configure("us:A:feed.submit", { maxPerMinute: 1 });
    store.configure("us:B:feed.submit", { maxPerMinute: 1 });
    await store.acquire("us:A:feed.submit", {});

    let aResolved = false;
    void store.acquire("us:A:feed.submit", {}).then(() => {
      aResolved = true;
    });
    let bResolved = false;
    await store.acquire("us:B:feed.submit", {}).then(() => {
      bResolved = true;
    });
    await Promise.resolve();
    expect(bResolved).toBe(true);
    expect(aResolved).toBe(false);
  });

  it("supports abort while waiting", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    const key = "us:A:feed.submit";
    store.configure(key, { maxPerMinute: 1 });
    await store.acquire(key, {});
    const controller = new AbortController();
    const pending = store.acquire(key, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });
});

describe("feed-submission budget", () => {
  it("configures the feed-submit budget from the real published constants", () => {
    // A recording store captures exactly what the SDK wires in at construction time. This is the
    // guard against a regression that drops or hard-codes the feed throttle (silent, uncaught by
    // any mocked read test) — the assertions below reference the imported constants, never literals.
    const configured: Array<{
      key: string;
      budget: { maxPerMinute?: number; maxRecordsPerHour?: number };
    }> = [];
    const recording: RateLimitStore = {
      configure: (key, budget) => {
        configured.push({ key, budget });
      },
      acquire: () => Promise.resolve(),
      observe: () => {},
    };

    makeClient("us", [], { rateLimitStore: recording });

    const feed = configured.find((c) => c.key === "us:A006:feed.submit");
    expect(feed).toBeDefined();
    expect(feed?.budget.maxPerMinute).toBe(FEED_SUBMISSIONS_PER_MINUTE);
    expect(feed?.budget.maxRecordsPerHour).toBe(FEED_RECORDS_PER_HOUR);
  });

  it("blocks a submission that would exceed the real hourly record budget until the window rolls", async () => {
    vi.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    const key = "us:A006:feed.submit";
    store.configure(key, {
      maxPerMinute: FEED_SUBMISSIONS_PER_MINUTE,
      maxRecordsPerHour: FEED_RECORDS_PER_HOUR,
    });

    // Consume the entire hourly record allowance in a single acquire — via recordCost, so the test
    // exercises the real 100k budget without ever materializing a 100k-element array.
    await store.acquire(key, { recordCost: FEED_RECORDS_PER_HOUR });

    // One more record cannot fit; it must wait for the sliding hour window to free the budget.
    let resolved = false;
    const pending = store.acquire(key, { recordCost: 1 }).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    await pending;
    expect(resolved).toBe(true);
  });
});
