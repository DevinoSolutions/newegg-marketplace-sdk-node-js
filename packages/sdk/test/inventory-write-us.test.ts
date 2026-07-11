import { describe, expect, it } from "vitest";
import type { ItemIdentifier } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

const okUpdate = {
  method: "POST",
  pathPattern: paths.usInventory,
  reply: () => ({ status: 200, body: {} }),
} as const;

function body(call: { bodyJson?: unknown }): Record<string, unknown> {
  return call.bodyJson as Record<string, unknown>;
}

describe("US direct inventory update", () => {
  it("maps identifier types to Type codes 0/1/2", async () => {
    const cases: Array<[ItemIdentifier, string]> = [
      [{ type: "neweggItemNumber", value: "9SIA0060884598" }, "0"],
      [{ type: "sellerPartNumber", value: "sku" }, "1"],
      [{ type: "upc", value: "012345678901", condition: "new" }, "2"],
    ];
    for (const [identifier, code] of cases) {
      const { client, calls } = makeClient("us", [okUpdate]);
      await client.inventory.updateItem({ identifier, quantity: 5, warehouseLocation: "USA" });
      expect(body(calls[0]!).Type).toBe(code);
    }
  });

  it("serializes Condition only for UPC identifiers", async () => {
    const upc = makeClient("us", [okUpdate]);
    await upc.client.inventory.updateItem({
      identifier: { type: "upc", value: "012345678901", condition: "usedGood" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(body(upc.calls[0]!).Condition).toBe(5);

    const spn = makeClient("us", [okUpdate]);
    await spn.client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(body(spn.calls[0]!).Condition).toBeUndefined();
  });

  it("groups multiple warehouses for one identifier into a single request with string quantities", async () => {
    const { client, calls } = makeClient("us", [okUpdate]);
    const result = await client.inventory.updateMany([
      {
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 107,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 0,
        warehouseLocation: "AUS",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(body(calls[0]!).InventoryList).toEqual({
      Inventory: [
        { WarehouseLocation: "USA", AvailableQuantity: "107" },
        { WarehouseLocation: "AUS", AvailableQuantity: "0" },
      ],
    });
    expect(result.strategy).toBe("direct");
    expect(result.acceptedItemCount).toBe(2);
    expect(result.failedItemCount).toBe(0);
    expect(result.items.every((item) => item.status === "succeeded")).toBe(true);
  });

  it("reports a failed outcome (no throw) when Newegg rejects the update", async () => {
    const { client } = makeClient("us", [
      {
        method: "POST",
        pathPattern: paths.usInventory,
        reply: () => ({
          status: 400,
          body: { Code: "CT002", Message: "Invalid SellerPartNumber" },
        }),
      },
    ]);
    const result = await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(result.failedItemCount).toBe(1);
    expect(result.items[0]!.status).toBe("failed");
    expect(result.items[0]!.errorCode).toBe("CT002");
  });
});
