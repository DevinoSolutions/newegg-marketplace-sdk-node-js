import { describe, expect, it } from "vitest";
import { InMemoryOperationStore } from "../../src/index.js";
import { LabelCreateLedger } from "../../src/shippinglabel/ledger.js";
import type { OperationStore, StoredOperation } from "../../src/types.js";

const KEY = LabelCreateLedger.key("us", "900000001");

function op(state: StoredOperation["state"], id: string, updatedAt: string): StoredOperation {
  return { state, payloadHash: "h", requestIds: [id], updatedAt };
}

function claimed(ledger: LabelCreateLedger, id: string, ack?: string) {
  const result = ledger.claim(KEY, id, "hash", ack);
  if ("refused" in result) throw new Error("unexpected refusal");
  return result;
}

describe("InMemoryOperationStore.compareAndPut", () => {
  it("writes only while the stored record is still the expected one", async () => {
    const store = new InMemoryOperationStore();
    const first = op("submitting", "a1", "2026-10-22T00:00:00.000Z");
    const second = op("submitted", "a1", "2026-10-22T00:00:01.000Z");
    expect(await store.compareAndPut(KEY, undefined, first)).toBe(true);
    expect(await store.compareAndPut(KEY, undefined, second)).toBe(false);
    expect(await store.get(KEY)).toEqual(first);
    expect(await store.compareAndPut(KEY, { ...first }, second)).toBe(true);
    expect(await store.get(KEY)).toEqual(second);
  });
});

describe("LabelCreateLedger.persist across stores sharing one backing record", () => {
  /** Two store objects (two processes) over one shared map, with a compare-and-set. */
  function sharedPair(): [OperationStore, OperationStore] {
    const backing = new InMemoryOperationStore();
    const view = (): OperationStore => ({
      get: (key) => backing.get(key),
      put: (key, value) => backing.put(key, value),
      compareAndPut: (key, expected, value) => backing.compareAndPut(key, expected, value),
    });
    return [view(), view()];
  }

  it("lets exactly one of two processes claim inside the preview-to-claim window", async () => {
    const [storeA, storeB] = sharedPair();
    const ledgerA = new LabelCreateLedger(storeA);
    const ledgerB = new LabelCreateLedger(storeB);
    // Both pass their own (empty) in-process claim, as two separate processes would.
    const a = claimed(ledgerA, "a1");
    const b = claimed(ledgerB, "b1");
    const [resultA, resultB] = await Promise.all([
      ledgerA.persist(KEY, a.op),
      ledgerB.persist(KEY, b.op),
    ]);
    const blocked = [resultA, resultB].filter((entry) => entry !== undefined);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ state: "submitting" });
    expect(["a1", "b1"]).toContain(blocked[0]?.attemptId);
  });

  it("reports the winner's attempt to the loser and keeps the loser blocked afterwards", async () => {
    const [storeA, storeB] = sharedPair();
    const ledgerA = new LabelCreateLedger(storeA);
    const ledgerB = new LabelCreateLedger(storeB);
    const a = claimed(ledgerA, "a1");
    expect(await ledgerA.persist(KEY, a.op)).toBeUndefined();
    const b = claimed(ledgerB, "b1");
    const conflict = await ledgerB.persist(KEY, b.op);
    expect(conflict).toMatchObject({ state: "submitting", attemptId: "a1" });
    // The loser's own cache now knows the winner, so a new claim there is refused too.
    expect(ledgerB.claim(KEY, "b2", "hash", undefined)).toMatchObject({
      refused: { attemptId: "a1" },
    });
  });

  it("still honors an acknowledgement that names the stored blocking attempt", async () => {
    const [storeA, storeB] = sharedPair();
    const ledgerA = new LabelCreateLedger(storeA);
    const ledgerB = new LabelCreateLedger(storeB);
    const a = claimed(ledgerA, "a1");
    await ledgerA.persist(KEY, a.op);
    await ledgerB.read(KEY);
    const b = claimed(ledgerB, "b1", "a1");
    expect(await ledgerB.persist(KEY, b.op, "a1")).toBeUndefined();
  });

  it("refuses when the stored record is a newer attempt than the acknowledged one", async () => {
    const [storeA, storeB] = sharedPair();
    const ledgerA = new LabelCreateLedger(storeA);
    const ledgerB = new LabelCreateLedger(storeB);
    const a = claimed(ledgerA, "a1");
    await ledgerA.persist(KEY, a.op);
    await ledgerB.read(KEY);
    const b = claimed(ledgerB, "b1", "a1");
    // Another process acknowledged and re-claimed first.
    const a2 = claimed(ledgerA, "a2", "a1");
    await ledgerA.persist(KEY, a2.op, "a1");
    const conflict = await ledgerB.persist(KEY, b.op, "a1");
    expect(conflict).toMatchObject({ attemptId: "a2" });
  });

  it("does not treat a stored `failed` record as a conflict", async () => {
    const store = new InMemoryOperationStore();
    await store.put(KEY, op("failed", "a1", new Date().toISOString()));
    const ledger = new LabelCreateLedger(store);
    const c = claimed(ledger, "a2");
    expect(await ledger.persist(KEY, c.op)).toBeUndefined();
    expect((await store.get(KEY))?.requestIds).toEqual(["a2"]);
  });

  it("fails closed (rejects) when the store keeps losing the compare-and-set", async () => {
    const store: OperationStore = {
      get: async () => undefined,
      put: async () => undefined,
      compareAndPut: async () => false,
    };
    const ledger = new LabelCreateLedger(store);
    const c = claimed(ledger, "a1");
    await expect(ledger.persist(KEY, c.op)).rejects.toThrow(/contention/i);
  });

  it("reads the store before writing for a store without compare-and-set (narrower race)", async () => {
    const backing = new InMemoryOperationStore();
    const plain = (): OperationStore => ({
      get: (key) => backing.get(key),
      put: (key, value) => backing.put(key, value),
    });
    const ledgerA = new LabelCreateLedger(plain());
    const ledgerB = new LabelCreateLedger(plain());
    const a = claimed(ledgerA, "a1");
    await ledgerA.persist(KEY, a.op);
    const b = claimed(ledgerB, "b1");
    expect(await ledgerB.persist(KEY, b.op)).toMatchObject({ attemptId: "a1" });
  });
});
