import { beforeAll, describe, expect, it } from "vitest";
import { NeweggError, type ItemIdentifier } from "../../src/index.js";
import { discoverIdentifiers, liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live volume-discount reads against the REAL Newegg API (Get Volume Discount, contracts
 * §22.1 — a PUT that mutates nothing). The identifier is discovered at runtime and never hardcoded;
 * an item without a discount (CT060) is a valid outcome. Only `volumeDiscounts.get` / `tryGet` are
 * used — there is deliberately NO volume-discount write in the live suite.
 */
describe.skipIf(!liveEnabled)("live (read-only): volume discount reads", () => {
  let identifiers: ItemIdentifier[] = [];

  beforeAll(async () => {
    identifiers = await discoverIdentifiers(1);
  });

  it("tryGet returns a well-formed tier list, or undefined when the item has no discount", async (ctx) => {
    const id = identifiers[0];
    if (!id || id.type === "upc") {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const input =
      id.type === "neweggItemNumber"
        ? { neweggItemNumber: id.value }
        : { sellerPartNumber: id.value };
    const snapshot = await client.volumeDiscounts.tryGet(input);
    if (snapshot === undefined) return;
    expect(snapshot.marketplace).toBe(marketplace());
    expect(snapshot.tiers.length).toBeLessThanOrEqual(3);
    let previous = 0;
    for (const tier of snapshot.tiers) {
      expect(tier.quantity).toBeGreaterThan(previous);
      expect(tier.sellingPrice).toBeGreaterThan(0);
      previous = tier.quantity;
    }
  });

  it("an unknown SKU surfaces as undefined (tryGet) or a typed SDK error (read-only)", async () => {
    const client = makeLiveClient();
    try {
      const snapshot = await client.volumeDiscounts.tryGet({
        sellerPartNumber: "NONEXISTENT-PROBE-SKU-XYZ",
      });
      expect(snapshot === undefined || snapshot.marketplace === marketplace()).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(NeweggError);
    }
  });
});
