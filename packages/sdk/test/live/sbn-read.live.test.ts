import { describe, expect, it } from "vitest";
import { UnsupportedMarketplaceOperationError } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live reads of the Shipped-by-Newegg (SBN) inbound-shipment endpoints against the REAL
 * Newegg API (contracts §21 - Get Inbound Shipment List and Get Warehouse List; both are `PUT`
 * with a body but only read). Create / Void Inbound Shipment and Plan Suggestion are never
 * called. Shapes are asserted, never account-specific values. SBN is Newegg.com / Business only,
 * so on CAN the SDK must fail before any request is sent. Two requests in total.
 */
describe.skipIf(!liveEnabled)("live (read-only): SBN reads", () => {
  const client = makeLiveClient();
  const onCan = marketplace() === "ca";

  it("is rejected before sending on CAN", async (ctx) => {
    if (!onCan) {
      ctx.skip();
      return;
    }
    await expect(client.sbn.listShipments()).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
    await expect(client.sbn.listWarehouses()).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
  });

  it("listShipments returns a parsed page of shipments", async (ctx) => {
    if (onCan) {
      ctx.skip();
      return;
    }
    const result = await client.sbn.listShipments({ pageSize: 5 });
    expect(result.marketplace).toBe(marketplace());
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
    expect(Array.isArray(result.shipments)).toBe(true);
    for (const shipment of result.shipments) {
      expect(shipment.shipmentId).not.toBe("");
      expect(Array.isArray(shipment.packages)).toBe(true);
      expect(Array.isArray(shipment.items)).toBe(true);
    }
  });

  it("listWarehouses returns coded warehouses", async (ctx) => {
    if (onCan) {
      ctx.skip();
      return;
    }
    const result = await client.sbn.listWarehouses();
    expect(result.marketplace).toBe(marketplace());
    expect(result.warehouses.length).toBeGreaterThan(0);
    for (const warehouse of result.warehouses) {
      expect(warehouse.warehouseCode).toMatch(/^[A-Za-z0-9]+$/);
      expect(warehouse.address).toBeTypeOf("object");
    }
  });
});
