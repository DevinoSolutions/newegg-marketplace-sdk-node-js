import { describe, expect, it } from "vitest";
import { NeweggApiError } from "../src/index.js";
import type { ItemIdentifier } from "../src/index.js";
import { ITEM_SINGLE_ITEM, makeClient, paths, US_SINGLE_ITEM } from "./helpers.js";

function usBatchReply(req: { bodyJson?: unknown }, limit?: number) {
  const values = (req.bodyJson as { Values: string[] }).Values;
  const kept = limit === undefined ? values : values.slice(0, limit);
  return {
    status: 200,
    body: {
      IsSuccess: true,
      ResponseBody: {
        ItemList: kept.map((value) => ({
          SellerPartNumber: value,
          InventoryAllocation: [
            { WarehouseLocation: "USA", FulfillmentOption: "0", AvailableQuantity: 5 },
          ],
        })),
        TotalCount: kept.length,
      },
    },
  };
}

describe("inventory reads", () => {
  it("normalizes a US single-item read (seller + newegg availability summed)", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
      },
    ]);
    const snapshot = await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "A006BSP3" },
    });
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(snapshot.totalAvailableQuantity).toBe(147);
    expect(snapshot.warehouses).toEqual([
      { location: "USA", quantity: 107, fulfillment: "seller" },
      { location: "USA", quantity: 40, fulfillment: "newegg" },
    ]);
  });

  it("chunks a US batch read at 100 identifiers per request", async () => {
    const { client, calls } = makeClient("us", [
      { method: "POST", pathPattern: paths.usInventoryList, reply: (req) => usBatchReply(req) },
    ]);
    const identifiers: ItemIdentifier[] = Array.from({ length: 150 }, (_, i) => ({
      type: "sellerPartNumber",
      value: `SKU-${i}`,
    }));
    const batch = await client.inventory.getMany({ identifiers });
    expect(calls).toHaveLength(2);
    expect((calls[0]!.bodyJson as { Values: string[] }).Values).toHaveLength(100);
    expect((calls[1]!.bodyJson as { Values: string[] }).Values).toHaveLength(50);
    expect(batch.items).toHaveLength(150);
    expect(batch.missingIdentifiers).toHaveLength(0);
  });

  it("computes missingIdentifiers for values Newegg does not return", async () => {
    const { client } = makeClient("us", [
      { method: "POST", pathPattern: paths.usInventoryList, reply: (req) => usBatchReply(req, 2) },
    ]);
    const batch = await client.inventory.getMany({
      identifiers: [
        { type: "sellerPartNumber", value: "SKU-0" },
        { type: "sellerPartNumber", value: "SKU-1" },
        { type: "sellerPartNumber", value: "SKU-2" },
      ],
    });
    expect(batch.items).toHaveLength(2);
    expect(batch.missingIdentifiers).toEqual([{ type: "sellerPartNumber", value: "SKU-2" }]);
  });

  it("groups a mixed-type batch into one request per identifier type", async () => {
    const { client, calls } = makeClient("us", [
      { method: "POST", pathPattern: paths.usInventoryList, reply: (req) => usBatchReply(req) },
    ]);
    await client.inventory.getMany({
      identifiers: [
        { type: "sellerPartNumber", value: "SKU-1" },
        { type: "sellerPartNumber", value: "SKU-2" },
        { type: "upc", value: "0123456789012" },
      ],
    });
    expect(calls).toHaveLength(2);
    const types = calls.map((call) => (call.bodyJson as { Type: string }).Type).sort();
    expect(types).toEqual(["1", "2"]);
  });

  it("normalizes a flat B2B item with a default warehouse and breakdown", async () => {
    const { client } = makeClient("b2b", [
      {
        method: "POST",
        pathPattern: paths.itemInventory,
        reply: () => ({ status: 200, body: ITEM_SINGLE_ITEM }),
      },
    ]);
    const snapshot = await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "A006BSP3" },
    });
    expect(snapshot.active).toBe(false);
    expect(snapshot.totalAvailableQuantity).toBe(71);
    expect(snapshot.warehouses).toEqual([
      { location: "default", quantity: 71, fulfillment: "newegg" },
      { location: "35", quantity: 3, fulfillment: "newegg" },
    ]);
  });

  it("throws NeweggApiError (not a raw ZodError) on a malformed single-item body", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: { unexpected: true } }),
      },
    ]);
    let error: unknown;
    try {
      await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).name).toBe("NeweggApiError");
  });
});
