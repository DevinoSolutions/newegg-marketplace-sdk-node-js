import { describe, expect, it } from "vitest";
import {
  IndeterminateOrderWriteError,
  NeweggApiError,
  NeweggValidationError,
  type NeweggMarketplace,
  type ShippingLabelInput,
} from "../src/index.js";
import type { MockRoute, RecordedCall } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";
import { ORDER_NUMBER, SKU, orderResponse } from "./service-write-helpers.js";

/**
 * Mocked coverage for the Shipping Label Service (contracts §23): Estimate, Create (BUYS a UPS
 * label) and Reprint. Nothing here touches a real account; every identifier is a fictional
 * placeholder. The safety properties asserted explicitly: previews and estimates never POST to
 * the create / reprint endpoints; a blocker stops the write before any POST; an ambiguous failure
 * becomes an IndeterminateOrderWriteError and is never resent; only a provably-unsent failure is
 * retried.
 */
const TRACKING = "1ZTEST0000000000";
const LABEL_URL = "https://labels.newegg.com/test/label.pdf";
const PACKING_URL = "https://labels.newegg.com/test/packing.pdf";

const input: ShippingLabelInput = {
  orderNumber: ORDER_NUMBER,
  serviceCode: 101,
  shipFrom: {
    firstName: "Test",
    lastName: "Sender",
    phoneNumber: "5550100",
    address1: "1 Placeholder Way",
    city: "Testville",
    stateCode: "ca",
    zipCode: "90001",
  },
  packages: [
    {
      weightLb: 3.5,
      lengthIn: 12,
      widthIn: 8,
      heightIn: 4,
      items: [{ sellerPartNumber: SKU, quantity: 2 }],
    },
  ],
};

/** An unshipped, seller-fulfilled order shipping to the US (override any field). */
function unshippedOrder(overrides: Record<string, unknown> = {}, itemOverrides = {}): unknown {
  const base = orderResponse({
    OrderStatus: 0,
    OrderStatusDescription: "Unshipped",
    ShipToCountryCode: "US",
    ...overrides,
  }) as {
    ResponseBody: { OrderInfoList: Array<{ ItemInfoList: Array<Record<string, unknown>> }> };
  };
  const row = base.ResponseBody.OrderInfoList[0];
  if (row !== undefined) {
    row.ItemInfoList = row.ItemInfoList.map((item) => ({
      ...item,
      ShippedQty: 0,
      Status: 0,
      ...itemOverrides,
    }));
  }
  return base;
}

const orderRoute = (order: unknown = unshippedOrder()): MockRoute => ({
  method: "PUT",
  pathPattern: paths.orderInfo,
  reply: () => ({ status: 200, body: order }),
});

function createResponse(packages: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    NeweggAPIResponse: {
      IsSuccess: "true",
      OperationType: "CreateShippingLabelResponse",
      SellerID: "A006",
      ResponseBody: {
        Shipment: {
          OrderNumber: ORDER_NUMBER,
          ShipDate: "2026-10-20 09:30:00",
          PackageList: { Package: packages },
          ...extra,
        },
      },
    },
  };
}

const goodPackage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  TrackingNumber: TRACKING,
  ProcessResult: "Success",
  ErrorMessage: "",
  SignatureOptions: "",
  LabelUrl: LABEL_URL,
  PackingListUrl: PACKING_URL,
  Rate: {
    ShipWeight: "4",
    ArriveBy: "2026-10-23 20:00:00",
    ShippingAmount: "12.34",
    SignatureOptions: "0.00",
    Total: "12.34",
  },
  ItemList: { Item: { SellerPartNumber: SKU, Quantity: "2" } },
  ...overrides,
});

const createOk = (body: unknown = createResponse([goodPackage()])): MockRoute => ({
  method: "POST",
  pathPattern: paths.shippingLabelCreate,
  reply: () => ({ status: 200, body }),
});

const posts = (calls: RecordedCall[]): RecordedCall[] => calls.filter((c) => c.method === "POST");

function setup(marketplace: NeweggMarketplace, routes: MockRoute[]) {
  return makeClient(marketplace, routes);
}

describe("shippingLabels.estimate", () => {
  const estimateOk: MockRoute = {
    method: "POST",
    pathPattern: paths.shippingLabelEstimate,
    reply: () => ({
      status: 200,
      body: {
        NeweggAPIResponse: {
          IsSuccess: "true",
          OperationType: "EstimateShippingLabelResponse",
          ResponseBody: {
            Shipment: {
              OrderNumber: ORDER_NUMBER,
              EstimatedDate: "2026-10-20 09:30:00",
              PackageList: {
                Package: [
                  {
                    PackageWeight: "3.5",
                    PackageLength: "12",
                    PackageWidth: "8",
                    PackageHeight: "4",
                    ProcessResult: "Success",
                    EstimatedRate: {
                      EstimatedShipWeight: "4",
                      EstimatedArriveBy: "2026-10-23 20:00:00",
                      EstimatedShippingAmount: "12.34",
                      EstimatedSignatureOptions: "0",
                      EstimatedTotal: "12.34",
                    },
                  },
                  {
                    ProcessResult: "Failed",
                    ErrorMessage: "SL008: too long",
                  },
                ],
              },
            },
          },
        },
      },
    }),
  };

  it("posts the documented envelope and returns the quote without reading or buying anything", async () => {
    const { client, calls } = setup("us", [estimateOk]);
    const result = await client.shippingLabels.estimate(input);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toMatch(/shippingservice\/shippinglabel\/estimateshippinglabel$/);
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    const body = call.bodyJson as {
      NeweggAPIRequest: {
        OperationType: string;
        SellerID: string;
        RequestBody: { Shipment: Record<string, unknown> };
      };
    };
    expect(body.NeweggAPIRequest.OperationType).toBe("EstimateShippingLabel");
    expect(body.NeweggAPIRequest.SellerID).toBe("A006");
    const shipment = body.NeweggAPIRequest.RequestBody.Shipment;
    expect(shipment).toMatchObject({
      OrderNumber: ORDER_NUMBER,
      ShippingCarrierCode: "100",
      ShippingServiceCode: "101",
      ShipFromStateCode: "CA",
      ShipFromZipCode: "90001",
      ShipFromCountryCode: "USA",
    });
    expect(shipment.PackageList).toEqual({
      Package: {
        PackageWeight: "3.5",
        PackageLength: "12",
        PackageHeight: "4",
        PackageWidth: "8",
        ItemList: { Item: { SellerPartNumber: SKU, Quantity: "2" } },
      },
    });

    expect(result.marketplace).toBe("us");
    expect(result.currency).toBe("USD");
    expect(result.packages).toHaveLength(2);
    expect(result.packages[0]).toMatchObject({
      succeeded: true,
      weightLb: 3.5,
      rate: { shipWeight: 4, shippingAmount: 12.34, total: 12.34 },
    });
    expect(result.packages[1]).toMatchObject({ succeeded: false, errorMessage: "SL008: too long" });
    expect(result.estimatedTotal).toBeCloseTo(12.34);
    expect(result.estimatedDate?.raw).toBe("2026-10-20 09:30:00");
  });

  it("uses the can/ prefix, the Canadian service codes and CAD on Newegg.ca", async () => {
    const { client, calls } = setup("ca", [estimateOk]);
    const result = await client.shippingLabels.estimate({
      ...input,
      serviceCode: 112,
      shipFrom: { ...input.shipFrom, stateCode: "on", zipCode: "m5v 2t6" },
    });
    expect(calls[0]!.url.pathname).toMatch(/^\/marketplace\/can\/shippingservice/);
    expect(result.currency).toBe("CAD");
    const shipment = (
      calls[0]!.bodyJson as {
        NeweggAPIRequest: { RequestBody: { Shipment: Record<string, unknown> } };
      }
    ).NeweggAPIRequest.RequestBody.Shipment;
    expect(shipment).toMatchObject({ ShipFromCountryCode: "CAN", ShippingServiceCode: "112" });
  });

  it("rejects a service code of the other marketplace before sending", async () => {
    const { client, calls } = setup("ca", [estimateOk]);
    const err = await client.shippingLabels.estimate(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("fails with an API error when Newegg quotes no package", async () => {
    const { client } = setup("us", [
      {
        method: "POST",
        pathPattern: paths.shippingLabelEstimate,
        reply: () => ({
          status: 200,
          body: { NeweggAPIResponse: { IsSuccess: "true", ResponseBody: { Shipment: {} } } },
        }),
      },
    ]);
    await expect(client.shippingLabels.estimate(input)).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("sends exactly one request and does not retry a 503 (no automatic retry)", async () => {
    const { client, calls } = setup("us", [
      {
        method: "POST",
        pathPattern: paths.shippingLabelEstimate,
        reply: () => ({ status: 503, body: "down" }),
      },
    ]);
    const err = await client.shippingLabels.estimate(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).httpStatus).toBe(503);
    expect(posts(calls)).toHaveLength(1);
  });

  it("sends exactly one request and does not retry a dropped connection", async () => {
    let attempts = 0;
    const { client } = makeClient("us", [], {
      fetch: () => {
        attempts++;
        return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
      },
    });
    const err = await client.shippingLabels.estimate(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect(attempts).toBe(1);
  });
});

describe("shippingLabels input validation", () => {
  const bad: Array<[string, (i: ShippingLabelInput) => ShippingLabelInput]> = [
    ["a non-numeric order number", (i) => ({ ...i, orderNumber: "12A" })],
    ["an order number above 2147483647", (i) => ({ ...i, orderNumber: "2147483648" })],
    [
      "a package over the UPS weight limit",
      (i) => ({ ...i, packages: [{ ...i.packages[0]!, weightLb: 151 }] }),
    ],
    [
      "a package over the UPS length limit",
      (i) => ({ ...i, packages: [{ ...i.packages[0]!, lengthIn: 109 }] }),
    ],
    [
      "a package over the UPS length-plus-girth limit",
      (i) => ({
        ...i,
        packages: [{ ...i.packages[0]!, lengthIn: 100, widthIn: 20, heightIn: 20 }],
      }),
    ],
    [
      "a US ship-from with a Canadian postal code",
      (i) => ({ ...i, shipFrom: { ...i.shipFrom, zipCode: "M5V 2T6" } }),
    ],
    ["no packages", (i) => ({ ...i, packages: [] })],
    ["an unknown service code", (i) => ({ ...i, serviceCode: 999 })],
    [
      "a CAN country code on Newegg.com",
      (i) => ({ ...i, shipFrom: { ...i.shipFrom, countryCode: "CAN" } }),
    ],
  ];

  it.each(bad)("rejects %s without any request", async (_name, mutate) => {
    const { client, calls } = setup("us", [orderRoute(), createOk()]);
    const err = await client.shippingLabels.create(mutate(input)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("shippingLabels.previewCreate", () => {
  it("reads the order, reports no blockers and never POSTs", async () => {
    const { client, calls } = setup("us", [orderRoute(), createOk()]);
    const preview = await client.shippingLabels.previewCreate(input);
    expect(preview.blockers).toEqual([]);
    expect(preview.operation).toBe("shippingLabels.create");
    expect(preview.currency).toBe("USD");
    expect(preview.normalized.shipFrom.stateCode).toBe("CA");
    expect(preview.normalized.shipFrom.countryCode).toBe("USA");
    expect(preview.warnings.join("\n")).toMatch(/charges the seller's Newegg account/);
    expect(posts(calls)).toHaveLength(0);
  });

  it("round-trips the normalized input into create", async () => {
    const { client } = setup("us", [orderRoute(), createOk()]);
    const preview = await client.shippingLabels.previewCreate(input);
    const result = await client.shippingLabels.create(preview.normalized);
    expect(result.succeededCount).toBe(1);
  });

  it("warns about the signature surcharge", async () => {
    const { client } = setup("us", [orderRoute(), createOk()]);
    const preview = await client.shippingLabels.previewCreate({
      ...input,
      packages: [{ ...input.packages[0]!, signatureRequired: true }],
    });
    expect(preview.warnings.join("\n")).toMatch(/signature/i);
  });

  const blockerCases: Array<[string, unknown, RegExp, ShippingLabelInput?]> = [
    [
      "a shipped order",
      unshippedOrder({ OrderStatus: 2, OrderStatusDescription: "Shipped" }),
      /SL003/,
    ],
    ["a Newegg-fulfilled order", unshippedOrder({ FulfillmentOption: 1 }), /SL004/],
    ["a non-US destination", unshippedOrder({ ShipToCountryCode: "CA" }), /SL015/],
    [
      "a part number not on the order",
      unshippedOrder(),
      /SL010/,
      {
        ...input,
        packages: [{ ...input.packages[0]!, items: [{ sellerPartNumber: "OTHER", quantity: 2 }] }],
      },
    ],
    [
      "a partial line quantity",
      unshippedOrder(),
      /SL005/,
      {
        ...input,
        packages: [{ ...input.packages[0]!, items: [{ sellerPartNumber: SKU, quantity: 1 }] }],
      },
    ],
  ];

  it.each(blockerCases)("blocks %s", async (_name, order, pattern, override) => {
    const { client, calls } = setup("us", [orderRoute(order), createOk()]);
    const preview = await client.shippingLabels.previewCreate(override ?? input);
    expect(preview.blockers.join("\n")).toMatch(pattern);
    expect(posts(calls)).toHaveLength(0);
  });

  it("blocks an unknown order", async () => {
    const empty = {
      IsSuccess: true,
      ResponseBody: { PageInfo: { TotalCount: 0, TotalPageCount: 0, PageIndex: 1, PageSize: 100 } },
    };
    const { client, calls } = setup("us", [orderRoute(empty), createOk()]);
    const preview = await client.shippingLabels.previewCreate(input);
    expect(preview.blockers.join("\n")).toMatch(/SL002/);
    expect(posts(calls)).toHaveLength(0);
  });

  it("warns that SL015 documents USA only on Newegg.ca", async () => {
    const { client } = setup("ca", [orderRoute(), createOk()]);
    const preview = await client.shippingLabels.previewCreate({
      ...input,
      serviceCode: 111,
      shipFrom: { ...input.shipFrom, stateCode: "ON", zipCode: "M5V 2T6" },
    });
    expect(preview.warnings.join("\n")).toMatch(/SL015/);
    expect(preview.currency).toBe("CAD");
  });
});

describe("shippingLabels.create", () => {
  it("sends one POST with the documented envelope and shapes the result", async () => {
    const { client, calls } = setup("us", [orderRoute(), createOk()]);
    const result = await client.shippingLabels.create(input);

    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.bodyJson as {
      NeweggAPIRequest: {
        OperationType: string;
        RequestBody: { Shipment: Record<string, unknown> };
      };
    };
    expect(body.NeweggAPIRequest.OperationType).toBe("CreateShippingLabel");
    expect(body.NeweggAPIRequest.RequestBody.Shipment).toMatchObject({
      OrderNumber: ORDER_NUMBER,
      ShippingCarrierCode: "100",
    });

    expect(result.operation).toBe("shippingLabels.create");
    expect(result.orderNumber).toBe(ORDER_NUMBER);
    expect(result.currency).toBe("USD");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.totalCharged).toBeCloseTo(12.34);
    expect(result.shipDate?.raw).toBe("2026-10-20 09:30:00");
    expect(result.packages[0]).toMatchObject({
      succeeded: true,
      trackingNumber: TRACKING,
      labelUrl: LABEL_URL,
      packingListUrl: PACKING_URL,
      signatureRequired: false,
      items: [{ sellerPartNumber: SKU, quantity: 2 }],
      rate: { shippingAmount: 12.34, total: 12.34 },
    });
  });

  it("reads the packing list from the table's PackageListUrl spelling too", async () => {
    const { client } = setup("us", [
      orderRoute(),
      createOk(
        createResponse(goodPackage({ PackingListUrl: undefined, PackageListUrl: PACKING_URL })),
      ),
    ]);
    const result = await client.shippingLabels.create(input);
    expect(result.packages[0]?.packingListUrl).toBe(PACKING_URL);
  });

  it("accepts a single (non-array) Package object", async () => {
    const { client } = setup("us", [orderRoute(), createOk(createResponse(goodPackage()))]);
    const result = await client.shippingLabels.create(input);
    expect(result.packages).toHaveLength(1);
  });

  it("reports a partial success without hiding the failed package", async () => {
    const { client } = setup("us", [
      orderRoute(),
      createOk(
        createResponse([
          goodPackage(),
          { ProcessResult: "Failed", ErrorMessage: "SL007: too heavy", TrackingNumber: "" },
        ]),
      ),
    ]);
    const result = await client.shippingLabels.create({
      ...input,
      // The order's 2 units split over two packages (1 + 1) still ship the whole line.
      packages: [1, 1].map((quantity) => ({
        ...input.packages[0]!,
        items: [{ sellerPartNumber: SKU, quantity }],
      })),
    });
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.packages[1]).toMatchObject({
      succeeded: false,
      errorMessage: "SL007: too heavy",
    });
    expect(result.totalCharged).toBeCloseTo(12.34);
  });

  it("throws a definitive API error (not indeterminate) when every package fails", async () => {
    const { client, calls } = setup("us", [
      orderRoute(),
      createOk(createResponse([{ ProcessResult: "Failed", ErrorMessage: "SL014: bad address" }])),
    ]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect(err).not.toBeInstanceOf(IndeterminateOrderWriteError);
    expect((err as NeweggApiError).message).toContain("SL014");
    expect(posts(calls)).toHaveLength(1);
  });

  it("throws an API error on IsSuccess=false", async () => {
    const { client } = setup("us", [
      orderRoute(),
      createOk({ NeweggAPIResponse: { IsSuccess: "false", Memo: "nope" } }),
    ]);
    await expect(client.shippingLabels.create(input)).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("treats a success status without any package as indeterminate", async () => {
    const { client, calls } = setup("us", [orderRoute(), createOk(createResponse([]))]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect((err as IndeterminateOrderWriteError).operation).toBe("shippingLabels.create");
    expect(posts(calls)).toHaveLength(1);
  });

  it("treats a package with neither a label nor an error as indeterminate, not a refusal", async () => {
    const { client, calls } = setup("us", [
      orderRoute(),
      createOk(createResponse([{ ProcessResult: "", ErrorMessage: "" }])),
    ]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("refuses to send when the order check finds a blocker", async () => {
    const { client, calls } = setup("us", [
      orderRoute(unshippedOrder({ OrderStatus: 2, OrderStatusDescription: "Shipped" })),
      createOk(),
    ]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect((err as NeweggValidationError).message).toContain("SL003");
    expect(posts(calls)).toHaveLength(0);
  });

  it("passes a definitive 4xx Newegg error through without a retry", async () => {
    const { client, calls } = setup("us", [
      orderRoute(),
      {
        method: "POST",
        pathPattern: paths.shippingLabelCreate,
        reply: () => ({ status: 400, body: [{ Code: "SL003", Message: "Order not unshipped" }] }),
      },
    ]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect(err).not.toBeInstanceOf(IndeterminateOrderWriteError);
    expect(posts(calls)).toHaveLength(1);
  });

  describe("ambiguous failures are never resent", () => {
    it("throws IndeterminateOrderWriteError on a 503 after one POST", async () => {
      const { client, calls } = setup("us", [
        orderRoute(),
        {
          method: "POST",
          pathPattern: paths.shippingLabelCreate,
          reply: () => ({ status: 503, body: "down" }),
        },
      ]);
      const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
      const indeterminate = err as IndeterminateOrderWriteError;
      expect(indeterminate.retryable).toBe(false);
      expect(indeterminate.operation).toBe("shippingLabels.create");
      expect(indeterminate.orderNumber).toBe(ORDER_NUMBER);
      expect(indeterminate.guidance).toContain("reprint");
      expect(posts(calls)).toHaveLength(1);
    });

    it.each([408, 500, 502, 599])(
      "treats HTTP %i after dispatch as indeterminate",
      async (status) => {
        const { client, calls } = setup("us", [
          orderRoute(),
          {
            method: "POST",
            pathPattern: paths.shippingLabelCreate,
            reply: () => ({ status, body: "oops" }),
          },
        ]);
        const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
        expect(posts(calls)).toHaveLength(1);
      },
    );

    it("treats a connection reset after dispatch as indeterminate", async () => {
      const { client, calls } = setup("us", [
        orderRoute(),
        {
          method: "POST",
          pathPattern: paths.shippingLabelCreate,
          reply: () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
          },
        },
      ]);
      const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
      expect(posts(calls)).toHaveLength(1);
    });

    it("treats a caller abort after dispatch as indeterminate", async () => {
      const controller = new AbortController();
      const { client, calls } = setup("us", [
        orderRoute(),
        {
          method: "POST",
          pathPattern: paths.shippingLabelCreate,
          reply: () => {
            controller.abort();
            throw new DOMException("This operation was aborted", "AbortError");
          },
        },
      ]);
      const err = await client.shippingLabels
        .create(input, { signal: controller.signal })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
      expect(posts(calls)).toHaveLength(1);
    });

    it("retries a provably-unsent connection failure and then succeeds", async () => {
      let attempt = 0;
      const { client, calls } = setup("us", [
        orderRoute(),
        {
          method: "POST",
          pathPattern: paths.shippingLabelCreate,
          reply: () => {
            attempt++;
            if (attempt === 1) {
              throw Object.assign(new TypeError("fetch failed"), {
                cause: { code: "ECONNREFUSED" },
              });
            }
            return { status: 200, body: createResponse([goodPackage()]) };
          },
        },
      ]);
      const result = await client.shippingLabels.create(input);
      expect(result.succeededCount).toBe(1);
      expect(posts(calls)).toHaveLength(2);
    });
  });
});

describe("shippingLabels.reprint", () => {
  const shippedOrder = unshippedOrder(
    { OrderStatus: 2, OrderStatusDescription: "Shipped" },
    { ShippedQty: 2, Status: 2 },
  );
  const reprintResponse = (shipment: Record<string, unknown> = {}): unknown => ({
    NeweggAPIRequest: {
      OperationType: "ReprintShippingLabelResponse",
      SellerID: "A006",
      ResponseBody: {
        Shipment: {
          OrderNumber: ORDER_NUMBER,
          OrderStatus: "Shipped",
          PackageList: {
            Package: { TrackingNumber: TRACKING, LabelUrl: LABEL_URL, PackingListUrl: PACKING_URL },
          },
          ...shipment,
        },
      },
    },
  });
  const reprintOk = (body: unknown = reprintResponse()): MockRoute => ({
    method: "POST",
    pathPattern: paths.shippingLabelReprint,
    reply: () => ({ status: 200, body }),
  });

  it("previews without POSTing and sends the order number only on reprint", async () => {
    const { client, calls } = setup("us", [orderRoute(shippedOrder), reprintOk()]);
    const preview = await client.shippingLabels.previewReprint(ORDER_NUMBER);
    expect(preview.blockers).toEqual([]);
    expect(preview.normalized).toEqual({ orderNumber: ORDER_NUMBER });
    expect(posts(calls)).toHaveLength(0);

    const result = await client.shippingLabels.reprint(ORDER_NUMBER);
    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.pathname).toMatch(/reprintshippinglabel$/);
    expect(sent[0]!.bodyJson).toEqual({
      NeweggAPIRequest: {
        OperationType: "ReprintShippingLabel",
        SellerID: "A006",
        RequestBody: { Shipment: { OrderNumber: ORDER_NUMBER } },
      },
    });
    expect(result).toMatchObject({
      operation: "shippingLabels.reprint",
      orderNumber: ORDER_NUMBER,
      orderStatus: "Shipped",
    });
    expect(result.packages[0]).toMatchObject({
      succeeded: true,
      trackingNumber: TRACKING,
      labelUrl: LABEL_URL,
    });
  });

  it("blocks an order that is still unshipped", async () => {
    const { client, calls } = setup("us", [orderRoute(), reprintOk()]);
    const preview = await client.shippingLabels.previewReprint(ORDER_NUMBER);
    expect(preview.blockers.join("\n")).toMatch(/shipped/);
    const err = await client.shippingLabels.reprint(ORDER_NUMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect(posts(calls)).toHaveLength(0);
  });

  it("treats a response for another order as indeterminate", async () => {
    const { client, calls } = setup("us", [
      orderRoute(shippedOrder),
      reprintOk(reprintResponse({ OrderNumber: "900000099" })),
    ]);
    const err = await client.shippingLabels.reprint(ORDER_NUMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect((err as IndeterminateOrderWriteError).operation).toBe("shippingLabels.reprint");
    expect(posts(calls)).toHaveLength(1);
  });

  it("treats an empty response as indeterminate and never resends on a 503", async () => {
    const empty = setup("us", [
      orderRoute(shippedOrder),
      reprintOk(reprintResponse({ PackageList: "" })),
    ]);
    await expect(empty.client.shippingLabels.reprint(ORDER_NUMBER)).rejects.toBeInstanceOf(
      IndeterminateOrderWriteError,
    );

    const down = setup("us", [
      orderRoute(shippedOrder),
      {
        method: "POST",
        pathPattern: paths.shippingLabelReprint,
        reply: () => ({ status: 503, body: "down" }),
      },
    ]);
    await expect(down.client.shippingLabels.reprint(ORDER_NUMBER)).rejects.toBeInstanceOf(
      IndeterminateOrderWriteError,
    );
    expect(posts(down.calls)).toHaveLength(1);
  });

  it("validates the order number before reading anything", async () => {
    const { client, calls } = setup("us", [orderRoute(shippedOrder), reprintOk()]);
    await expect(client.shippingLabels.reprint("abc")).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});
