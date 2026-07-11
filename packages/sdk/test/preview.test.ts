import { describe, expect, it } from "vitest";
import type { InventoryUpdate } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

describe("previewUpdate (pure, zero writes)", () => {
  it("dedups last-write-wins and reports dropped indexes", async () => {
    const { client, calls } = makeClient("ca", []);
    const preview = await client.inventory.previewUpdate([
      { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
      { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
      { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 0 },
    ]);
    expect(calls).toHaveLength(0);
    expect(preview.normalizedUpdates).toHaveLength(2);
    expect(preview.normalizedUpdates[0]!.quantity).toBe(5);
    expect(preview.deduplicated).toEqual([{ keptInputIndex: 1, droppedInputIndexes: [0] }]);
    expect(preview.zeroQuantityCount).toBe(1);
  });

  it("resolves auto strategy by the feed threshold", async () => {
    const { client } = makeClient("ca", [], { strategy: { autoFeedThreshold: 2 } });
    const three: InventoryUpdate[] = [
      { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
      { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 1 },
      { identifier: { type: "sellerPartNumber", value: "C" }, quantity: 1 },
    ];
    const feed = await client.inventory.previewUpdate(three);
    expect(feed.strategy).toBe("feed");
    expect(feed.plannedFeedCount).toBe(1);

    const two = await client.inventory.previewUpdate(three.slice(0, 2));
    expect(two.strategy).toBe("direct");
    expect(two.plannedFeedCount).toBe(0);
  });

  it("routes non-SPN items to direct alongside a feed (mixed) in auto", async () => {
    const { client } = makeClient("ca", [], { strategy: { autoFeedThreshold: 2 } });
    const preview = await client.inventory.previewUpdate([
      { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
      { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 1 },
      { identifier: { type: "neweggItemNumber", value: "9SIA00000001" }, quantity: 1 },
    ]);
    expect(preview.strategy).toBe("mixed");
    expect(preview.plannedFeedCount).toBe(1);
    expect(preview.warnings.some((warning) => warning.includes("without a sellerPartNumber"))).toBe(
      true,
    );
  });

  it("reads current inventory only when includeCurrentInventory is set", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemInventoryList,
        reply: (req) => {
          const values = (req.bodyJson as { Values: string[] }).Values;
          return {
            status: 200,
            body: {
              IsSuccess: true,
              ResponseBody: {
                ItemList: values.map((value) => ({
                  SellerPartNumber: value,
                  Active: "1",
                  FulfillmentOption: "0",
                  AvailableQuantity: 9,
                })),
                TotalCount: values.length,
              },
            },
          };
        },
      },
    ]);
    const preview = await client.inventory.previewUpdate(
      [
        { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
        { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 2 },
      ],
      { includeCurrentInventory: true },
    );
    expect(calls).toHaveLength(1);
    expect(preview.currentInventory).toHaveLength(2);
    expect(preview.currentInventory?.[0]!.totalAvailableQuantity).toBe(9);
  });
});
