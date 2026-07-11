import { describe, expect, it } from "vitest";
import { makeClient, paths } from "./helpers.js";

const okUpdate = {
  method: "PUT",
  pathPattern: paths.itemInventoryAndPrice,
  reply: () => ({ status: 200, body: {} }),
} as const;

function body(call: { bodyJson?: unknown }): Record<string, unknown> {
  return call.bodyJson as Record<string, unknown>;
}

describe("B2B/CA direct inventory update", () => {
  it("PUTs the inventoryandprice endpoint with only Type/Value/Inventory", async () => {
    const { client, calls } = makeClient("ca", [okUpdate]);
    await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "A006BSP3" },
      quantity: 20,
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/contentmgmt/item/inventoryandprice");
    expect(Object.keys(body(calls[0]!)).sort()).toEqual(["Inventory", "Type", "Value"]);
    expect(body(calls[0]!).Inventory).toBe("20");
  });

  it("ignores warehouseLocation with a warning (default-warehouse semantics)", async () => {
    const { client, calls } = makeClient("b2b", [okUpdate]);
    const result = await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 20,
      warehouseLocation: "USA",
    });
    expect(body(calls[0]!)).not.toHaveProperty("WarehouseLocation");
    expect(result.items[0]!.status).toBe("succeeded");
    expect(result.warnings.some((warning) => warning.includes("ignored"))).toBe(true);
  });

  it("normalizes an SBN rejection to a failed outcome", async () => {
    const { client } = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.itemInventoryAndPrice,
        reply: () => ({
          status: 400,
          body: {
            Code: "SBN01",
            Message: "You're not able to update the inventory for a SBN (Shipped by Newegg) item.",
          },
        }),
      },
    ]);
    const result = await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 20,
    });
    expect(result.failedItemCount).toBe(1);
    expect(result.items[0]!.status).toBe("failed");
    expect(result.items[0]!.errorCode).toBe("SBN01");
  });

  it("normalizes a deactivated-item rejection to a failed outcome", async () => {
    const { client } = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.itemInventoryAndPrice,
        reply: () => ({
          status: 400,
          body: {
            Code: "DEACT",
            Message: "Once an item has been deactivated, updates are disregarded.",
          },
        }),
      },
    ]);
    const result = await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 20,
    });
    expect(result.items[0]!.status).toBe("failed");
    expect(result.items[0]!.message).toBeTypeOf("string");
  });
});
