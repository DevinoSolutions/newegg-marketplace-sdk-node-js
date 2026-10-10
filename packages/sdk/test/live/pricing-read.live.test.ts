import { beforeAll, describe, expect, it } from "vitest";
import { NeweggError, type ItemIdentifier } from "../../src/index.js";
import { discoverIdentifiers, liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live price reads against the REAL Newegg API (Get Item Price, contracts §15 — a
 * pure read on every platform). The identifier is discovered at runtime (explicit
 * NEWEGG_LIVE_TEST_SELLER_PART_NUMBER, else recent orders) and never hardcoded; real-data
 * reads skip cleanly when none is found. Only `pricing.get` / `pricing.getMany` are used —
 * there is deliberately NO price-write test in the live suite.
 */
describe.skipIf(!liveEnabled)("live (read-only): pricing reads", () => {
  let identifiers: ItemIdentifier[] = [];

  beforeAll(async () => {
    identifiers = await discoverIdentifiers(3);
  });

  it("get returns a normalized price snapshot for a discovered item", async (ctx) => {
    const id = identifiers[0];
    if (!id) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const snapshot = await client.pricing.get({ identifier: id }, { includeRaw: true });
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
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const batch = await client.pricing.getMany({ identifiers });
    expect(batch.marketplace).toBe(marketplace());
    expect(batch.failures).toEqual([]);
    expect(batch.items.length + batch.missingIdentifiers.length).toBe(identifiers.length);
  });

  it("an unknown SKU surfaces as undefined (tryGet) or a typed SDK error (read-only)", async () => {
    const client = makeLiveClient();
    try {
      const snapshot = await client.pricing.tryGet({
        identifier: { type: "sellerPartNumber", value: "NONEXISTENT-PROBE-SKU-XYZ" },
      });
      expect(snapshot === undefined || snapshot.marketplace === marketplace()).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(NeweggError);
    }
  });
});
