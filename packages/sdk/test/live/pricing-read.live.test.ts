import { beforeAll, describe, expect, it } from "vitest";
import { type ItemIdentifier } from "../../src/index.js";
import {
  discoverIdentifiers,
  expectUnknownSkuNotFound,
  isCa,
  liveEnabled,
  makeLiveClient,
  marketplace,
  noItemReason,
} from "./helpers.js";

/**
 * READ-ONLY live price reads against the REAL Newegg API (Get Item Price, contracts §15 — a
 * pure read on every platform). The identifier is discovered at runtime (explicit
 * NEWEGG_LIVE_TEST_SELLER_PART_NUMBER, else recent orders) and never hardcoded; real-data
 * reads skip cleanly when none is found. Only `pricing.get` / `pricing.getMany` are used —
 * there is deliberately NO price-write test in the live suite.
 *
 * Identifiers come from order lines, which are CA-store SKUs under every marketplace prefix, so on
 * US/B2B discovery keeps only items the marketplace actually knows (see `discoverIdentifiers`).
 * Nothing here passes vacuously: a batch must find at least one item, and a single read that finds
 * nothing skips on non-CA (a real CA item must exist, so it fails there).
 */
describe.skipIf(!liveEnabled)("live (read-only): pricing reads", () => {
  let identifiers: ItemIdentifier[] = [];

  beforeAll(async () => {
    identifiers = await discoverIdentifiers(3);
  });

  it("get returns a normalized price snapshot for a discovered item", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip(noItemReason());
      return;
    }
    const client = makeLiveClient();
    const snapshot = await client.pricing.tryGet({ identifier: id }, { includeRaw: true });
    if (snapshot === undefined) {
      ctx.skip(!isCa(), `${marketplace()}: item not found on this marketplace (CT026; T-5611)`);
      expect.fail("CA price read found no item for a discovered CA SKU");
    }
    expect(snapshot.marketplace).toBe(marketplace());
    expect(snapshot.prices.length).toBeGreaterThanOrEqual(1);
    for (const price of snapshot.prices) {
      if (price.sellingPrice !== undefined) {
        expect(Number.isFinite(price.sellingPrice)).toBe(true);
        expect(price.sellingPrice).toBeGreaterThan(0);
      }
      expect(Array.isArray(price.promotions)).toBe(true);
    }
    if (marketplace() !== "us") {
      // B2B/CAN: one flat record whose currency is inferred (§15.2).
      expect(snapshot.prices).toHaveLength(1);
      expect(snapshot.prices[0]?.countryCode).toBeUndefined();
    }
  });

  it("getMany prices several discovered items and reports none as failed", async (ctx) => {
    if (identifiers.length < 1) {
      ctx.skip(noItemReason());
      return;
    }
    const client = makeLiveClient();
    const batch = await client.pricing.getMany({ identifiers });
    expect(batch.marketplace).toBe(marketplace());
    expect(batch.failures).toEqual([]);
    expect(batch.items.length + batch.missingIdentifiers.length).toBe(identifiers.length);
    if (batch.items.length === 0) {
      ctx.skip(!isCa(), `${marketplace()}: every discovered item was missing (T-5611)`);
    }
    expect(batch.items.length).toBeGreaterThanOrEqual(1);
  });

  it("an unknown SKU answers the documented not-found code (read-only)", async (ctx) => {
    const client = makeLiveClient();
    try {
      const snapshot = await client.pricing.get({
        identifier: { type: "sellerPartNumber", value: "NONEXISTENT-PROBE-SKU-XYZ" },
      });
      // Only non-CA may resolve a snapshot here; CA must answer not-found.
      expect(isCa()).toBe(false);
      expect(snapshot.marketplace).toBe(marketplace());
    } catch (error) {
      // Contracts §15.2 errors list / §15.6 tryGet: not found is CT026 or CT010 (HTTP 400).
      expectUnknownSkuNotFound(ctx, error, ["CT026", "CT010"]);
    }
  });
});
