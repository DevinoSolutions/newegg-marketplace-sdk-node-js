import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNeweggClient,
  IndeterminateOrderWriteError,
  NeweggApiError,
  type ShippingLabelInput,
} from "../src/index.js";
import { Operation, isReadOperation } from "../src/client/operations.js";
import { createMockFetch, type MockRoute } from "../src/testing/index.js";
import { makeClient, paths, TEST_API_KEY, TEST_SECRET_KEY, US_SINGLE_ITEM } from "./helpers.js";
import { ORDER_NUMBER, SKU, orderResponse } from "./service-write-helpers.js";

/**
 * A write must never follow a redirect: a 307/308 would replay the POST/PUT body (and the credential
 * headers) at whatever host the response names. Reads follow only same-origin redirects (read-redirects.test.ts). Which is which is
 * decided per operation, never by the HTTP verb: the US inventory URL is read-on-PUT / write-on-POST
 * and order-info is a READ via PUT. Nothing here touches Newegg; the end-to-end cases talk to a
 * server on 127.0.0.1.
 */

const READ_OPERATIONS = [
  Operation.GetItem,
  Operation.GetMany,
  Operation.PriceGet,
  Operation.FeedStatus,
  Operation.FeedResult,
  Operation.ServiceStatus,
  Operation.OrderList,
  Operation.OrderStatus,
  Operation.OrderAdditionalInfo,
  Operation.RmaList,
  Operation.RefundList,
  Operation.RefundRequestStatus,
  Operation.SellerStatus,
  Operation.IndustryList,
  Operation.SubcategoryStatus,
  Operation.SubcategoryProperties,
  Operation.PropertyValues,
  Operation.SbnShipmentList,
  Operation.SbnRequestStatus,
  Operation.SbnRequestResult,
  Operation.SbnWarehouseList,
  Operation.AdsCampaigns,
  Operation.AdsGroups,
  Operation.AdsProducts,
  Operation.AdsKeywords,
  Operation.AdsKeywordSuggest,
  Operation.AdsNegativeKeywords,
  Operation.AdsMatchTypes,
  Operation.AdsTargetingCategories,
  Operation.AdsTargetingItems,
  Operation.AdsGroupPerformance,
  Operation.AdsProductPerformance,
  Operation.AdsKeywordPerformance,
  Operation.CatalogLookupSubmit,
  Operation.CatalogLookupStatus,
  Operation.CatalogLookupResult,
  Operation.ReportSubmit,
  Operation.ReportStatus,
  Operation.ReportResult,
  Operation.VolumeDiscountGet,
];

const WRITE_OPERATIONS = [
  Operation.UpdateDirect,
  Operation.PriceUpdate,
  Operation.FeedSubmit,
  Operation.OrderShip,
  Operation.OrderCancel,
  Operation.OrderConfirm,
  Operation.OrderRemoveItem,
  Operation.RmaSubmit,
  Operation.RmaEdit,
  Operation.RmaReceive,
  Operation.RmaReject,
  Operation.RefundIssue,
  Operation.ShippingLabelEstimate,
  Operation.ShippingLabelCreate,
  Operation.ShippingLabelReprint,
];

describe("operation classification", () => {
  it("treats reads as reads and writes as writes, whatever the HTTP verb", () => {
    for (const operation of READ_OPERATIONS)
      expect(isReadOperation(operation), operation).toBe(true);
    for (const operation of WRITE_OPERATIONS) {
      expect(isReadOperation(operation), operation).toBe(false);
    }
  });

  it("classifies every operation, and fails closed on an unknown one", () => {
    const covered = new Set<string>([...READ_OPERATIONS, ...WRITE_OPERATIONS]);
    for (const operation of Object.values(Operation)) {
      expect(covered.has(operation), `${operation} is not covered by this test`).toBe(true);
    }
    expect(isReadOperation("something.new")).toBe(false);
    expect(isReadOperation("")).toBe(false);
  });
});

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

function unshippedOrder(): unknown {
  const base = orderResponse({
    OrderStatus: 0,
    OrderStatusDescription: "Unshipped",
    ShipToCountryCode: "US",
  }) as {
    ResponseBody: { OrderInfoList: Array<{ ItemInfoList: Array<Record<string, unknown>> }> };
  };
  const row = base.ResponseBody.OrderInfoList[0];
  if (row !== undefined) {
    row.ItemInfoList = row.ItemInfoList.map((item) => ({ ...item, ShippedQty: 0, Status: 0 }));
  }
  return base;
}

const orderRoute: MockRoute = {
  method: "PUT",
  pathPattern: paths.orderInfo,
  reply: () => ({ status: 200, body: unshippedOrder() }),
};

/** A mock client whose fetch records the `redirect` mode every request was sent with. */
function spyClient(routes: MockRoute[]) {
  const { fetch: mock, calls } = createMockFetch(routes);
  const modes: Array<RequestInit["redirect"]> = [];
  const { client } = makeClient("us", [], {
    fetch: (target, init) => {
      modes.push(init?.redirect);
      return mock(target, init);
    },
  });
  return { client, calls, modes };
}

describe("redirect mode per request", () => {
  it("follows redirects on a read, even one sent with PUT (order-info)", async () => {
    const { client, modes } = spyClient([orderRoute]);
    await client.orders.get(ORDER_NUMBER);
    expect(modes).toEqual(["manual"]);
  });

  it("follows redirects on the US inventory read (PUT) but not on its write (POST)", async () => {
    const { client, modes } = spyClient([
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
      },
      { method: "POST", pathPattern: paths.usInventory, reply: () => ({ status: 200, body: {} }) },
    ]);
    await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "A006BSP3" },
    });
    await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(modes).toEqual(["manual", "error"]);
  });

  it("refuses redirects on the label estimate and purchase", async () => {
    const { client, modes } = spyClient([
      orderRoute,
      {
        method: "POST",
        pathPattern: paths.shippingLabelEstimate,
        reply: () => ({ status: 200, body: {} }),
      },
      {
        method: "POST",
        pathPattern: paths.shippingLabelCreate,
        reply: () => ({ status: 200, body: {} }),
      },
    ]);
    await client.shippingLabels.estimate(input).catch(() => undefined);
    await client.shippingLabels.create(input).catch(() => undefined);
    // [estimate POST, order read, create POST]
    expect(modes).toEqual(["error", "manual", "error"]);
  });
});

describe.each([307, 308])("a %i answered to a write (mock fetch)", (status) => {
  const redirectTo = "https://elsewhere.example/steal";
  const redirectReply = () => ({ status, headers: { Location: redirectTo }, body: undefined });

  it("is not followed and not retried on a retried-class write (direct inventory update)", async () => {
    const { client, calls } = makeClient("us", [
      { method: "POST", pathPattern: paths.usInventory, reply: redirectReply },
    ]);
    const result = await client.inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("failed");
    expect(result.items[0]?.message).toMatch(/redirect/i);
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.hostname === "elsewhere.example")).toBe(false);
  });

  it("is reported once as a single attempt on the label estimate", async () => {
    const { client, calls } = makeClient("us", [
      { method: "POST", pathPattern: paths.shippingLabelEstimate, reply: redirectReply },
    ]);
    const err = await client.shippingLabels.estimate(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).retryable).toBe(false);
    expect((err as NeweggApiError).message).toMatch(/redirect/i);
    expect(calls).toHaveLength(1);
  });

  it("becomes the indeterminate-write error on a label purchase and is never resent", async () => {
    const { client, calls } = makeClient("us", [
      orderRoute,
      { method: "POST", pathPattern: paths.shippingLabelCreate, reply: redirectReply },
    ]);
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.some((call) => call.url.hostname === "elsewhere.example")).toBe(false);
  });
});

describe("redirects against a real HTTP server (global fetch)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const closing = server;
    server = undefined;
    if (closing !== undefined) await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  /** Starts a loopback server; `hits` records `METHOD /path` of every request it receives. */
  async function serve(
    handle: (req: IncomingMessage, res: ServerResponse, hits: string[]) => void,
  ) {
    const hits: string[] = [];
    server = createServer((req, res) => {
      hits.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
      req.resume();
      req.on("end", () => handle(req, res, hits));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server?.address() as AddressInfo;
    const client = createNeweggClient({
      sellerId: "A006",
      apiKey: TEST_API_KEY,
      secretKey: TEST_SECRET_KEY,
      marketplace: "us",
      baseUrl: `http://127.0.0.1:${port}/marketplace/`,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
    return { client, hits };
  }

  const json = (res: ServerResponse, body: unknown): void => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  it("still follows a redirect on a read", async () => {
    const { client, hits } = await serve((req, res) => {
      if (req.url?.startsWith("/marketplace/moved")) return json(res, US_SINGLE_ITEM);
      res.statusCode = 307;
      res.setHeader("Location", "/marketplace/moved/inventory");
      res.end();
    });
    const snapshot = await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "A006BSP3" },
    });
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(hits.some((hit) => hit.startsWith("PUT /marketplace/moved"))).toBe(true);
  });

  it.each([307, 308])(
    "does not follow a %i on a write: the redirect target is never contacted and nothing is retried",
    async (status) => {
      const { client, hits } = await serve((req, res) => {
        if (req.url?.startsWith("/marketplace/moved")) return json(res, {});
        res.statusCode = status;
        res.setHeader("Location", "/marketplace/moved/inventory");
        res.end();
      });
      const result = await client.inventory.updateItem({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 5,
        warehouseLocation: "USA",
      });
      expect(result.items[0]?.status).toBe("failed");
      expect(result.items[0]?.message).toMatch(/redirect/i);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatch(/^POST /);
    },
  );

  it("reports a redirected label purchase as indeterminate (the request had been received)", async () => {
    const { client, hits } = await serve((req, res) => {
      if (req.method === "PUT") return json(res, unshippedOrder());
      res.statusCode = 308;
      res.setHeader("Location", "/marketplace/moved/label");
      res.end();
    });
    const err = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateOrderWriteError);
    expect(hits.filter((hit) => hit.startsWith("POST "))).toHaveLength(1);
    expect(hits.some((hit) => hit.includes("/moved/"))).toBe(false);
  });
});
