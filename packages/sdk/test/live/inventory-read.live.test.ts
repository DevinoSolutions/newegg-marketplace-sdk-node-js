import { beforeAll, describe, expect, it } from "vitest";
import { type ItemIdentifier } from "../../src/index.js";
import {
  discoverIdentifiers,
  expectUnknownSkuNotFound,
  isCa,
  liveEnabled,
  makeLiveClient,
  marketplace,
  NON_CA_BATCH_INVENTORY_401,
  noItemReason,
  skipNonCaLimitation,
  testWarehouse,
} from "./helpers.js";

/**
 * READ-ONLY live inventory reads against the REAL Newegg API. Real item identifiers are
 * discovered read-only (explicit NEWEGG_LIVE_TEST_SELLER_PART_NUMBER, else from recent orders);
 * the real-data reads skip cleanly if none is found. Every call here is a read — `getItem` /
 * `getMany`. There is deliberately NO write test in the live suite.
 *
 * On US/B2B the discovered identifiers are limited to items that exist on that marketplace (a B2B
 * inventory read of a missing item is an empty 200 shell that would pass vacuously), and the batch
 * reads skip on the documented 401 InvalidToken (contracts section 5.3). CA stays strict.
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
      ctx.skip(noItemReason());
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
      ctx.skip(noItemReason());
      return;
    }
    const client = makeLiveClient();
    const batch = await client.inventory
      .getMany({ identifiers: [id], warehouses: warehouses() })
      .catch((error: unknown) => {
        skipNonCaLimitation(ctx, error, NON_CA_BATCH_INVENTORY_401);
        throw error;
      });
    expect(batch.marketplace).toBe(marketplace());
    expect(Array.isArray(batch.items)).toBe(true);
    expect(batch.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof batch.totalCount).toBe("number");
  });

  it("getMany reads MULTIPLE real items in one batch", async (ctx) => {
    if (identifiers.length < 2) {
      ctx.skip(
        `fewer than 2 ${marketplace()} items discoverable (${identifiers.length} found; ${noItemReason()})`,
      );
      return;
    }
    const client = makeLiveClient();
    const batch = await client.inventory
      .getMany({ identifiers, warehouses: warehouses() })
      .catch((error: unknown) => {
        skipNonCaLimitation(ctx, error, NON_CA_BATCH_INVENTORY_401);
        throw error;
      });
    expect(batch.marketplace).toBe(marketplace());
    expect(batch.items.length).toBeGreaterThanOrEqual(1);
    expect(batch.totalCount).toBeGreaterThanOrEqual(1);
    for (const item of batch.items) {
      expect(typeof item.totalAvailableQuantity).toBe("number");
      expect(Number.isFinite(item.totalAvailableQuantity)).toBe(true);
    }
  });

  it("getItem for an unknown SKU answers the documented not-found code (real endpoint, read-only)", async (ctx) => {
    const client = makeLiveClient();
    let snapshot;
    try {
      snapshot = await client.inventory.getItem({
        identifier: { type: "sellerPartNumber", value: "NONEXISTENT-PROBE-SKU-XYZ" },
        warehouses: warehouses(),
      });
    } catch (error) {
      // Contracts §5 (identifier resolution, verified live 2026-07-18): SKU reads fail 400 CT026.
      expectUnknownSkuNotFound(ctx, error, ["CT026"]);
      return;
    }
    // B2B answers an empty 200 shell for a SKU it does not know (contracts §5, T-5611); CA must
    // answer not-found.
    expect(isCa()).toBe(false);
    expect(snapshot.marketplace).toBe(marketplace());
    expect(typeof snapshot.totalAvailableQuantity).toBe("number");
  });

  it("normalized totals match the raw Newegg payload (invariant, read-only)", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip(noItemReason());
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
      // US nested (InventoryAllocation) shape — the invariant there is per-warehouse
      ctx.skip("US nested InventoryAllocation shape has no top-level AvailableQuantity to compare");
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
