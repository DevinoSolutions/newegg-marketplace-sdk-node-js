import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

/** Synthetic fixtures modeled on the official §21 samples; nothing here is real account data. */
const wrapped = (responseBody: unknown) => ({
  NeweggAPIResponse: { IsSuccess: "true", SellerID: "A006", ResponseBody: responseBody },
});

const route = (method: string, pattern: RegExp, body: unknown, status = 200): MockRoute => ({
  method,
  pathPattern: pattern,
  reply: () => ({ status, body }),
});

const LIST_ROUTE = /sbnmgmt\/inboundshipment\/shipmentlist/;
const STATUS_ROUTE = /sbnmgmt\/inboundshipment\/shipmentstatus/;
const RESULT_ROUTE = /sbnmgmt\/inboundshipment\/shipmentresult\//;
const WAREHOUSE_ROUTE = /sbnmgmt\/inboundshipment\/warehouse/;

const US = makeEnv({ NEWEGG_MARKETPLACE: "us" });

describe("newegg_sbn_shipments_list", () => {
  it("forwards criteria as a PUT body and maps shipments", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "PUT",
          LIST_ROUTE,
          wrapped({
            ShipmentList: {
              Shipment: {
                ShipmentID: "2740139",
                Status: "Preparing",
                CreateDate: "06/06/2013 17:02:31",
                ShipToWarehouseCode: "14",
                ShipToCityName: "Exampleton",
                ShippingMethodCode: "1",
                ShippingCarrierCode: "103",
                PackageList: { Package: { TrackingNumber: "TRK1", PackageWeight: "12" } },
                ItemList: { Item: { SellerPartNumber: "SKU-1", Quantity: "36" } },
              },
            },
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_shipments_list", {
        pageSize: 10,
        keywordType: "sellerPartNumber",
        keyword: "SKU-1",
        status: "preparing",
        updatedFrom: "2026-09-01",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        marketplace: "us",
        page: 1,
        pageSize: 10,
        shipments: [
          {
            shipmentId: "2740139",
            status: "Preparing",
            shipToWarehouseCode: "14",
            shipTo: { city: "Exampleton" },
            shippingMethod: "smallParcel",
            carrier: "UPS",
            packages: [{ trackingNumber: "TRK1", weight: 12 }],
            items: [{ sellerPartNumber: "SKU-1", quantity: 36 }],
          },
        ],
      });
      const call = harness.calls[0]!;
      expect(call.method).toBe("PUT");
      expect(call.url.pathname).toBe("/marketplace/sbnmgmt/inboundshipment/shipmentlist");
      expect(call.bodyJson).toMatchObject({
        OperationType: "GetShipmentListRequest",
        RequestBody: {
          PageInfo: { PageIndex: 1, PageSize: 10 },
          KeywordsType: 3,
          KeywordsValue: "SKU-1",
          Status: 1,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys and out-of-range paging without calling Newegg", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_sbn_shipments_list", { bogus: 1 })).isError).toBe(
        true,
      );
      expect(
        (await callTool(harness.mcp, "newegg_sbn_shipments_list", { pageSize: 500 })).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("maps upstream errors to a structured tool error", async () => {
    const harness = await startHarness({
      env: US,
      routes: [route("PUT", LIST_ROUTE, [{ Code: "CE001", Message: "bad request" }], 400)],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_shipments_list", {});
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "CE001", httpStatus: 400 });
    } finally {
      await harness.close();
    }
  });

  it("returns an unsupported_operation error on Newegg Canada without sending", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MARKETPLACE: "ca" }),
      routes: [],
    });
    try {
      for (const [tool, args] of [
        ["newegg_sbn_shipments_list", {}],
        ["newegg_sbn_request_status", {}],
        ["newegg_sbn_request_result", { requestId: "AB12" }],
        ["newegg_sbn_warehouses_list", {}],
      ] as const) {
        const res = await callTool(harness.mcp, tool, args);
        expect(res.isError, tool).toBe(true);
        expect(res.json, tool).toMatchObject({ errorCode: "unsupported_operation" });
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_sbn_request_status", () => {
  it("nests request ids under GetRequestStatus and maps submissions", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "PUT",
          STATUS_ROUTE,
          wrapped({
            ResponseList: [
              {
                RequestId: "22AZLF9YXKT7S",
                ActionCode: 2,
                RequestDate: "07/11/2013 16:39:30",
                RequestStatus: "CANCELLED",
                Memo: "x".repeat(600),
              },
            ],
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_request_status", {
        requestIds: ["22AZLF9YXKT7S"],
        action: "void",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        requests: [{ requestId: "22AZLF9YXKT7S", action: "void", status: "CANCELLED" }],
      });
      const memo = (res.json as { requests: Array<{ memo?: string }> }).requests[0]?.memo;
      expect(memo?.length).toBeLessThan(600);
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        OperationType: "GetShipmentStatusRequest",
        RequestBody: {
          GetRequestStatus: { RequestIDList: { RequestID: ["22AZLF9YXKT7S"] }, ActionCode: 2 },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects a malformed request id", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_request_status", {
        requestIds: ["has space"],
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_sbn_request_result", () => {
  it("returns labels as type/host/file name and never leaks the credential-bearing URL", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "GET",
          RESULT_ROUTE,
          wrapped({
            RequestID: "22AZLF9YXKT7S",
            RequestStatus: "FINISHED",
            Shipment: {
              ShipmentID: 2740139,
              Label: [
                {
                  LabelType: "ShippingLabel",
                  LabelUrl: "ftp://LabelUser:Pa55word@ftp03.newegg.com/labels/Ship_1.pdf",
                },
              ],
            },
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_request_result", {
        requestId: "22AZLF9YXKT7S",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        requestId: "22AZLF9YXKT7S",
        status: "FINISHED",
        shipmentId: "2740139",
        labels: [{ type: "ShippingLabel", host: "ftp03.newegg.com", fileName: "Ship_1.pdf" }],
        errors: [],
      });
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain("Pa55word");
      expect(serialized).not.toContain("LabelUser");
      expect(harness.calls[0]!.method).toBe("GET");
      expect(harness.calls[0]!.url.pathname).toBe(
        "/marketplace/sbnmgmt/inboundshipment/shipmentresult/22AZLF9YXKT7S",
      );
    } finally {
      await harness.close();
    }
  });

  it("requires a valid requestId", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_sbn_request_result", {})).isError).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_sbn_request_result", { requestId: "a/b" })).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_sbn_warehouses_list", () => {
  it("forwards the warehouse code and maps the 0/1 flags to booleans", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "PUT",
          WAREHOUSE_ROUTE,
          wrapped({
            WarehouseList: [
              {
                WarehouseCode: "10",
                AllowBulkItem: 0,
                AllowSmallItem: 1,
                ShipToCityName: "Exampleton",
              },
            ],
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_sbn_warehouses_list", {
        warehouseCode: "10",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        warehouses: [
          {
            warehouseCode: "10",
            allowBulkItem: false,
            allowSmallItem: true,
            address: { city: "Exampleton" },
          },
        ],
      });
      expect(harness.calls[0]!.bodyJson).toEqual({
        OperationType: "GetWarehouseRequest",
        RequestBody: { WarehouseCode: "10" },
      });
      expect(
        (await callTool(harness.mcp, "newegg_sbn_warehouses_list", { warehouseCode: "ten" }))
          .isError,
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
