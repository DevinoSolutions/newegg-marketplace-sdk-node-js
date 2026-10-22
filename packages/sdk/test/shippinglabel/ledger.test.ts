import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryOperationStore } from "../../src/index.js";
import {
  isMarkedNotBought,
  LabelCreateLedger,
  markNotBought,
} from "../../src/shippinglabel/ledger.js";
import type { OperationStore, StoredOperation } from "../../src/types.js";

const HOUR = 3_600_000;
const T0 = new Date("2026-10-20T00:00:00.000Z");
const KEY = LabelCreateLedger.key("us", "900000001");

afterEach(() => {
  vi.useRealTimers();
});

function freshLedger(ttlMs?: number): { ledger: LabelCreateLedger; store: OperationStore } {
  const store = new InMemoryOperationStore();
  return { ledger: new LabelCreateLedger(store, ttlMs), store };
}

function claimed(ledger: LabelCreateLedger, id: string, ack?: string) {
  const result = ledger.claim(KEY, id, "hash", ack);
  if ("refused" in result) throw new Error("unexpected refusal");
  return result;
}

describe("LabelCreateLedger.key", () => {
  it("is scoped by marketplace and order, and holds no credential", () => {
    expect(LabelCreateLedger.key("us", "5")).toBe("label-create:us:5");
    expect(LabelCreateLedger.key("ca", "5")).not.toBe(LabelCreateLedger.key("us", "5"));
  });
});

describe("markNotBought", () => {
  it("tags objects by identity and returns them unchanged", () => {
    const error = new Error("x");
    expect(markNotBought(error)).toBe(error);
    expect(isMarkedNotBought(error)).toBe(true);
    expect(isMarkedNotBought(new Error("x"))).toBe(false);
  });

  it("leaves nothing observable on the error", () => {
    const error = new Error("x");
    markNotBought(error);
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe("{}");
  });

  it("ignores primitives", () => {
    expect(markNotBought("boom")).toBe("boom");
    expect(isMarkedNotBought("boom")).toBe(false);
    expect(isMarkedNotBought(null)).toBe(false);
    expect(isMarkedNotBought(undefined)).toBe(false);
  });
});

describe("LabelCreateLedger claim / settle", () => {
  it("records `submitting` with the attempt id and refuses a second claim", () => {
    const { ledger } = freshLedger();
    const first = claimed(ledger, "a1");
    expect(first.op.state).toBe("submitting");
    expect(first.op.requestIds).toEqual(["a1"]);
    expect(first.previous).toBeUndefined();
    const second = ledger.claim(KEY, "a2", "hash", undefined);
    expect(second).toMatchObject({ refused: { state: "submitting", attemptId: "a1" } });
  });

  it("lets a claim through only when it names exactly the blocking attempt", () => {
    const { ledger } = freshLedger();
    claimed(ledger, "a1");
    expect("refused" in ledger.claim(KEY, "a2", "hash", "wrong")).toBe(true);
    const ok = claimed(ledger, "a2", "a1");
    expect(ok.op.requestIds).toEqual(["a1", "a2"]);
    expect(ok.previous?.requestIds).toEqual(["a1"]);
  });

  it("keeps only the newest 20 attempt ids", () => {
    const { ledger } = freshLedger();
    claimed(ledger, "id0");
    for (let i = 1; i < 25; i++) claimed(ledger, `id${i}`, `id${i - 1}`);
    const next = claimed(ledger, "id25", "id24");
    expect(next.op.requestIds).toHaveLength(20);
    expect(next.op.requestIds?.[19]).toBe("id25");
    expect(next.op.requestIds?.[0]).toBe("id6");
  });

  it("settles `failed` to free the order, and `submitted` to keep it blocked", async () => {
    const failed = freshLedger().ledger;
    claimed(failed, "a1");
    await failed.settle(KEY, "a1", "failed");
    expect("refused" in failed.claim(KEY, "a2", "hash", undefined)).toBe(false);

    const bought = freshLedger().ledger;
    claimed(bought, "a1");
    await bought.settle(KEY, "a1", "submitted");
    expect(bought.claim(KEY, "a2", "hash", undefined)).toMatchObject({
      refused: { state: "submitted", attemptId: "a1" },
    });
  });

  it("ignores a settle for an attempt that is no longer the latest", async () => {
    const { ledger } = freshLedger();
    claimed(ledger, "a1");
    claimed(ledger, "a2", "a1");
    await ledger.settle(KEY, "a1", "failed");
    expect(ledger.claim(KEY, "a3", "hash", undefined)).toMatchObject({
      refused: { attemptId: "a2", state: "submitting" },
    });
  });

  it("ignores a settle for an unknown key", async () => {
    const { ledger, store } = freshLedger();
    await ledger.settle("label-create:us:nope", "a1", "submitted");
    expect(await store.get("label-create:us:nope")).toBeUndefined();
  });

  it("swallows a store failure while settling and stays blocked in memory", async () => {
    const inner = new InMemoryOperationStore();
    let failPuts = false;
    const store: OperationStore = {
      get: (key) => inner.get(key),
      put: async (key, op) => {
        if (failPuts) throw new Error("disk full");
        await inner.put(key, op);
      },
    } as OperationStore;
    const ledger = new LabelCreateLedger(store);
    const c = claimed(ledger, "a1");
    await ledger.persist(KEY, c.op);
    failPuts = true;
    await expect(ledger.settle(KEY, "a1", "submitted")).resolves.toBeUndefined();
    expect((await inner.get(KEY))?.state).toBe("submitting");
    expect("refused" in ledger.claim(KEY, "a2", "hash", undefined)).toBe(true);
  });
});

describe("LabelCreateLedger persist / rollback / read", () => {
  it("persist writes the record and rejects when the store does", async () => {
    const { ledger, store } = freshLedger();
    const c = claimed(ledger, "a1");
    await ledger.persist(KEY, c.op);
    expect((await store.get(KEY))?.requestIds).toEqual(["a1"]);

    const broken = new LabelCreateLedger({
      get: async () => undefined,
      put: async () => {
        throw new Error("nope");
      },
    } as unknown as OperationStore);
    const bc = claimed(broken, "b1");
    await expect(broken.persist(KEY, bc.op)).rejects.toThrow("nope");
  });

  it("rollback restores the previous record, or removes a first one", () => {
    const first = freshLedger().ledger;
    const c1 = claimed(first, "a1");
    first.rollback(KEY, c1);
    expect("refused" in first.claim(KEY, "a2", "hash", undefined)).toBe(false);

    const second = freshLedger().ledger;
    claimed(second, "a1");
    const c2 = claimed(second, "a2", "a1");
    second.rollback(KEY, c2);
    expect(second.claim(KEY, "a3", "hash", undefined)).toMatchObject({
      refused: { attemptId: "a1" },
    });
  });

  it("rollback does nothing once a newer claim replaced the one being undone", () => {
    const { ledger } = freshLedger();
    const c1 = claimed(ledger, "a1");
    claimed(ledger, "a2", "a1");
    ledger.rollback(KEY, c1);
    expect(ledger.claim(KEY, "a3", "hash", undefined)).toMatchObject({
      refused: { attemptId: "a2" },
    });
  });

  it("read returns the newest of the shared cache and the store", async () => {
    const { ledger, store } = freshLedger();
    const c = claimed(ledger, "a1");
    await ledger.persist(KEY, c.op);
    expect(await ledger.read(KEY)).toMatchObject({ state: "submitting", attemptId: "a1" });

    const newer: StoredOperation = {
      ...c.op,
      state: "submitted",
      requestIds: ["a1", "a9"],
      updatedAt: new Date(Date.parse(c.op.updatedAt) + 1000).toISOString(),
    };
    await store.put(KEY, newer);
    expect(await ledger.read(KEY)).toMatchObject({ state: "submitted", attemptId: "a9" });
  });

  it("read reports nothing for an unknown order and for a failed attempt", async () => {
    const { ledger } = freshLedger();
    expect(await ledger.read(KEY)).toBeUndefined();
    claimed(ledger, "a1");
    await ledger.settle(KEY, "a1", "failed");
    expect(await ledger.read(KEY)).toBeUndefined();
  });

  it("shares the claim across ledgers built on one store, but not across stores", () => {
    const store = new InMemoryOperationStore();
    const one = new LabelCreateLedger(store);
    const two = new LabelCreateLedger(store);
    claimed(one, "a1");
    expect("refused" in two.claim(KEY, "a2", "hash", undefined)).toBe(true);
    const other = new LabelCreateLedger(new InMemoryOperationStore());
    expect("refused" in other.claim(KEY, "a2", "hash", undefined)).toBe(false);
  });
});

describe("LabelCreateLedger expiry", () => {
  it("blocks for 24 hours by default and not a millisecond longer", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { ledger } = freshLedger();
    claimed(ledger, "a1");
    vi.setSystemTime(new Date(T0.getTime() + 24 * HOUR));
    expect("refused" in ledger.claim(KEY, "a2", "hash", undefined)).toBe(true);
    vi.setSystemTime(new Date(T0.getTime() + 24 * HOUR + 1));
    expect("refused" in ledger.claim(KEY, "a3", "hash", undefined)).toBe(false);
  });

  it("honors a custom ttl for both submitting and submitted records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { ledger } = freshLedger(HOUR);
    claimed(ledger, "a1");
    await ledger.settle(KEY, "a1", "submitted");
    vi.setSystemTime(new Date(T0.getTime() + HOUR));
    expect(await ledger.read(KEY)).toMatchObject({ state: "submitted" });
    vi.setSystemTime(new Date(T0.getTime() + HOUR + 1));
    expect(await ledger.read(KEY)).toBeUndefined();
  });

  it("restarts the window when an acknowledged claim records a new attempt", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { ledger } = freshLedger(HOUR);
    claimed(ledger, "a1");
    vi.setSystemTime(new Date(T0.getTime() + HOUR / 2));
    claimed(ledger, "a2", "a1");
    vi.setSystemTime(new Date(T0.getTime() + HOUR + 1));
    expect(ledger.claim(KEY, "a3", "hash", undefined)).toMatchObject({
      refused: { attemptId: "a2" },
    });
  });

  it("treats a record with an unparseable timestamp as still blocking (fails closed)", async () => {
    const store = new InMemoryOperationStore();
    await store.put(KEY, {
      state: "submitting",
      payloadHash: "h",
      requestIds: ["a1"],
      updatedAt: "not a date",
    });
    const ledger = new LabelCreateLedger(store);
    expect(await ledger.read(KEY)).toMatchObject({ state: "submitting", attemptId: "a1" });
  });

  it("reports attempt id `unknown` for a record without ids", async () => {
    const store = new InMemoryOperationStore();
    await store.put(KEY, {
      state: "submitting",
      payloadHash: "h",
      updatedAt: new Date().toISOString(),
    });
    expect(await new LabelCreateLedger(store).read(KEY)).toMatchObject({ attemptId: "unknown" });
  });
});
