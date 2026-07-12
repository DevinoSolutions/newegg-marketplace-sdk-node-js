import { describe, expect, it } from "vitest";
import { NeweggApiError, NeweggValidationError } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Get Order Information sample (two orders) modeled on the official §10.1 wire response:
 * `OrderNumber` as a number on one order and a string on the other, money as both numbers
 * and `"0.00"` strings, a masked relay email, nested `ItemInfoList`/`PackageInfoList`, and
 * (on the second order) the XML-style `{ ItemInfo: {…} }` single-element wrapper.
 */
const ORDER_INFO_RESPONSE = {
  IsSuccess: true,
  OperationType: "GetOrderInfoResponse",
  SellerID: "A006",
  ResponseBody: {
    PageInfo: { TotalCount: 2, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
    OrderInfoList: [
      {
        SellerID: "A006",
        OrderNumber: 511952652,
        SellerOrderNumber: "2153930",
        InvoiceNumber: 0,
        OrderDownloaded: false,
        OrderDate: "03/18/2023 1:04:16",
        AutoVoidTime: "04/01/2023 1:12:39",
        OrderStatus: 4,
        OrderStatusDescription: "Voided",
        CustomerName: "Test Buyer",
        CustomerPhoneNumber: "523-534-5234",
        CustomerEmailAddress: "cusa.q7zw1u4erbgt9e@marketplace.newegg.com",
        ShipToAddress1: "17708 Rowland St",
        ShipToCityName: "Rowland Heights",
        ShipToStateCode: "CA",
        ShipToZipCode: "91748-1119",
        ShipToCountryCode: "UNITED STATES",
        ShipService: "Standard Shipping (5-7 business days)",
        SignatureRequired: true,
        ShipToFirstName: "Test",
        ShipToLastName: "Buyer",
        CurrencyCode: "USD",
        OrderItemAmount: 1.0,
        ShippingAmount: "0.00",
        DiscountAmount: 0,
        RefundAmount: 0,
        OrderTotalAmount: 1.0,
        OrderQty: 2,
        IsAutoVoid: false,
        SalesChannel: 0,
        FulfillmentOption: 0,
        ItemInfoList: [
          {
            SellerPartNumber: "SKU-1",
            NeweggItemNumber: "9SIA2EUGAT9779",
            MfrPartNumber: "202110261526",
            UPCCode: "",
            Description: "Test item",
            OrderedQty: 2,
            ShippedQty: "0",
            UnitPrice: 0.5,
            ExtendUnitPrice: 1.0,
            ExtendShippingCharge: 0,
            Status: 1,
            StatusDescription: "Unshipped",
            BuyerRequestedCancel: false,
          },
        ],
        PackageInfoList: [
          {
            ShipCarrier: "UPS",
            ShipService: "Ground",
            TrackingNumber: "1Z999AA10123456784",
            ShipDate: "03/20/2023 10:00:00",
            SellerPartNumber: "SKU-1",
            ShippedQty: 1,
            Memo: "",
          },
        ],
      },
      {
        OrderNumber: "41473642",
        OrderStatus: 2,
        OrderStatusDescription: "Shipped",
        SalesChannel: 1,
        FulfillmentOption: 1,
        OrderTotalAmount: "19.99",
        // XML-style single-element wrapper (object, not array) — exercises the list quirk.
        ItemInfoList: { ItemInfo: { SellerPartNumber: "SKU-2", Status: 2 } },
      },
    ],
  },
};

/** §10.2 Get Order Status flat object. */
const ORDER_STATUS_RESPONSE = {
  OrderNumber: "159243598",
  OrderStatusCode: 1,
  OrderStatusName: "PartiallyShipped",
  SellerID: "A006",
  OrderDownloaded: true,
  SalesChannel: 0,
  FulfillmentOption: 0,
};

describe("orders.list", () => {
  it("normalizes the paged Get Order Information envelope and issues a versioned PUT", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);

    const page = await client.orders.list();

    // Request shape: PUT ordermgmt/order/orderinfo?version=315 with an empty RequestCriteria.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/order/orderinfo");
    expect(calls[0]!.url.searchParams.get("version")).toBe("315");
    const body = calls[0]!.bodyJson as {
      OperationType: string;
      RequestBody: {
        PageIndex: number;
        PageSize: number;
        RequestCriteria: Record<string, unknown>;
      };
    };
    expect(body.OperationType).toBe("GetOrderInfoRequest");
    expect(body.RequestBody.PageIndex).toBe(1);
    expect(body.RequestBody.PageSize).toBe(100);
    expect(body.RequestBody.RequestCriteria).toEqual({});

    // Paging envelope.
    expect(page.totalCount).toBe(2);
    expect(page.totalPageCount).toBe(1);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(100);
    expect(page.orders).toHaveLength(2);

    // First order: full normalization, number OrderNumber → string, enums, Pacific date.
    const first = page.orders[0]!;
    expect(first.orderNumber).toBe("511952652");
    expect(first.sellerOrderNumber).toBe("2153930");
    expect(first.status).toBe("voided");
    expect(first.statusDescription).toBe("Voided");
    expect(first.downloaded).toBe(false);
    expect(first.salesChannel).toBe("newegg");
    expect(first.fulfillment).toBe("seller");
    expect(first.currencyCode).toBe("USD");
    expect(first.signatureRequired).toBe(true);
    expect(first.quantity).toBe(2);
    expect(first.orderDate?.raw).toBe("03/18/2023 1:04:16");
    // 01:04:16 Pacific (PDT, UTC-7) → 08:04:16 UTC.
    expect(first.orderDate?.iso).toBe("2023-03-18T08:04:16.000Z");
    expect(first.autoVoidTime?.iso).toBe("2023-04-01T08:12:39.000Z");

    // Money: numbers and the "0.00" string both coerce.
    expect(first.amounts.itemAmount).toBe(1);
    expect(first.amounts.shippingAmount).toBe(0);
    expect(first.amounts.total).toBe(1);

    // Customer + ship-to (masked relay email preserved verbatim).
    expect(first.customer?.name).toBe("Test Buyer");
    expect(first.customer?.emailAddress).toBe("cusa.q7zw1u4erbgt9e@marketplace.newegg.com");
    expect(first.customer?.shipTo?.stateCode).toBe("CA");
    expect(first.customer?.shipTo?.zipCode).toBe("91748-1119");

    // Nested items: item Status uses the 1/2/3 scale; string ShippedQty coerces.
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.sellerPartNumber).toBe("SKU-1");
    expect(first.items[0]!.status).toBe("unshipped");
    expect(first.items[0]!.shippedQty).toBe(0);
    expect(first.items[0]!.unitPrice).toBe(0.5);
    expect(first.items[0]!.extendedUnitPrice).toBe(1);

    // Nested packages.
    expect(first.packages).toHaveLength(1);
    expect(first.packages[0]!.trackingNumber).toBe("1Z999AA10123456784");
    expect(first.packages[0]!.shipDate?.raw).toBe("03/20/2023 10:00:00");

    // Second order: string OrderNumber, other enum values, string money, XML-wrapper item list.
    const second = page.orders[1]!;
    expect(second.orderNumber).toBe("41473642");
    expect(second.status).toBe("shipped");
    expect(second.salesChannel).toBe("multiChannel");
    expect(second.fulfillment).toBe("newegg");
    expect(second.amounts.total).toBe(19.99);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.sellerPartNumber).toBe("SKU-2");
    expect(second.items[0]!.status).toBe("shipped");
    // No PackageInfoList on the wire → empty array, never undefined.
    expect(second.packages).toEqual([]);
  });

  it('maps an unrecognized status code to "unknown" instead of throwing', async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: { OrderInfoList: [{ OrderNumber: 1, OrderStatus: 9, Status: 7 }] },
          },
        }),
      },
    ]);
    const page = await client.orders.list();
    expect(page.orders[0]!.status).toBe("unknown");
  });

  it("tolerates a single OrderInfoList object (not an array)", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: {
              PageInfo: { TotalCount: 1 },
              OrderInfoList: { OrderNumber: 7, OrderStatus: 0 },
            },
          },
        }),
      },
    ]);
    const page = await client.orders.list();
    expect(page.orders).toHaveLength(1);
    expect(page.orders[0]!.orderNumber).toBe("7");
    expect(page.orders[0]!.status).toBe("unshipped");
  });

  it("translates normalized criteria into the wire RequestCriteria", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    await client.orders.list({
      orderNumbers: [123, "456"],
      sellerOrderNumbers: ["SO-1"],
      status: "shipped",
      type: "sbn",
      includeDownloaded: false,
      premierOrder: "premierOnly",
      countryCode: "USA",
      page: 2,
      pageSize: 50,
    });
    const body = calls[0]!.bodyJson as {
      RequestBody: {
        PageIndex: number;
        PageSize: number;
        RequestCriteria: Record<string, unknown>;
      };
    };
    expect(body.RequestBody.PageIndex).toBe(2);
    expect(body.RequestBody.PageSize).toBe(50);
    expect(body.RequestBody.RequestCriteria).toEqual({
      OrderNumberList: { OrderNumber: ["123", "456"] },
      SellerOrderNumberList: { SellerOrderNumber: ["SO-1"] },
      Status: 2,
      Type: 1,
      OrderDownloaded: 1,
      PremierOrder: 1,
      CountryCode: "USA",
    });
  });

  it("renders a Date criterion as a Pacific wall-clock string and passes strings through", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    // 20:30:00 UTC on 2023-06-15 is 13:30:00 Pacific (PDT, UTC-7).
    await client.orders.list({
      dateFrom: new Date("2023-06-15T20:30:00.000Z"),
      dateTo: "2023-06-16 09:00:00",
    });
    const criteria = (
      calls[0]!.bodyJson as { RequestBody: { RequestCriteria: Record<string, string> } }
    ).RequestBody.RequestCriteria;
    expect(criteria.OrderDateFrom).toBe("2023-06-15 13:30:00");
    expect(criteria.OrderDateTo).toBe("2023-06-16 09:00:00");
  });

  it("falls back to the requested paging when the response omits PageInfo", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: { ResponseBody: { OrderInfoList: [] } } }),
      },
    ]);
    const page = await client.orders.list({ page: 3, pageSize: 25 });
    expect(page.page).toBe(3);
    expect(page.pageSize).toBe(25);
    expect(page.orders).toEqual([]);
  });

  it("rejects out-of-range paging with NeweggValidationError before any request", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    await expect(client.orders.list({ pageSize: 0 })).rejects.toBeInstanceOf(NeweggValidationError);
    await expect(client.orders.list({ pageSize: 101 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(client.orders.list({ page: 0 })).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("attaches raw only when includeRaw is set", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    const withoutRaw = await client.orders.list();
    expect(withoutRaw.raw).toBeUndefined();
    const withRaw = await client.orders.list({}, { includeRaw: true });
    expect(withRaw.raw).toEqual(ORDER_INFO_RESPONSE);
  });

  it("uses the B2B and CA URL prefixes", async () => {
    const b2b = makeClient("b2b", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    await b2b.client.orders.list();
    expect(b2b.calls[0]!.url.pathname).toBe("/marketplace/b2b/ordermgmt/order/orderinfo");

    const ca = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({ status: 200, body: ORDER_INFO_RESPONSE }),
      },
    ]);
    await ca.client.orders.list();
    expect(ca.calls[0]!.url.pathname).toBe("/marketplace/can/ordermgmt/order/orderinfo");
  });
});

describe("orders.get / tryGet", () => {
  it("looks up a single order by number and returns its detail", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.orderInfo,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: {
              PageInfo: { TotalCount: 1 },
              OrderInfoList: [{ OrderNumber: 511952652, OrderStatus: 2 }],
            },
          },
        }),
      },
    ]);
    const order = await client.orders.get(511952652);
    expect(order.orderNumber).toBe("511952652");
    expect(order.status).toBe("shipped");
    const body = calls[0]!.bodyJson as {
      RequestBody: { RequestCriteria: { OrderNumberList: { OrderNumber: string[] } } };
    };
    expect(body.RequestBody.RequestCriteria.OrderNumberList.OrderNumber).toEqual(["511952652"]);
  });

  it("get throws NeweggApiError when the order list is empty; tryGet resolves undefined", async () => {
    const empty = {
      status: 200 as const,
      body: { ResponseBody: { PageInfo: { TotalCount: 0 }, OrderInfoList: [] } },
    };
    const g = makeClient("us", [
      { method: "PUT", pathPattern: paths.orderInfo, reply: () => empty },
    ]);
    await expect(g.client.orders.get(999)).rejects.toBeInstanceOf(NeweggApiError);

    const t = makeClient("us", [
      { method: "PUT", pathPattern: paths.orderInfo, reply: () => empty },
    ]);
    await expect(t.client.orders.tryGet(999)).resolves.toBeUndefined();
  });
});

describe("orders.getStatus / tryGetStatus", () => {
  it("reads the flat status object via a versioned GET on the order number", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: ORDER_STATUS_RESPONSE }),
      },
    ]);
    const status = await client.orders.getStatus(159243598);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/marketplace/ordermgmt/orderstatus/orders/159243598");
    expect(calls[0]!.url.searchParams.get("version")).toBe("304");
    expect(status.orderNumber).toBe("159243598");
    expect(status.status).toBe("partiallyShipped");
    expect(status.statusName).toBe("PartiallyShipped");
    expect(status.downloaded).toBe(true);
    expect(status.salesChannel).toBe("newegg");
    expect(status.fulfillment).toBe("seller");
  });

  it("tolerates the QueryOrderStatusInfo wrapper", async () => {
    const { client } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.orderStatus,
        reply: () => ({ status: 200, body: { QueryOrderStatusInfo: ORDER_STATUS_RESPONSE } }),
      },
    ]);
    const status = await client.orders.getStatus(159243598);
    expect(status.status).toBe("partiallyShipped");
  });

  it("maps SO003 (not found) to undefined on tryGetStatus but throws on getStatus", async () => {
    const so003 = {
      status: 400 as const,
      body: [
        { Code: "SO003", Message: "No data found or this order does not belong to this seller" },
      ],
    };
    const t = makeClient("us", [
      { method: "GET", pathPattern: paths.orderStatus, reply: () => so003 },
    ]);
    await expect(t.client.orders.tryGetStatus(1)).resolves.toBeUndefined();

    const g = makeClient("us", [
      { method: "GET", pathPattern: paths.orderStatus, reply: () => so003 },
    ]);
    await expect(g.client.orders.getStatus(1)).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("propagates non-not-found errors (SO002) through both getStatus and tryGetStatus", async () => {
    const so002 = {
      status: 400 as const,
      body: [{ Code: "SO002", Message: "Order Number should be an integer" }],
    };
    const g = makeClient("us", [
      { method: "GET", pathPattern: paths.orderStatus, reply: () => so002 },
    ]);
    await expect(g.client.orders.getStatus(-1)).rejects.toBeInstanceOf(NeweggApiError);

    const t = makeClient("us", [
      { method: "GET", pathPattern: paths.orderStatus, reply: () => so002 },
    ]);
    await expect(t.client.orders.tryGetStatus(-1)).rejects.toBeInstanceOf(NeweggApiError);
  });
});
