import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimitStore, NeweggRateLimitError } from "../src/index.js";
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
