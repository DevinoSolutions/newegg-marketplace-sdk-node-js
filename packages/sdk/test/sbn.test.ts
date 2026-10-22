import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
  type NeweggMarketplace,
} from "../src/index.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Shipped-by-Newegg inbound-shipment read fixtures modeled on the official §21 samples. Identifiers,
 * names and addresses are fictional placeholders (the repo is public).
 */
const route = (
  method: string,
  pathPattern: RegExp,
  reply: () => { status: number; body?: unknown },
): MockRoute[] => [{ method, pathPattern, reply }];

const wrapped = (responseBody: unknown, operationType: string) => ({
  NeweggAPIResponse: {
    IsSuccess: "true",
    OperationType: operationType,
    SellerID: "A006",
    ResponseBody: responseBody,
  },
});

const SHIPMENT_JSON = {
  ShipmentID: "2740139",
  Status: "Ready to ship",
  CreateDate: "06/06/2013 17:02:31",
  LastEditDate: "06/07/2013 11:31:00",
  ShipFrom: "Test_Store",
  ShipToWarehouseCode: "14",
  ShipToAddress1: "1 Example Way",
  ShipToCityName: "Exampleton",
  ShipToStateCode: "NJ",
  ShipToZipCode: "00000",
  ShipToCountryCode: "USA",
  ShippingMethodCode: 1,
  ShippingCarrierCode: 102,
  OtherCarrierName: "ignored for a known carrier",
  PackageList: [
    {
      TrackingNumber: "TRK1",
      PackageWeight: 12,
      PackageLength: 10,
      PackageHeight: 5,
      PackageWidth: 4,
    },
  ],
  ItemList: [
    { SellerPartNumber: "SKU-1", Quantity: 36, NumberofPackage: 2 },
    { SellerPartNumber: "SKU-2", Quantity: 9, NumberofPackage: 3 },
  ],
};

describe("sbn.listShipments", () => {
  it("sends a PUT with the PageInfo body and maps the JSON sample (US, no prefix)", async () => {
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: {
          IsSuccess: true,
          OperationType: "GetShipmentListResponse",
          SellerID: "A006",
          ResponseBody: { ShipmentList: [SHIPMENT_JSON] },
        },
      })),
    );
    const result = await client.sbn.listShipments({
      page: 2,
      pageSize: 10,
      keywordType: "shipmentId",
      keyword: " 2740139 ",
      status: "preparing",
      updatedFrom: "2026-09-01 00:00:00",
      updatedTo: "2026-10-01 00:00:00",
    });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/sbnmgmt/inboundshipment/shipmentlist");
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.bodyJson).toEqual({
      OperationType: "GetShipmentListRequest",
      RequestBody: {
        PageInfo: { PageIndex: 2, PageSize: 10 },
        KeywordsType: 1,
        KeywordsValue: "2740139",
        Status: 1,
        LastUpdateDateFrom: "2026-09-01 00:00:00",
        LastUpdateDateTo: "2026-10-01 00:00:00",
      },
    });
    expect(result).toMatchObject({ marketplace: "us", page: 2, pageSize: 10 });
    expect(result.shipments).toHaveLength(1);
    expect(result.shipments[0]).toMatchObject({
      shipmentId: "2740139",
      status: "Ready to ship",
      shipFrom: "Test_Store",
      shipToWarehouseCode: "14",
      shipTo: { address1: "1 Example Way", city: "Exampleton", state: "NJ", country: "USA" },
      shippingMethod: "smallParcel",
      carrierCode: 102,
      carrier: "FedEx",
      packages: [{ trackingNumber: "TRK1", weight: 12, length: 10, height: 5, width: 4 }],
      items: [
        { sellerPartNumber: "SKU-1", quantity: 36, numberOfPackages: 2 },
        { sellerPartNumber: "SKU-2", quantity: 9, numberOfPackages: 3 },
      ],
    });
    // Newegg timestamps are Pacific wall-clock: 17:02:31 PDT is 00:02:31Z the next day.
    expect(result.shipments[0]?.createdAt).toEqual({
      raw: "06/06/2013 17:02:31",
      iso: "2013-06-07T00:02:31.000Z",
    });
  });

  it("defaults to page 1 / 100 rows, sends Date bounds as Pacific wall-clock, and omits absent filters", async () => {
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: wrapped({ ShipmentList: "" }, "GetShipmentListResponse"),
      })),
    );
    const result = await client.sbn.listShipments({
      updatedFrom: new Date("2026-10-01T19:30:00Z"),
    });
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetShipmentListRequest",
      RequestBody: {
        PageInfo: { PageIndex: 1, PageSize: 100 },
        LastUpdateDateFrom: "2026-10-01 12:30:00",
      },
    });
    expect(result.shipments).toEqual([]);
    expect(result).toMatchObject({ page: 1, pageSize: 100 });
  });

  it("reads the XML-converted shape: single shipment, wrapped lists, string numbers, other carrier", async () => {
    const { client } = makeClient(
      "b2b",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: wrapped(
          {
            ShipmentList: {
              Shipment: {
                ShipmentID: 77,
                Status: "Shipped",
                ShipToWarehouseCode: "10",
                ShippingMethodCode: "2",
                ShippingCarrierCode: "99",
                OtherCarrierName: "Local Freight Co",
                PackageList: { Package: { TrackingNumber: "T9", PackageWeight: "3.5" } },
                ItemList: {
                  Item: { SellerPartNumber: "SKU-9", Quantity: "4", NumberofPackage: "1" },
                },
              },
            },
          },
          "GetShipmentListResponse",
        ),
      })),
    );
    const { shipments } = await client.sbn.listShipments();
    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({
      shipmentId: "77",
      status: "Shipped",
      shippingMethod: "lessThanTruckload",
      carrierCode: 99,
      carrier: "Local Freight Co",
      packages: [{ trackingNumber: "T9", weight: 3.5 }],
      items: [{ sellerPartNumber: "SKU-9", quantity: 4, numberOfPackages: 1 }],
    });
  });

  it("falls back to package fields documented flat on the shipment and drops rows without an id", async () => {
    const { client } = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: wrapped(
          {
            ShipmentList: [
              { ShipmentID: "5", TrackingNumber: "FLAT1", PackageWeight: 2 },
              { Status: "Void" },
            ],
          },
          "GetShipmentListResponse",
        ),
      })),
    );
    const { shipments } = await client.sbn.listShipments();
    expect(shipments).toHaveLength(1);
    expect(shipments[0]?.packages).toEqual([
      {
        trackingNumber: "FLAT1",
        weight: 2,
        length: undefined,
        height: undefined,
        width: undefined,
      },
    ]);
  });

  it("uses the b2b/ prefix on Newegg Business", async () => {
    const { client, calls } = makeClient(
      "b2b",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: wrapped({ ShipmentList: [] }, "GetShipmentListResponse"),
      })),
    );
    await client.sbn.listShipments();
    expect(calls[0]!.url.pathname).toBe("/marketplace/b2b/sbnmgmt/inboundshipment/shipmentlist");
  });

  it("validates input before sending", async () => {
    const { client, calls } = makeClient("us", []);
    for (const input of [
      { pageSize: 101 },
      { pageSize: 0 },
      { page: 0 },
      { keyword: "   " },
      { keywordType: "bogus" as never },
      { status: "bogus" as never },
      { updatedFrom: new Date("nope") },
      { updatedTo: " " },
      { updatedFrom: "not a date" },
    ]) {
      await expect(client.sbn.listShipments(input)).rejects.toBeInstanceOf(NeweggValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it("turns IsSuccess=false and a bare error list into NeweggApiError", async () => {
    const failed = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: { IsSuccess: false, OperationType: "GetShipmentListResponse", SellerID: "A006" },
      })),
    );
    await expect(failed.client.sbn.listShipments()).rejects.toBeInstanceOf(NeweggApiError);
    const errorList = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: [{ Code: "SBN999", Message: "Something broke" }],
      })),
    );
    await expect(errorList.client.sbn.listShipments()).rejects.toMatchObject({
      neweggErrorCode: "SBN999",
    });
  });
});

describe("sbn.getRequestStatus", () => {
  it("nests the filters under GetRequestStatus and maps the JSON sample", async () => {
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.sbnShipmentStatus, () => ({
        status: 200,
        body: {
          IsSuccess: true,
          SellerID: "A006",
          OperationType: "GetShipmentStatusResponse",
          ResponseBody: {
            ResponseList: [
              {
                RequestId: "22AZLF9YXKT7S",
                ActionCode: 1,
                RequestDate: "07/11/2013 16:39:30",
                RequestStatus: "IN_PROGRESS",
              },
              {
                RequestId: "33BBBB",
                ActionCode: "2",
                RequestStatus: "CANCELLED",
                Memo: "Too late",
              },
            ],
          },
        },
      })),
    );
    const result = await client.sbn.getRequestStatus({
      requestIds: ["22AZLF9YXKT7S"],
      action: "create",
      maxCount: 50,
      requestStatus: "ALL",
      requestDateFrom: "2026-10-01 00:00:00",
    });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/sbnmgmt/inboundshipment/shipmentstatus");
    expect(call.bodyJson).toEqual({
      OperationType: "GetShipmentStatusRequest",
      RequestBody: {
        GetRequestStatus: {
          RequestIDList: { RequestID: ["22AZLF9YXKT7S"] },
          ActionCode: 1,
          MaxCount: 50,
          RequestStatus: "ALL",
          RequestDateFrom: "2026-10-01 00:00:00",
        },
      },
    });
    expect(result.requests).toEqual([
      {
        requestId: "22AZLF9YXKT7S",
        action: "create",
        requestedAt: { raw: "07/11/2013 16:39:30", iso: "2013-07-11T23:39:30.000Z" },
        status: "IN_PROGRESS",
        memo: undefined,
      },
      {
        requestId: "33BBBB",
        action: "void",
        requestedAt: undefined,
        status: "CANCELLED",
        memo: "Too late",
      },
    ]);
  });

  it("sends an empty filter when called with no input and reads the XML-converted ResponseInfo shape", async () => {
    const { client, calls } = makeClient(
      "b2b",
      route("PUT", paths.sbnShipmentStatus, () => ({
        status: 200,
        body: wrapped(
          {
            ResponseList: {
              ResponseInfo: { RequestId: "AB12", ActionCode: "1", RequestStatus: "FINISHED" },
            },
          },
          "GetShipmentStatusResponse",
        ),
      })),
    );
    const result = await client.sbn.getRequestStatus();
    expect(calls[0]!.url.pathname).toBe("/marketplace/b2b/sbnmgmt/inboundshipment/shipmentstatus");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetShipmentStatusRequest",
      RequestBody: { GetRequestStatus: {} },
    });
    expect(result.requests).toMatchObject([
      { requestId: "AB12", action: "create", status: "FINISHED" },
    ]);
  });

  it("validates input before sending", async () => {
    const { client, calls } = makeClient("us", []);
    for (const input of [
      { requestIds: [] },
      { requestIds: ["has space"] },
      { requestIds: Array.from({ length: 101 }, (_, i) => `R${i}`) },
      { action: "bogus" as never },
      { maxCount: 101 },
      { maxCount: 0 },
      { requestStatus: "DONE" as never },
      { requestDateTo: new Date("nope") },
    ]) {
      await expect(client.sbn.getRequestStatus(input)).rejects.toBeInstanceOf(
        NeweggValidationError,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

describe("sbn.getRequestResult", () => {
  // A credential-bearing FTP URL like the report file URLs (§17.5): it must never be surfaced.
  const LABEL_URL = "ftp://LabelUser:Pa55word@ftp03.newegg.com/labels/Item_2740139.pdf";

  it("GETs shipmentresult/{requestid} and maps labels to host + file name only", async () => {
    const { client, calls } = makeClient(
      "us",
      route("GET", paths.sbnShipmentResult, () => ({
        status: 200,
        body: {
          IsSuccess: "true",
          OperationType: "GetShipmentResultResponse",
          SellerID: "A006",
          ResponseBody: {
            RequestID: "22AZLF9YXKT7S",
            RequestDate: "07/14/2013 22:40:00",
            ProcessedDate: "07/14/2013 22:41:25",
            RequestStatus: "FINISHED",
            Shipment: {
              ShipmentID: 2740139,
              Label: [
                { LabelType: "ItemLabel", LabelUrl: LABEL_URL },
                { LabelType: "ShippingLabel", LabelURL: "ftp://u:p@ftp03.newegg.com/Ship.pdf" },
              ],
            },
          },
        },
      })),
    );
    const result = await client.sbn.getRequestResult("22AZLF9YXKT7S", { includeRaw: true });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe(
      "/marketplace/sbnmgmt/inboundshipment/shipmentresult/22AZLF9YXKT7S",
    );
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.bodyText ?? "").toBe("");
    expect(result).toMatchObject({
      marketplace: "us",
      requestId: "22AZLF9YXKT7S",
      status: "FINISHED",
      shipmentId: "2740139",
      labels: [
        { type: "ItemLabel", host: "ftp03.newegg.com", fileName: "Item_2740139.pdf" },
        { type: "ShippingLabel", host: "ftp03.newegg.com", fileName: "Ship.pdf" },
      ],
      errors: [],
    });
    expect(result.processedAt?.iso).toBe("2013-07-15T05:41:25.000Z");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Pa55word");
    expect(serialized).not.toContain("LabelUser");
    expect(serialized).toContain("ftp://***@ftp03.newegg.com");
  });

  it("redacts credential-bearing URLs in error text, memos and bare error-list messages", async () => {
    const leaky = "failed fetching ftp://u:Pa55word@ftp03.newegg.com/x.pdf";
    const result = makeClient(
      "us",
      route("GET", paths.sbnShipmentResult, () => ({
        status: 200,
        body: wrapped(
          {
            RequestStatus: "FINISHED",
            ErrorDescription: leaky,
            Shipment: { ErrorList: { Error: [{ ErrorDescription: leaky }, leaky] } },
          },
          "GetShipmentResultResponse",
        ),
      })),
    );
    const parsed = await result.client.sbn.getRequestResult("AB12", { includeRaw: true });
    expect(JSON.stringify(parsed)).not.toContain("Pa55word");
    expect(parsed.errors).toEqual(["failed fetching ftp://***@ftp03.newegg.com/x.pdf"]);

    const status = makeClient(
      "us",
      route("PUT", paths.sbnShipmentStatus, () => ({
        status: 200,
        body: wrapped(
          { ResponseList: [{ RequestId: "AB12", RequestStatus: "CANCELLED", Memo: leaky }] },
          "GetShipmentStatusResponse",
        ),
      })),
    );
    const requests = await status.client.sbn.getRequestStatus({}, { includeRaw: true });
    expect(JSON.stringify(requests)).not.toContain("Pa55word");
    expect(requests.requests[0]?.memo).toContain("ftp://***@");

    const errorList = makeClient(
      "us",
      route("PUT", paths.sbnShipmentList, () => ({
        status: 200,
        body: [{ Code: "SBN999", Message: leaky }],
      })),
    );
    const failure = await errorList.client.sbn.listShipments().catch((error: unknown) => error);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain("Pa55word");
  });

  it("reads the XML-converted shape (LabelURLList, ErrorList) and surfaces error text", async () => {
    const { client } = makeClient(
      "b2b",
      route("GET", paths.sbnShipmentResult, () => ({
        status: 200,
        body: wrapped(
          {
            RequestID: "AB12",
            RequestStatus: "FINISHED",
            ErrorDescription: "Item not eligible",
            Shipment: {
              LabelURLList: { Label: { LabelType: "PackageLabel", LabelUrl: LABEL_URL } },
              ErrorList: { Error: [{ ErrorDescription: "Item not eligible" }, "Second problem"] },
            },
          },
          "GetShipmentResultResponse",
        ),
      })),
    );
    const result = await client.sbn.getRequestResult("AB12");
    expect(result.labels).toEqual([
      { type: "PackageLabel", host: "ftp03.newegg.com", fileName: "Item_2740139.pdf" },
    ]);
    expect(result.errors).toEqual(["Item not eligible", "Second problem"]);
    expect(result.shipmentId).toBeUndefined();
  });

  it("falls back to the requested id and rejects an invalid id before sending", async () => {
    const { client, calls } = makeClient(
      "us",
      route("GET", paths.sbnShipmentResult, () => ({
        status: 200,
        body: wrapped({ RequestStatus: "FINISHED" }, "GetShipmentResultResponse"),
      })),
    );
    expect((await client.sbn.getRequestResult("ZZ99")).requestId).toBe("ZZ99");
    expect(calls).toHaveLength(1);
    for (const id of ["", "a/b", "has space", "x".repeat(65)]) {
      await expect(client.sbn.getRequestResult(id)).rejects.toBeInstanceOf(NeweggValidationError);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("sbn.listWarehouses", () => {
  it("sends the optional WarehouseCode and maps the JSON sample (flags 0/1 become booleans)", async () => {
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.sbnWarehouse, () => ({
        status: 200,
        body: {
          IsSuccess: true,
          OperationType: "GetWarehouseResponse",
          SellerID: "A006",
          ResponseBody: {
            WarehouseList: [
              {
                WarehouseCode: "10",
                AllowBulkItem: 0,
                AllowSmallItem: 1,
                ShipToAddress1: "1 Example Way",
                ShipToCityName: "Exampleton",
                ShipToStateCode: "TN",
                ShipToZipCode: "00000",
                ShipToCountryCode: "USA",
              },
            ],
          },
        },
      })),
    );
    const result = await client.sbn.listWarehouses({ warehouseCode: "10" });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/sbnmgmt/inboundshipment/warehouse");
    expect(call.bodyJson).toEqual({
      OperationType: "GetWarehouseRequest",
      RequestBody: { WarehouseCode: "10" },
    });
    expect(result.warehouses).toEqual([
      {
        warehouseCode: "10",
        allowBulkItem: false,
        allowSmallItem: true,
        address: {
          address1: "1 Example Way",
          address2: undefined,
          city: "Exampleton",
          state: "TN",
          zip: "00000",
          country: "USA",
        },
      },
    ]);
  });

  it("sends an empty RequestBody with no code and reads the XML-converted shape on B2B", async () => {
    const { client, calls } = makeClient(
      "b2b",
      route("PUT", paths.sbnWarehouse, () => ({
        status: 200,
        body: wrapped(
          {
            WarehouseList: {
              Warehouse: { WarehouseCode: 7, AllowBulkItem: "1", AllowSmallItem: "0" },
            },
          },
          "GetWarehouseResponse",
        ),
      })),
    );
    const result = await client.sbn.listWarehouses();
    expect(calls[0]!.url.pathname).toBe("/marketplace/b2b/sbnmgmt/inboundshipment/warehouse");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetWarehouseRequest",
      RequestBody: {},
    });
    expect(result.warehouses).toMatchObject([
      { warehouseCode: "7", allowBulkItem: true, allowSmallItem: false },
    ]);
  });

  it("rejects a malformed warehouse code before sending", async () => {
    const { client, calls } = makeClient("us", []);
    await expect(client.sbn.listWarehouses({ warehouseCode: "abc" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("sbn on Newegg Canada", () => {
  it.each([
    ["listShipments", (c: ReturnType<typeof makeClient>["client"]) => c.sbn.listShipments()],
    ["getRequestStatus", (c: ReturnType<typeof makeClient>["client"]) => c.sbn.getRequestStatus()],
    [
      "getRequestResult",
      (c: ReturnType<typeof makeClient>["client"]) => c.sbn.getRequestResult("AB12"),
    ],
    ["listWarehouses", (c: ReturnType<typeof makeClient>["client"]) => c.sbn.listWarehouses()],
  ] as const)(
    "%s throws UnsupportedMarketplaceOperationError without sending",
    async (_name, call) => {
      const marketplace: NeweggMarketplace = "ca";
      const { client, calls } = makeClient(marketplace, []);
      await expect(call(client)).rejects.toBeInstanceOf(UnsupportedMarketplaceOperationError);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("sbn.listShipments criteria dates are strict Pacific forms (T-5962 review)", () => {
  const REJECTED = [
    "1",
    "20260901",
    "Sept 1",
    "-1",
    "2026-02-31 00:00:00",
    "2026-13-01 00:00:00",
    "2026-09-01 99:99:99",
    "13/45/2026 10:00:00",
    "2026-09-01T00:00:00",
    "09/01/2026",
  ];

  it.each(REJECTED)("rejects %j before sending", async (value) => {
    const { client, calls } = makeClient("us", []);
    for (const key of ["updatedFrom", "updatedTo"] as const) {
      const error = await client.sbn.listShipments({ [key]: value }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeweggValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(["2026-09-01 08:30:00", "2026-09-01 08:30", "09/01/2026 08:30:00", "2026-09-01"])(
    "sends %j verbatim",
    async (value) => {
      const { client, calls } = makeClient(
        "us",
        route("PUT", paths.sbnShipmentList, () => ({
          status: 200,
          body: wrapped({ ShipmentList: [] }, "GetShipmentListResponse"),
        })),
      );
      await client.sbn.listShipments({ updatedFrom: value, updatedTo: value });
      expect(calls[0]!.bodyJson).toMatchObject({
        RequestBody: { LastUpdateDateFrom: value, LastUpdateDateTo: value },
      });
    },
  );
});
