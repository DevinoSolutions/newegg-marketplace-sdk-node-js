import { describe, expect, it } from "vitest";
import { NeweggValidationError, ReportTimeoutError } from "../src/errors/index.js";
import { getReportsPlatform } from "../src/platform/reports.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Item Basic Information / Order List / RMA List reports (contracts §17.6 / §17.8). All fixtures
 * are fictional placeholders - no real SKU, order number or customer data.
 */
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

const SUBMIT_OK = (type: string) => ({
  IsSuccess: true,
  OperationType: "ReportResponse",
  SellerID: "A006",
  ResponseBody: {
    ResponseList: [
      {
        RequestId: "REQ1",
        RequestType: type,
        RequestDate: "07/12/2014 11:34:57",
        RequestStatus: "SUBMITTED",
      },
    ],
  },
});

const STATUS = (status: string) => ({
  IsSuccess: true,
  OperationType: "GetReportStatusResponse",
  ResponseBody: {
    ResponseList: [{ RequestId: "REQ1", RequestType: "X", RequestStatus: status, TotalCount: 2 }],
  },
});

function pagedRoutes(opts: {
  type: string;
  listKey: string;
  rowsByPage: Array<unknown>;
  statuses?: string[];
  onResult?: (url: URL, body: unknown) => void;
}) {
  let statusCalls = 0;
  return [
    {
      method: "POST",
      pathPattern: paths.reportSubmit,
      reply: () => ({ status: 200, body: SUBMIT_OK(opts.type) }),
    },
    {
      method: "PUT",
      pathPattern: paths.reportStatus,
      reply: () => {
        const statuses = opts.statuses ?? ["FINISHED"];
        const status = statuses[Math.min(statusCalls, statuses.length - 1)] ?? "FINISHED";
        statusCalls += 1;
        return { status: 200, body: STATUS(status) };
      },
    },
    {
      method: "PUT",
      pathPattern: paths.reportResult,
      reply: (req: { url: URL; bodyJson?: unknown }) => {
        opts.onResult?.(req.url, req.bodyJson);
        const body = req.bodyJson as { RequestBody: { PageInfo: { PageIndex: number } } };
        const index = body.RequestBody.PageInfo.PageIndex;
        return {
          status: 200,
          body: {
            NeweggAPIResponse: {
              IsSuccess: "true",
              ResponseBody: {
                PageInfo: {
                  TotalCount: String(opts.rowsByPage.length),
                  TotalPageCount: String(opts.rowsByPage.length),
                  PageIndex: String(index),
                  PageSize: "100",
                },
                RequestID: "REQ1",
                RequestDate: "2/21/2012 14:38:17",
                ...(opts.rowsByPage[index - 1] !== undefined
                  ? { [opts.listKey]: opts.rowsByPage[index - 1] }
                  : {}),
              },
            },
          },
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// platform request builders
// ---------------------------------------------------------------------------
describe("platform/reports: Item Basic Information request", () => {
  it("is identical on every platform and sends no version query", () => {
    for (const marketplace of ["us", "b2b", "ca"] as const) {
      const platform = getReportsPlatform(marketplace).itemBasicInfo;
      expect(platform.resultOperationType).toBe("ItemBasicInfoReportRequest");
      expect(platform.buildRequest({})).toEqual({
        body: {
          OperationType: "ItemBasicInfoReportRequest",
          RequestBody: {
            ItemBasicInfoReportCriteria: {
              RequestType: "ITEM_BASIC_INFO_REPORT",
              Status: "0",
              FileType: "CSV",
            },
          },
        },
        query: {},
      });
    }
  });

  it("maps the status filter to 0/1/2 and rejects an unknown one", () => {
    const platform = getReportsPlatform("ca").itemBasicInfo;
    const statusOf = (status: "all" | "active" | "inactive") =>
      (
        platform.buildRequest({ status }).body as {
          RequestBody: { ItemBasicInfoReportCriteria: { Status: string } };
        }
      ).RequestBody.ItemBasicInfoReportCriteria.Status;
    expect(statusOf("all")).toBe("0");
    expect(statusOf("active")).toBe("1");
    expect(statusOf("inactive")).toBe("2");
    expect(() => platform.buildRequest({ status: "bogus" as never })).toThrowError(
      NeweggValidationError,
    );
  });
});

describe("platform/reports: Order List request", () => {
  it("builds the documented criteria with wire codes as strings", () => {
    const body = getReportsPlatform("ca").orderList.buildSubmit({
      status: "invoiced",
      keyword: { type: "sellerPartNumber", value: " SKU-1 " },
      type: "sbs",
      dateFrom: "2026-01-01",
      dateTo: "2026-02-01",
      voidSoon: 24,
      includeDownloaded: false,
    });
    expect(body).toEqual({
      OperationType: "OrderListReportRequest",
      RequestBody: {
        OrderReportCriteria: {
          RequestType: "ORDER_LIST_REPORT",
          KeywordsType: "4",
          KeywordsValue: "SKU-1",
          Status: "3",
          Type: "2",
          OrderDateFrom: "2026-01-01",
          OrderDateTo: "2026-02-01",
          VoidSoon: "24",
          OrderDownloaded: "true",
        },
      },
    });
  });

  it("defaults KeywordsType to 0 and Type to 0", () => {
    const body = getReportsPlatform("us").orderList.buildSubmit({ status: "unshipped" }) as {
      RequestBody: { OrderReportCriteria: Record<string, string> };
    };
    expect(body.RequestBody.OrderReportCriteria).toEqual({
      RequestType: "ORDER_LIST_REPORT",
      KeywordsType: "0",
      Status: "0",
      Type: "0",
    });
  });

  it("allows the country and Premier criteria on Newegg.com only", () => {
    const us = getReportsPlatform("us").orderList.buildSubmit({
      status: "shipped",
      countryCode: "USA",
      premierOrder: "premierOnly",
    }) as { RequestBody: { OrderReportCriteria: Record<string, string> } };
    expect(us.RequestBody.OrderReportCriteria).toMatchObject({
      CountryCode: "USA",
      PremierOrder: "1",
    });
    for (const marketplace of ["b2b", "ca"] as const) {
      const platform = getReportsPlatform(marketplace).orderList;
      expect(() => platform.buildSubmit({ status: "shipped", countryCode: "USA" })).toThrowError(
        /Newegg\.com only/,
      );
      expect(() =>
        platform.buildSubmit({ status: "shipped", premierOrder: "noPremier" }),
      ).toThrowError(NeweggValidationError);
    }
  });

  it("validates status, keyword, voidSoon, country and dates before any request", () => {
    const platform = getReportsPlatform("us").orderList;
    expect(() => platform.buildSubmit({ status: "unknown" as never })).toThrowError(
      NeweggValidationError,
    );
    expect(() =>
      platform.buildSubmit({ status: "shipped", keyword: { type: "orderNumber", value: " " } }),
    ).toThrowError(NeweggValidationError);
    expect(() => platform.buildSubmit({ status: "shipped", voidSoon: 12 as never })).toThrowError(
      /24 or 48/,
    );
    expect(() => platform.buildSubmit({ status: "shipped", countryCode: "us" })).toThrowError(
      /3-letter/,
    );
    expect(() => platform.buildSubmit({ status: "shipped", dateFrom: "2026-02-31" })).toThrowError(
      NeweggValidationError,
    );
    expect(() =>
      platform.buildSubmit({ status: "shipped", dateFrom: "2026-03-01", dateTo: "2026-02-01" }),
    ).toThrowError(/after/);
  });

  it("documents the result versions per platform", () => {
    expect(getReportsPlatform("us").orderList.versions).toEqual(["306", "307", "309", "310"]);
    expect(getReportsPlatform("b2b").orderList.versions).toEqual(["305", "306", "309"]);
    expect(getReportsPlatform("ca").orderList.versions).toEqual(["305", "309"]);
  });
});

describe("platform/reports: RMA List request", () => {
  it("builds the documented criteria (defaults 0)", () => {
    expect(getReportsPlatform("ca").rmaList.buildSubmit({})).toEqual({
      OperationType: "RMAListReportRequest",
      RequestBody: {
        RMAListReportCriteria: {
          RequestType: "RMA_LIST_REPORT",
          KeywordsType: "0",
          Status: "0",
          RMAType: "0",
          ProcessedBy: "0",
        },
      },
    });
    expect(
      getReportsPlatform("us").rmaList.buildSubmit({
        keyword: { type: "orderNumber", value: "123" },
        status: "closed",
        type: "refund",
        processedBy: "newegg",
        dateFrom: "2026-01-01",
        dateTo: "2026-06-30",
      }),
    ).toEqual({
      OperationType: "RMAListReportRequest",
      RequestBody: {
        RMAListReportCriteria: {
          RequestType: "RMA_LIST_REPORT",
          KeywordsType: "2",
          KeywordsValue: "123",
          Status: "5",
          RMADateFrom: "2026-01-01",
          RMADateTo: "2026-06-30",
          RMAType: "2",
          ProcessedBy: "2",
        },
      },
    });
  });

  it("rejects an empty keyword and inverted dates", () => {
    const platform = getReportsPlatform("ca").rmaList;
    expect(() => platform.buildSubmit({ keyword: { type: "rmaNumber", value: "" } })).toThrowError(
      NeweggValidationError,
    );
    expect(() =>
      platform.buildSubmit({ dateFrom: "2026-03-01", dateTo: "2026-02-01" }),
    ).toThrowError(/after/);
  });
});

// ---------------------------------------------------------------------------
// reports.orderList
// ---------------------------------------------------------------------------
const ORDER_INFO = {
  SellerID: "A006",
  OrderNumber: "100000001",
  InvoiceNumber: "200000001",
  OrderDate: "2/21/2012 14:38:17",
  OrderStatus: "3",
  OrderStatusDescription: "Invoiced",
  CustomerName: "Pat Placeholder",
  CustomerPhoneNumber: "555-0100",
  ShipToAddress1: "1 Example Street",
  OrderTotalAmount: "8.00",
  GSTorHSTAmount: "0.40",
  PSTorQSTAmount: "0.56",
  EHFAmount: "0.10",
  OrderQty: "1",
  PackageInfoList: [
    {
      PackageType: "Shipped",
      ShipCarrier: "Example Carrier",
      TrackingNumber: "TRK000000002",
      ShipDate: "2/22/2012 10:00:00",
      ItemInfoList: [{ SellerPartNumber: "SKU-1", MfrPartNumber: "MPN-1", ShippedQty: "1" }],
    },
  ],
  ItemInfoList: {
    ItemInfo: {
      SellerPartNumber: "SKU-1",
      NeweggItemNumber: "9SIEXAMPLE",
      OrderedQty: "1",
      ShippedQty: "1",
      Status: "2",
      StatusDescription: "Shipped",
    },
  },
};

describe("reports.orderList", () => {
  it("submits OrderListReportRequest, fetches pages with version=309 and parses Order rows", async () => {
    const seen: URL[] = [];
    const { client, calls } = makeClient(
      "ca",
      pagedRoutes({
        type: "ORDER_LIST_REPORT",
        listKey: "OrderInfoList",
        rowsByPage: [{ OrderInfo: ORDER_INFO }],
        onResult: (url) => seen.push(url),
      }),
    );
    const report = await client.reports.orderList.waitForResult({ status: "invoiced" }, FAST);
    expect(calls[0]?.bodyJson).toMatchObject({ OperationType: "OrderListReportRequest" });
    expect(calls[0]?.url.pathname).toBe("/marketplace/can/reportmgmt/report/submitrequest");
    expect(seen[0]?.searchParams.get("version")).toBe("309");
    expect(report.totalCount).toBe(1);
    expect(report.rows[0]).toMatchObject({
      orderNumber: "100000001",
      invoiceNumber: "200000001",
      status: "invoiced",
      amounts: { total: 8, gstOrHstAmount: 0.4, pstOrQstAmount: 0.56, ehfAmount: 0.1 },
      quantity: 1,
    });
    // Live-verified: package lines arrive nested under PackageInfo.ItemInfoList.
    expect(report.rows[0]?.packages[0]).toMatchObject({
      shipCarrier: "Example Carrier",
      trackingNumber: "TRK000000002",
      items: [{ sellerPartNumber: "SKU-1", mfrPartNumber: "MPN-1", shippedQty: 1 }],
    });
    expect(report.rows[0]?.items[0]).toMatchObject({
      sellerPartNumber: "SKU-1",
      status: "shipped",
    });
    // The SDK keeps the customer block (like orders.list); the MCP layer is what drops it.
    expect(report.rows[0]?.customer?.name).toBe("Pat Placeholder");
  });

  it("honors a documented version override and rejects an undocumented one before the request", async () => {
    const seen: URL[] = [];
    const { client } = makeClient(
      "us",
      pagedRoutes({
        type: "ORDER_LIST_REPORT",
        listKey: "OrderInfoList",
        rowsByPage: [{ OrderInfo: ORDER_INFO }],
        onResult: (url) => seen.push(url),
      }),
    );
    await client.reports.orderList.result("REQ1", 1, { version: "310" });
    expect(seen[0]?.searchParams.get("version")).toBe("310");
    await expect(
      client.reports.orderList.result("REQ1", 1, { version: "999" }),
    ).rejects.toThrowError(NeweggValidationError);
    expect(seen).toHaveLength(1);
  });

  it("returns an empty page when the list node is absent or a blank string", async () => {
    for (const list of [undefined, "", {}]) {
      const { client } = makeClient(
        "ca",
        pagedRoutes({
          type: "ORDER_LIST_REPORT",
          listKey: "OrderInfoList",
          rowsByPage: list === undefined ? [] : [list],
        }),
      );
      const page = await client.reports.orderList.result("REQ1", 1);
      expect(page.rows).toEqual([]);
    }
  });

  it("accepts a bare array of OrderInfo and ignores blank entries", async () => {
    const { client } = makeClient(
      "ca",
      pagedRoutes({
        type: "ORDER_LIST_REPORT",
        listKey: "OrderInfoList",
        rowsByPage: [[ORDER_INFO, "", { ...ORDER_INFO, OrderNumber: "100000002" }]],
      }),
    );
    const page = await client.reports.orderList.result("REQ1", 1);
    expect(page.rows.map((row) => row.orderNumber)).toEqual(["100000001", "100000002"]);
  });

  it("raises ReportTimeoutError with the requestId when the report is slow", async () => {
    const { client } = makeClient(
      "ca",
      pagedRoutes({
        type: "ORDER_LIST_REPORT",
        listKey: "OrderInfoList",
        rowsByPage: [],
        statuses: ["IN_PROGRESS"],
      }),
    );
    const error = await client.reports.orderList
      .waitForResult({ status: "shipped" }, { ...FAST, timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportTimeoutError);
    expect((error as ReportTimeoutError).requestId).toBe("REQ1");
  });

  it("validates input before any request", async () => {
    const { client, calls } = makeClient("ca", []);
    await expect(
      client.reports.orderList.submit({ status: "shipped", premierOrder: "premierOnly" }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reports.rmaList
// ---------------------------------------------------------------------------
const RMA_INFO = {
  SellerID: "A006",
  RMANumber: "300000001",
  RMAType: "2",
  RMATypeDescription: "Refund",
  RMADate: "2/21/2012 14:38:17",
  RMAStatus: "5",
  RMAStatusDescription: "Closed",
  OrderNumber: "100000001",
  OrderAmount: "8.00",
  RMAProcessedBy: "Seller",
  CustomerName: "Pat Placeholder",
  CustomerAddress: "1 Example Street",
  RMANote: "private note",
  RefundGSTorHSTAmount: "0.40",
  RefundPSTorQSTAmount: "0.56",
  ReturnShippingLabel: [
    { TrackingNumber: "TRK000000001", TrackingURL: "https://example.test/t", PaidBy: "Seller" },
  ],
  // Live-verified shape (CAN, 2026-10-10): the lines are a bare array and nest RefundInfo.
  RMATransactionList: [
    {
      SellerPartNumber: "SKU-1",
      NeweggItemNumber: "9SIEXAMPLE",
      UnitPrice: "8.00",
      RefundInfo: {
        ItemReturnQty: "1",
        ItemRefundPerQty: "8.00",
        ItemShippingRefund: "0.00",
        RMATotalRefund: "8.96",
        RefundReason: "2",
        RefundReasonDescription: "Defective",
      },
    },
  ],
};

describe("reports.rmaList", () => {
  it("submits RMAListReportRequest, fetches pages with version=320 and parses Rma rows", async () => {
    const seen: URL[] = [];
    const { client, calls } = makeClient(
      "ca",
      pagedRoutes({
        type: "RMA_LIST_REPORT",
        listKey: "RMAInfoList",
        rowsByPage: [{ RMAInfo: RMA_INFO }],
        onResult: (url) => seen.push(url),
      }),
    );
    const report = await client.reports.rmaList.waitForResult({}, FAST);
    expect(calls[0]?.bodyJson).toMatchObject({ OperationType: "RMAListReportRequest" });
    expect(seen[0]?.searchParams.get("version")).toBe("320");
    expect(report.rows[0]).toMatchObject({
      rmaNumber: "300000001",
      type: "refund",
      status: "closed",
      orderNumber: "100000001",
      orderAmount: 8,
      processedBy: "seller",
    });
    expect(report.rows[0]?.items[0]).toMatchObject({ sellerPartNumber: "SKU-1", unitPrice: 8 });
  });

  it("flattens the nested RefundInfo of each line and reads the CAN tax refunds", async () => {
    const { client } = makeClient(
      "ca",
      pagedRoutes({
        type: "RMA_LIST_REPORT",
        listKey: "RMAInfoList",
        rowsByPage: [[RMA_INFO]],
      }),
    );
    const page = await client.reports.rmaList.result("REQ1", 1);
    expect(page.rows[0]).toMatchObject({
      refundGstOrHstAmount: 0.4,
      refundPstOrQstAmount: 0.56,
      returnLabel: { trackingNumber: "TRK000000001", paidBy: "Seller" },
    });
    expect(page.rows[0]?.items[0]).toMatchObject({
      sellerPartNumber: "SKU-1",
      reasonCode: 2,
      neweggItemNumber: "9SIEXAMPLE",
      unitPrice: 8,
      returnQuantity: 1,
      returnUnitPrice: 8,
      refundShippingPrice: 0,
      rmaTotalRefund: 8.96,
      reason: "defective",
      reasonDescription: "Defective",
    });
  });

  it("rejects a version the platform does not document", async () => {
    const { client } = makeClient(
      "ca",
      pagedRoutes({ type: "RMA_LIST_REPORT", listKey: "RMAInfoList", rowsByPage: [] }),
    );
    await expect(client.reports.rmaList.result("REQ1", 1, { version: "307" })).rejects.toThrowError(
      /305, 309, 320/,
    );
  });

  it("returns an empty page for a missing or blank list", async () => {
    for (const list of [undefined, ""]) {
      const { client } = makeClient(
        "ca",
        pagedRoutes({
          type: "RMA_LIST_REPORT",
          listKey: "RMAInfoList",
          rowsByPage: list === undefined ? [] : [list],
        }),
      );
      expect((await client.reports.rmaList.result("REQ1", 1)).rows).toEqual([]);
    }
  });
});
