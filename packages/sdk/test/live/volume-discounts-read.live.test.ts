import { beforeAll, describe, expect, it } from "vitest";
import { type ItemIdentifier } from "../../src/index.js";
import {
  discoverIdentifiers,
  expectUnknownSkuNotFound,
  isCa,
  liveEnabled,
  makeLiveClient,
  marketplace,
  NON_CA_VOLUME_DISCOUNT_500,
  noItemReason,
  skipNonCaLimitation,
} from "./helpers.js";

/**
 * READ-ONLY live volume-discount reads against the REAL Newegg API (Get Volume Discount, contracts
 * §22.1 — a PUT that mutates nothing). The identifier is discovered at runtime and never hardcoded;
 * an item without a discount (CT060) is a valid outcome. Only `volumeDiscounts.get` / `tryGet` are
 * used — there is deliberately NO volume-discount write in the live suite.
 *
 * On US/B2B Newegg answers HTTP 500 InternalError for a real SKU (contracts section 22.1, observed
 * 2026-10-21, T-5611); that skips on non-CA, while CA stays strict.
 */
describe.skipIf(!liveEnabled)("live (read-only): volume discount reads", () => {
  let identifiers: ItemIdentifier[] = [];

  beforeAll(async () => {
    identifiers = await discoverIdentifiers(1);
  });

  it("tryGet returns a well-formed tier list, or undefined when the item has no discount", async (ctx) => {
    const id = identifiers[0];
    if (!id || id.type === "upc") {
      ctx.skip(id ? "UPC identifiers cannot be read here" : noItemReason());
      return;
    }
    const client = makeLiveClient();
    const input =
      id.type === "neweggItemNumber"
        ? { neweggItemNumber: id.value }
        : { sellerPartNumber: id.value };
    const snapshot = await client.volumeDiscounts.tryGet(input).catch((error: unknown) => {
      skipNonCaLimitation(ctx, error, NON_CA_VOLUME_DISCOUNT_500);
      throw error;
    });
    if (snapshot === undefined) {
      // CT060: the item has no volume discount configured, a valid "no discount" outcome.
      expect(snapshot).toBeUndefined();
      return;
    }
    expect(snapshot.marketplace).toBe(marketplace());
    expect(snapshot.tiers.length).toBeLessThanOrEqual(3);
    let previous = 0;
    for (const tier of snapshot.tiers) {
      expect(tier.quantity).toBeGreaterThan(previous);
      expect(tier.sellingPrice).toBeGreaterThan(0);
      previous = tier.quantity;
    }
  });

  it("an unknown SKU answers the documented not-found code (read-only)", async (ctx) => {
    const client = makeLiveClient();
    let snapshot;
    try {
      snapshot = await client.volumeDiscounts.get({
        sellerPartNumber: "NONEXISTENT-PROBE-SKU-XYZ",
      });
    } catch (error) {
      // Contracts §22.1: an unknown SKU answers 400 CT002 on CA, US and B2B (CA observed live
      // 2026-10-21, T-5776); CT060 is only for a real item without a discount.
      expectUnknownSkuNotFound(ctx, error, ["CT002"]);
      return;
    }
    expect(isCa()).toBe(false);
    expect(snapshot.marketplace).toBe(marketplace());
  });
});
