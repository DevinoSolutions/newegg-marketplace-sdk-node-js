import { beforeAll, describe, expect, it } from "vitest";
import { NeweggError, type ItemIdentifier } from "../../src/index.js";
import {
  discoverIdentifiers,
  liveEnabled,
  makeLiveClient,
  marketplace,
  testWarehouse,
} from "./helpers.js";

/**
 * READ-ONLY live inventory reads against the REAL Newegg API. Real item identifiers are
 * discovered read-only (explicit NEWEGG_LIVE_TEST_SELLER_PART_NUMBER, else from recent orders);
 * the real-data reads skip cleanly if none is found. Every call here is a read — `getItem` /
 * `getMany`. There is deliberately NO write test in the live suite.
 */
const warehouses = (): string[] | undefined => {
  if (marketplace() !== "us") return undefined; // warehouses are US-only
  const wh = testWarehouse();
  return wh ? [wh] : undefined;
};

describe.skipIf(!liveEnabled)("live (read-only): inventory reads", () => {
  let identifiers: ItemIdentifier[] = [];

  beforeAll(async () => {
    identifiers = await discoverIdentifiers(5);
  });

  it("getItem returns a real snapshot for a discovered item", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const snapshot = await client.inventory.getItem({ identifier: id, warehouses: warehouses() });
    expect(snapshot.marketplace).toBe(marketplace());
    expect(Array.isArray(snapshot.warehouses)).toBe(true);
    expect(typeof snapshot.totalAvailableQuantity).toBe("number");
    expect(Number.isFinite(snapshot.totalAvailableQuantity)).toBe(true);
  });

  it("getMany returns a real batch snapshot for a single discovered item", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const batch = await client.inventory.getMany({ identifiers: [id], warehouses: warehouses() });
    expect(batch.marketplace).toBe(marketplace());
    expect(Array.isArray(batch.items)).toBe(true);
    expect(batch.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof batch.totalCount).toBe("number");
  });

  it("getMany reads MULTIPLE real items in one batch", async (ctx) => {
    if (identifiers.length < 2) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const batch = await client.inventory.getMany({ identifiers, warehouses: warehouses() });
    expect(batch.marketplace).toBe(marketplace());
    expect(batch.items.length).toBeGreaterThanOrEqual(1);
    expect(batch.totalCount).toBeGreaterThanOrEqual(1);
    for (const item of batch.items) {
      expect(typeof item.totalAvailableQuantity).toBe("number");
      expect(Number.isFinite(item.totalAvailableQuantity)).toBe(true);
    }
  });

  it("getItem for an unknown SKU surfaces a typed result (real endpoint, read-only)", async () => {
    const client = makeLiveClient();
    try {
      const snapshot = await client.inventory.getItem({
        identifier: { type: "sellerPartNumber", value: "NONEXISTENT-PROBE-SKU-XYZ" },
        warehouses: warehouses(),
      });
      // Some responses come back as an empty snapshot rather than an error.
      expect(snapshot.marketplace).toBe(marketplace());
      expect(typeof snapshot.totalAvailableQuantity).toBe("number");
    } catch (error) {
      // Unknown items surface as a typed SDK error (observed: NeweggApiError, HTTP 400 CT026).
      expect(error).toBeInstanceOf(NeweggError);
    }
  });

  it("normalized totals match the raw Newegg payload (invariant, read-only)", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const snapshot = await client.inventory.getItem(
      { identifier: id, warehouses: warehouses() },
      { includeRaw: true },
    );
    const raw = snapshot.raw as Record<string, unknown> | undefined;
    const rawQty = raw?.["AvailableQuantity"];
    if (rawQty === undefined) {
      ctx.skip(); // US nested (InventoryAllocation) shape — the invariant there is per-warehouse
      return;
    }
    // The SDK must not invent or drop units: its total equals the quantity Newegg actually sent.
    expect(Number(rawQty)).toBe(snapshot.totalAvailableQuantity);
    const rawActive = raw?.["Active"];
    if (rawActive !== undefined && snapshot.active !== undefined) {
      expect(snapshot.active).toBe(rawActive === "1" || rawActive === 1 || rawActive === true);
    }
  });
});
