import { describe, expect, it } from "vitest";
import {
  IndeterminateOrderWriteError,
  NeweggApiError,
  NeweggValidationError,
} from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Mocked (createMockFetch) coverage for the order-WRITE surface, modeled on contracts §11:
 * Ship Order (Action 2), Cancel Order (Action 1), Order Confirmation (mark-downloaded), and
 * Remove Item (KillItem). These never touch a real account. The safety-critical behaviors are
 * asserted explicitly: the "IsSuccess is always true" ship quirk (real outcome = per-package
 * ProcessStatus + FailCount), and NON-idempotent send semantics (an ambiguous 5xx becomes an
 * IndeterminateOrderWriteError with no retry, so a write is never blindly resent).
 */

// §11.1 Ship Order response (one package, fully shipped).
const SHIP_RESPONSE = {
  IsSuccess: true,
  PackageProcessingSummary: { TotalPackageCount: 1, SuccessCount: 1, FailCount: 0 },
  Result: {
    OrderNumber: "159243598",
    OrderStatus: "Shipped",
    SellerID: "A006",
    Shipment: {
      PackageList: [
        {
          TrackingNumber: "TRACK1",
          ShipDate: "2012-02-10T15:30:01",
          ProcessStatus: true,
          ProcessResult: "Success",
          ItemList: [
            { NeweggItemNumber: "9SIA0060845543", SellerPartNumber: "A006ZX-35833", ShippedQty: 1 },
          ],
        },
      ],
    },
  },
};

const shipInput = {
  orderNumber: "159243598",
  packages: [
    {
      trackingNumber: "TRACK1",
      shipCarrier: "Other Carrier",
      shipService: "Other Service",
      items: [{ sellerPartNumber: "A006ZX-35833", shippedQty: 1 }],
    },
  ],
};

describe("orders.ship", () => {
  it("issues Action=2 PUT to orderstatus/orders/{n} and normalizes the response", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: SHIP_RESPONSE }),
      },
    ]);

    const result = await client.orders.ship(shipInput);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/orderstatus/orders/159243598");
    expect(calls[0]!.url.searchParams.get("version")).toBe("304");
    expect(calls[0]!.bodyJson).toMatchObject({
      Action: "2",
      Value: {
        Shipment: {
          Header: { SellerID: "A006", SONumber: "159243598" },
          PackageList: {
            Package: [
              {
                TrackingNumber: "TRACK1",
                ShipCarrier: "Other Carrier",
                ShipService: "Other Service",
                ItemList: { Item: [{ SellerPartNumber: "A006ZX-35833", ShippedQty: "1" }] },
              },
            ],
          },
        },
      },
    });

    expect(result.marketplace).toBe("us");
    expect(result.orderNumber).toBe("159243598");
    expect(result.status).toBe("shipped");
    expect(result.statusLabel).toBe("Shipped");
    expect(result.totalPackageCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.processStatus).toBe(true);
    expect(result.packages[0]!.trackingNumber).toBe("TRACK1");
    expect(result.packages[0]!.shipDate?.raw).toBe("2012-02-10T15:30:01");
    expect(result.packages[0]!.items[0]!.sellerPartNumber).toBe("A006ZX-35833");
    expect(result.packages[0]!.items[0]!.shippedQty).toBe(1);
  });

  it("reports partial failure via failCount + processStatus, NOT the always-true IsSuccess", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({
          status: 200,
          body: {
            IsSuccess: true, // Newegg documents this as always true — must not be read as success.
            PackageProcessingSummary: { TotalPackageCount: 2, SuccessCount: 1, FailCount: 1 },
            Result: {
              OrderNumber: "159243598",
              OrderStatus: "PartiallyShipped",
              Shipment: {
                PackageList: [
                  {
                    TrackingNumber: "OK",
                    ProcessStatus: true,
                    ProcessResult: "Success",
                    ItemList: [],
                  },
                  {
                    TrackingNumber: "BAD",
                    ProcessStatus: false,
                    ProcessResult: "Failed",
                    ItemList: [],
                  },
                ],
              },
            },
          },
        }),
      },
    ]);

    const result = await client.orders.ship(shipInput);
    expect(result.status).toBe("partiallyShipped");
    expect(result.failCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(result.packages.map((p) => p.processStatus)).toEqual([true, false]);
  });

  it("tolerates single Package/Item objects (not arrays) in the response", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({
          status: 200,
          body: {
            PackageProcessingSummary: { TotalPackageCount: 1, SuccessCount: 1, FailCount: 0 },
            Result: {
              OrderNumber: 159243598,
              OrderStatus: "Shipped",
              Shipment: {
                PackageList: {
                  Package: {
                    TrackingNumber: "T1",
                    ProcessStatus: "true",
                    ItemList: { Item: { SellerPartNumber: "SKU-9", ShippedQty: "2" } },
                  },
                },
              },
            },
          },
        }),
      },
    ]);

    const result = await client.orders.ship(shipInput);
    expect(result.orderNumber).toBe("159243598");
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.processStatus).toBe(true);
    expect(result.packages[0]!.items[0]!.sellerPartNumber).toBe("SKU-9");
    expect(result.packages[0]!.items[0]!.shippedQty).toBe(2);
  });

  it("rejects invalid input before any HTTP call (NeweggValidationError)", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: SHIP_RESPONSE }),
      },
    ]);

    await expect(
      client.orders.ship({
        orderNumber: "0", // not a positive integer
        packages: [
          {
            trackingNumber: "",
            shipCarrier: "C",
            shipService: "S",
            items: [{ sellerPartNumber: "X", shippedQty: 0 }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("throws IndeterminateOrderWriteError on an ambiguous 503 and does NOT retry", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 503, body: "unavailable" }),
      },
    ]);

    const err = await client.orders.ship(shipInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect((err as IndeterminateOrderWriteError).retryable).toBe(false);
    expect((err as IndeterminateOrderWriteError).operation).toBe("orders.ship");
    expect((err as IndeterminateOrderWriteError).orderNumber).toBe("159243598");
    // Non-idempotent: exactly one dispatch, never a blind resend.
    expect(calls).toHaveLength(1);
  });

  it("passes through a definitive 4xx SO error unchanged", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({
          status: 400,
          body: [
            {
              Code: "SO011",
              Message:
                "Only unshipped orders can be shipped. The order status is currently Shipped",
            },
          ],
        }),
      },
    ]);

    const err = await client.orders.ship(shipInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).neweggErrorCode).toBe("SO011");
    expect(calls).toHaveLength(1);
  });

  it("uses the Canada prefix for a ca client", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: SHIP_RESPONSE }),
      },
    ]);
    await client.orders.ship(shipInput);
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/ordermgmt/orderstatus/orders/159243598");
  });
});

describe("orders.cancel", () => {
  const cancelBody = (status: string) => ({
    IsSuccess: "true",
    Result: { OrderNumber: "159243598", SellerID: "A006", OrderStatus: status },
  });

  it("issues Action=1 PUT with the reason code and returns the void outcome", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: cancelBody("Void") }),
      },
    ]);

    const result = await client.orders.cancel({ orderNumber: "159243598", reason: "outOfStock" });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/orderstatus/orders/159243598");
    expect(calls[0]!.url.searchParams.get("version")).toBe("304");
    expect(calls[0]!.bodyJson).toEqual({ Action: "1", Value: "24" });
    expect(result.orderNumber).toBe("159243598");
    expect(result.outcome).toBe("void");
    expect(result.outcomeLabel).toBe("Void");
  });

  it("maps each cancel reason to its Newegg code", async () => {
    for (const [reason, code] of [
      ["outOfStock", "24"],
      ["customerRequested", "72"],
      ["priceError", "73"],
      ["unableToFulfill", "74"],
    ] as const) {
      const { client, calls } = makeClient("us", [
        {
          method: "PUT",
          pathPattern: paths.orderStatus,
          reply: () => ({ status: 200, body: cancelBody("Void") }),
        },
      ]);
      await client.orders.cancel({ orderNumber: 159243598, reason });
      expect((calls[0]!.bodyJson as { Value: string }).Value).toBe(code);
    }
  });

  it("maps an SBN Processing response to the processing outcome", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: cancelBody("Processing") }),
      },
    ]);
    const result = await client.orders.cancel({
      orderNumber: "159243598",
      reason: "customerRequested",
    });
    expect(result.outcome).toBe("processing");
    expect(result.outcomeLabel).toBe("Processing");
  });

  it("rejects a non-integer order number before any HTTP call", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: cancelBody("Void") }),
      },
    ]);
    await expect(
      client.orders.cancel({ orderNumber: "abc", reason: "priceError" }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("orders.confirmDownload", () => {
  it("POSTs OrderConfirmationRequest to /orders/confirmation and echoes the downloaded list", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "POST",
        pathPattern: paths.orderConfirmation,
        reply: () => ({
          status: 200,
          body: {
            NeweggAPIResponse: {
              IsSuccess: "true",
              OperationType: "OrderConfirmationResponse",
              SellerID: "A006",
              ResponseDate: "2/22/2012 16:38:53",
              ResponseBody: {
                RequestDate: "2/22/2012 16:38:53",
                DownloadedOrderList: { OrderNumber: ["159243598", "41473642"] },
              },
            },
          },
        }),
      },
    ]);

    const result = await client.orders.confirmDownload({ orderNumbers: ["159243598", 41473642] });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/orderstatus/orders/confirmation");
    expect(calls[0]!.url.searchParams.get("version")).toBeNull();
    expect(calls[0]!.bodyJson).toMatchObject({
      OperationType: "OrderConfirmationRequest",
      RequestBody: { DownloadedOrderList: { OrderNumber: ["159243598", "41473642"] } },
    });
    expect(result.orderNumbers).toEqual(["159243598", "41473642"]);
    expect(result.responseDate?.raw).toBe("2/22/2012 16:38:53");
  });

  it("tolerates a single OrderNumber echo (object, not array) and sets IssueUser at the top", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "POST",
        pathPattern: paths.orderConfirmation,
        reply: () => ({
          status: 200,
          body: { ResponseBody: { DownloadedOrderList: { OrderNumber: "159243598" } } },
        }),
      },
    ]);

    const result = await client.orders.confirmDownload({
      orderNumbers: ["159243598"],
      issueUser: "ops@example.com",
    });
    expect((calls[0]!.bodyJson as { IssueUser?: string }).IssueUser).toBe("ops@example.com");
    expect(result.orderNumbers).toEqual(["159243598"]);
  });

  it("rejects an empty order list", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "POST",
        pathPattern: paths.orderConfirmation,
        reply: () => ({ status: 200, body: {} }),
      },
    ]);
    await expect(client.orders.confirmDownload({ orderNumbers: [] })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("orders.removeItems", () => {
  const removeResponse = {
    IsSuccess: true,
    OperationType: "KillItemResponse",
    SellerID: "A006",
    Memo: null,
    ResponseBody: {
      Orders: {
        OrderNumber: "88237462",
        Result: { ItemList: [{ SellerPartNumber: "AWHZ3434" }] },
      },
      RequestDate: "2012-02-22 16:42:10",
    },
    ResponseDate: "2012-02-22 16:42:10",
  };

  it("issues a KillItem PUT to killitem/orders/{n} and echoes removed items", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.killItem,
        reply: () => ({ status: 200, body: removeResponse }),
      },
    ]);

    const result = await client.orders.removeItems({
      orderNumber: "88237462",
      sellerPartNumbers: ["AWHZ3434", "AWHZ3435"],
    });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/killitem/orders/88237462");
    expect(calls[0]!.bodyJson).toMatchObject({
      OperationType: "KillItemRequest",
      RequestBody: {
        KillItem: {
          Order: {
            ItemList: {
              Item: [{ SellerPartNumber: "AWHZ3434" }, { SellerPartNumber: "AWHZ3435" }],
            },
          },
        },
      },
    });
    expect(result.orderNumber).toBe("88237462");
    expect(result.removedSellerPartNumbers).toEqual(["AWHZ3434"]);
    expect(result.memo).toBeUndefined();
    expect(result.requestDate?.raw).toBe("2012-02-22 16:42:10");
  });

  it("surfaces Memo as the failure description when present", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.killItem,
        reply: () => ({
          status: 200,
          body: {
            IsSuccess: false,
            Memo: "SO050 invalid part",
            ResponseBody: { Orders: { OrderNumber: "88237462" } },
          },
        }),
      },
    ]);
    const result = await client.orders.removeItems({
      orderNumber: "88237462",
      sellerPartNumbers: ["X"],
    });
    expect(result.memo).toBe("SO050 invalid part");
    expect(result.removedSellerPartNumbers).toEqual([]);
  });

  it("rejects a duplicate seller part number before any HTTP call", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.killItem,
        reply: () => ({ status: 200, body: removeResponse }),
      },
    ]);
    await expect(
      client.orders.removeItems({ orderNumber: "88237462", sellerPartNumbers: ["DUP", "DUP"] }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("includes Memo and IssueUser in the request body when provided", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.killItem,
        reply: () => ({ status: 200, body: removeResponse }),
      },
    ]);
    await client.orders.removeItems({
      orderNumber: "88237462",
      sellerPartNumbers: ["AWHZ3434"],
      memo: "out of stock",
      issueUser: "ops@example.com",
    });
    const body = calls[0]!.bodyJson as { IssueUser?: string; RequestBody: { Memo?: string } };
    expect(body.IssueUser).toBe("ops@example.com");
    expect(body.RequestBody.Memo).toBe("out of stock");
  });
});
