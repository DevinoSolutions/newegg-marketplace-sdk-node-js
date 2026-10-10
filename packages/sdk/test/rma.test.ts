import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggRateLimitError,
  NeweggValidationError,
  type NeweggMarketplace,
} from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Get RMA Information fixtures modeled on the official §18.1 samples. All identifiers, names,
 * addresses and amounts are fictional placeholders (the repo is public).
 */
const RMA_FULL = {
  RMANumber: "900000001",
  RMAType: "2",
  RMATypeDescription: "Refund",
  SellerRMANumber: "SELLER-RMA-1",
  IssueUser: "A006",
  RMADate: "12/19/2012 00:06:30",
  RMAStatus: "5",
  RMAStatusDescription: "Closed",
  RMAShipMethod: "",
  RMAShipMethodDescription: "",
  OrderNumber: "900000002",
  OrderDate: "12/18/2012 23:00:09",
  InvoiceNumber: "900000003",
  OrderAmount: "3.99",
  AvailableRefundAmount: "0.00",
  RMAProcessedBy: "Seller",
  RMAReceiveDate: "01/09/2013 18:40:28",
  RMANote: "customer note",
  PriorRefundAmount: "0.00",
  CustomerName: "Pat Example",
  CustomerPhoneNumber: "555-010-0100",
  CustomerEmailAddress: "relay@marketplace.newegg.com",
  ShipToAddress1: "1 Example Way",
  ShipToAddress2: "",
  ShipToCityName: "Exampleville",
  ShipToStateCode: "CA",
  ShipToZipCode: "00000",
  ShipToCountryCode: "UNITED STATES",
  ShipToLastName: "Example",
  ShipToFirstName: "Pat",
  ShipToCompany: "",
  ReturnShippingLabel: {
    Label: {
      TrackingNumber: "TRACK0001",
      TrackingURL: "http://example.invalid/track?number=TRACK0001",
      LabelEstimateCost: "6.19",
      PaidBy: "Seller",
    },
  },
  RMATransactionList: {
    RMATransaction: {
      SellerPartNumber: "SKU-PLACEHOLDER",
      MfrPartNumber: "MFR-PLACEHOLDER",
      NeweggItemNumber: "9SIA0000000000",
      Description: "Placeholder item",
      UnitPrice: "3.99",
      ReturnQuantity: "1",
      ReturnUnitPrice: "3.99",
      RefundShippingPrice: "0.00",
      ShippedBy: "",
      RMAReason: "4",
      RMAReasonDescription: "No longer needed",
      UnOpen: "1",
      Memo: "item memo",
    },
  },
};

const wrapped = (list: unknown, page: Record<string, unknown> = {}) => ({
  NeweggAPIResponse: {
    IsSuccess: "true",
    OperationType: "GetRMAInfo",
    SellerID: "A006",
    ResponseBody: {
      PageInfo: { TotalCount: "1", TotalPageCount: "1", PageIndex: "1", PageSize: "100", ...page },
      RMAInfoList: list,
    },
    ResponseDate: "03/06/2020 16:22:42",
  },
});

function rmaRoute(reply: () => { status: number; body?: unknown }) {
  return [{ method: "PUT", pathPattern: paths.rmaInfo, reply }];
}

describe("rma.list", () => {
  it("sends Get RMA Information as a PUT with sellerid + version and string-valued criteria", async () => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    await client.rma.list({
      keyword: { type: "orderNumber", value: " 900000002 " },
      status: "closed",
      type: "refund",
      processedBy: "newegg",
      dateFrom: new Date("2023-06-15T20:30:00.000Z"),
      dateTo: "2023-06-16",
      page: 2,
      pageSize: 50,
    });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/servicemgmt/rma/rmainfo");
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.url.searchParams.get("version")).toBe("320");
    expect(call.bodyJson).toEqual({
      OperationType: "GetRMAInfoRequest",
      RequestBody: {
        PageInfo: { PageIndex: "2", PageSize: "50" },
        KeywordsType: "2",
        KeywordsValue: "900000002",
        Status: "5",
        RMADateFrom: "2023-06-15 13:30:00",
        RMADateTo: "2023-06-16",
        RMAType: "2",
        ProcessedBy: "2",
      },
    });
  });

  it("emits only paging when no criteria are set", async () => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped([]) })),
    );
    await client.rma.list();
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetRMAInfoRequest",
      RequestBody: { PageInfo: { PageIndex: "1", PageSize: "100" } },
    });
  });

  it.each([
    ["us", "/marketplace/servicemgmt/rma/rmainfo", "USD"],
    ["b2b", "/marketplace/b2b/servicemgmt/rma/rmainfo", "USD"],
    ["ca", "/marketplace/can/servicemgmt/rma/rmainfo", "CAD"],
  ] as const)("uses the %s path prefix and currency", async (marketplace, pathname, currency) => {
    const { client, calls } = makeClient(
      marketplace,
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    const page = await client.rma.list();
    expect(calls[0]!.url.pathname).toBe(pathname);
    expect(page.currency).toBe(currency);
    expect(page.marketplace).toBe(marketplace);
  });

  it.each([
    ["us", "307", true],
    ["us", "309", true],
    ["us", "305", false],
    ["b2b", "305", true],
    ["ca", "305", true],
    ["ca", "307", false],
    ["ca", "999", false],
  ] as Array<[NeweggMarketplace, string, boolean]>)(
    "%s accepts version %s: %s",
    async (marketplace, version, accepted) => {
      const { client, calls } = makeClient(
        marketplace,
        rmaRoute(() => ({ status: 200, body: wrapped([]) })),
      );
      const run = client.rma.list({ version });
      if (accepted) {
        await run;
        expect(calls[0]!.url.searchParams.get("version")).toBe(version);
      } else {
        await expect(run).rejects.toBeInstanceOf(NeweggValidationError);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it("maps a fully populated RMA (single-object wrappers, string numbers, 0/1 booleans)", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    const page = await client.rma.list();
    expect(page).toMatchObject({ page: 1, pageSize: 100, totalCount: 1, totalPageCount: 1 });
    const rma = page.rmas[0]!;
    expect(rma).toMatchObject({
      rmaNumber: "900000001",
      type: "refund",
      sellerRmaNumber: "SELLER-RMA-1",
      status: "closed",
      orderNumber: "900000002",
      invoiceNumber: "900000003",
      orderAmount: 3.99,
      availableRefundAmount: 0,
      priorRefundAmount: 0,
      processedBy: "seller",
      note: "customer note",
      returnLabel: { trackingNumber: "TRACK0001", estimatedCost: 6.19, paidBy: "Seller" },
    });
    expect(rma.rmaDate).toEqual({ raw: "12/19/2012 00:06:30", iso: "2012-12-19T08:06:30.000Z" });
    expect(rma.customer?.shipTo?.city).toBe("Exampleville");
    expect(rma.items).toHaveLength(1);
    expect(rma.items[0]).toMatchObject({
      sellerPartNumber: "SKU-PLACEHOLDER",
      unitPrice: 3.99,
      returnQuantity: 1,
      returnUnitPrice: 3.99,
      reason: "noLongerNeeded",
      reasonCode: 4,
      unopened: true,
      memo: "item memo",
    });
    expect(rma.items[0]!.shippedBy).toBeUndefined();
  });

  it("tolerates arrays, numeric wire values, a missing wrapper and flat label fields", async () => {
    const { client } = makeClient(
      "ca",
      rmaRoute(() => ({
        status: 200,
        body: {
          ResponseBody: {
            PageInfo: { TotalCount: 2, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
            RMAInfoList: [
              {
                RMANumber: 900000010,
                RMAType: 1,
                RMAStatus: 1,
                ReplacementOrderNumber: 900000011,
                RMAShipMethod: 4,
                RMAShipMethodDescription: "Two-Day Shipping(2 business days)",
                TrackingNumber: "FLAT0001",
                LabelEstimateCost: 7.5,
                RMATransactionList: [
                  { RMAReason: 2, ShippedBy: 1 },
                  { RMAReason: 7, ShippedBy: 0 },
                ],
              },
              { RMANumber: "900000012", RMAType: 9, RMAStatus: 42 },
            ],
          },
        },
      })),
    );
    const { rmas } = await client.rma.list();
    expect(rmas).toHaveLength(2);
    expect(rmas[0]).toMatchObject({
      rmaNumber: "900000010",
      type: "replacement",
      status: "open",
      replacementOrderNumber: "900000011",
      shipMethod: 4,
      returnLabel: { trackingNumber: "FLAT0001", estimatedCost: 7.5 },
    });
    expect(rmas[0]!.items.map((item) => [item.reason, item.shippedBy])).toEqual([
      ["defective", "newegg"],
      ["sentWrongItem", "seller"],
    ]);
    // Unrecognized codes degrade to "unknown" instead of throwing.
    expect(rmas[1]).toMatchObject({ type: "unknown", status: "unknown", items: [] });
  });

  it("reads the first label when ReturnShippingLabel.Label is an array", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({
        status: 200,
        body: wrapped({
          RMAInfo: {
            RMANumber: "1",
            ReturnShippingLabel: { Label: [{ TrackingNumber: "A" }, { TrackingNumber: "B" }] },
          },
        }),
      })),
    );
    expect((await client.rma.list()).rmas[0]!.returnLabel?.trackingNumber).toBe("A");
  });

  it("returns an empty page when the account has no RMAs", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({
        status: 200,
        body: wrapped(undefined, { TotalCount: "0", TotalPageCount: "0" }),
      })),
    );
    const page = await client.rma.list({ pageSize: 10 });
    expect(page.rmas).toEqual([]);
    expect(page).toMatchObject({ totalCount: 0, totalPageCount: 0, page: 1 });
  });

  it("falls back to the requested paging when the response omits PageInfo", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: { ResponseBody: { RMAInfoList: [] } } })),
    );
    const page = await client.rma.list({ page: 3, pageSize: 7 });
    expect(page).toMatchObject({ page: 3, pageSize: 7 });
  });

  it("treats an empty 200 body as an empty result", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: "" })),
    );
    expect((await client.rma.list()).rmas).toEqual([]);
  });

  it("throws NeweggApiError when the envelope says IsSuccess=false", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({
        status: 200,
        body: { NeweggAPIResponse: { IsSuccess: "false", Memo: "nope" } },
      })),
    );
    await expect(client.rma.list()).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("includes the raw payload only when asked", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    expect((await client.rma.list()).raw).toBeUndefined();
    expect((await client.rma.list({}, { includeRaw: true })).raw).toBeDefined();
  });

  it.each([
    [{ pageSize: 101 }, "pageSize"],
    [{ pageSize: 0 }, "pageSize"],
    [{ page: 0 }, "page"],
    [{ keyword: { type: "rmaNumber" as const, value: "  " } }, "keyword.value"],
    [{ dateFrom: new Date("nope") }, "dateFrom"],
    [{ dateTo: " " }, "dateTo"],
  ])("rejects invalid input %j before sending", async (input, path) => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped([]) })),
    );
    const error = await client.rma.list(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggValidationError);
    expect((error as NeweggValidationError).issues.map((issue) => issue.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });
});

describe("rma.get / rma.tryGet", () => {
  it("looks an RMA up by number with a rmaNumber keyword and returns the exact match", async () => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    const rma = await client.rma.get(900000001);
    expect(rma.rmaNumber).toBe("900000001");
    const criteria = (calls[0]!.bodyJson as { RequestBody: Record<string, unknown> }).RequestBody;
    expect(criteria).toMatchObject({ KeywordsType: "1", KeywordsValue: "900000001" });
    expect((criteria.PageInfo as { PageSize: string }).PageSize).toBe("1");
  });

  it("tryGet resolves undefined when nothing (or only a different RMA) comes back", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped({ RMAInfo: RMA_FULL }) })),
    );
    expect(await client.rma.tryGet("123")).toBeUndefined();
    await expect(client.rma.get("123")).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("rejects a non-numeric RMA number without sending", async () => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 200, body: wrapped([]) })),
    );
    await expect(client.rma.tryGet("12 OR 1=1")).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("rma error shapes", () => {
  it("maps a JSON-array error body (CE001)", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({
        status: 400,
        body: [{ Code: "CE001", Message: "SellerID cannot be null or empty" }],
      })),
    );
    const error = (await client.rma.list().catch((e: unknown) => e)) as NeweggApiError;
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBe("CE001");
    expect(error.httpStatus).toBe(400);
  });

  it("maps an XML error body", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({
        status: 400,
        body: '<?xml version="1.0"?><Errors><Error><Code>CE001</Code><Message>bad</Message></Error></Errors>',
      })),
    );
    const error = (await client.rma.list().catch((e: unknown) => e)) as NeweggApiError;
    expect(error.neweggErrorCode).toBe("CE001");
  });

  it("maps a plain-text error body", async () => {
    const { client } = makeClient(
      "us",
      rmaRoute(() => ({ status: 400, body: "Bad request: version is invalid" })),
    );
    const error = (await client.rma.list().catch((e: unknown) => e)) as NeweggApiError;
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error.neweggErrorCode).toBeUndefined();
  });

  it("surfaces an exhausted 429 as NeweggRateLimitError", async () => {
    const { client, calls } = makeClient(
      "us",
      rmaRoute(() => ({ status: 429, body: [{ Code: "429", Message: "Too many requests" }] })),
    );
    await expect(client.rma.list()).rejects.toBeInstanceOf(NeweggRateLimitError);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
