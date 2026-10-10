import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggRateLimitError,
  NeweggValidationError,
  ReportTimeoutError,
  UnsupportedMarketplaceOperationError,
} from "../src/errors/index.js";
import {
  buildFileResultRequest,
  buildPagedResultRequest,
  buildSettlementSummarySubmit,
  buildSettlementTransactionsSubmit,
  asAmount,
  inventoryRowFromRecord,
  parseSettlementSummaryPage,
  parseSettlementTransactionsPage,
  priceRowFromRecord,
  recordsFromRows,
} from "../src/reports/parse.js";
import {
  validateSettlementSummaryInput,
  validateSettlementTransactionsInput,
} from "../src/reports/validate.js";
import { parseDelimited } from "../src/reportmgmt/csv.js";
import { buildZip, makeClient, paths } from "./helpers.js";

const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

const SUBMIT_OK = (type: string) => ({
  IsSuccess: true,
  OperationType: "ReportResponse",
  SellerID: "a001",
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

// ---------------------------------------------------------------------------
// validation + builders
// ---------------------------------------------------------------------------
describe("settlement summary input", () => {
  it("accepts YYYY-MM-DD, wall-clock strings and Dates (rendered as Pacific dates)", () => {
    expect(
      validateSettlementSummaryInput({ dateFrom: "2026-09-01", dateTo: "9/30/2026 23:59:59" }),
    ).toEqual({ dateFrom: "2026-09-01", dateTo: "9/30/2026 23:59:59" });
    // 2026-10-01T05:00Z is still 2026-09-30 22:00 in Pacific (PDT).
    expect(
      validateSettlementSummaryInput({
        dateFrom: new Date("2026-10-01T05:00:00Z"),
        dateTo: new Date("2026-10-01T20:00:00Z"),
      }),
    ).toEqual({ dateFrom: "2026-09-30", dateTo: "2026-10-01" });
  });

  it("rejects bad, impossible and inverted dates with per-field issues", () => {
    const error = (() => {
      try {
        validateSettlementSummaryInput({ dateFrom: "2026-02-31", dateTo: "soon" });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(NeweggValidationError);
    expect((error as NeweggValidationError).issues.map((i) => i.path)).toEqual([
      "dateFrom",
      "dateTo",
    ]);
    expect(() =>
      validateSettlementSummaryInput({ dateFrom: "2026-10-02", dateTo: "2026-10-01" }),
    ).toThrowError(NeweggValidationError);
    expect(() =>
      validateSettlementSummaryInput({ dateFrom: new Date("nope"), dateTo: "2026-10-01" }),
    ).toThrowError(NeweggValidationError);
  });

  it("builds the documented submit body (§17.2)", () => {
    expect(buildSettlementSummarySubmit({ dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toEqual({
      OperationType: "SettlementSummaryReportRequest",
      RequestBody: {
        SettlementSummaryReportCriteria: {
          RequestType: "SETTLEMENT_SUMMARY_REPORT",
          DateFrom: "2026-09-01",
          DateTo: "2026-09-30",
        },
      },
    });
  });
});

describe("settlement transactions input", () => {
  it("requires settlementId, settlementDate, or a from+to range (RP020) before any request", () => {
    expect(() => validateSettlementTransactionsInput({})).toThrowError(/RP020/);
    expect(() => validateSettlementTransactionsInput({ transactionType: "order" })).toThrowError(
      /RP020/,
    );
    expect(() =>
      validateSettlementTransactionsInput({ settlementDateFrom: "2026-09-01" }),
    ).toThrowError(NeweggValidationError);
    expect(validateSettlementTransactionsInput({ settlementId: 42 }).settlementId).toBe("42");
    expect(validateSettlementTransactionsInput({ settlementDate: "2026-09-15" })).toMatchObject({
      settlementDate: "2026-09-15",
      transactionTypeCode: 0,
    });
  });

  it("validates ids and ranges", () => {
    expect(() =>
      validateSettlementTransactionsInput({ settlementId: "12a", settlementDate: "2026-09-01" }),
    ).toThrowError(NeweggValidationError);
    expect(() =>
      validateSettlementTransactionsInput({
        settlementDateFrom: "2026-09-10",
        settlementDateTo: "2026-09-01",
      }),
    ).toThrowError(/after/);
    expect(() =>
      validateSettlementTransactionsInput({
        settlementDate: "2026-09-01",
        orderNumber: "x",
      }),
    ).toThrowError(NeweggValidationError);
  });

  it("maps transaction types to the wire codes (§17.3) and builds the body", () => {
    const criteria = validateSettlementTransactionsInput({
      settlementDateFrom: "2026-09-01",
      settlementDateTo: "2026-09-30",
      transactionType: "sponsoredAds",
      orderNumber: 123,
    });
    expect(criteria.transactionTypeCode).toBe(31);
    expect(buildSettlementTransactionsSubmit(criteria)).toEqual({
      OperationType: "SettlementTransactionReportRequest",
      RequestBody: {
        SettlementTransactionReportCriteria: {
          RequestType: "SETTLEMENT_TRANSACTION_REPORT",
          TransactionType: "31",
          OrderNumber: "123",
          SettlementDateFrom: "2026-09-01",
          SettlementDateTo: "2026-09-30",
        },
      },
    });
    expect(
      validateSettlementTransactionsInput({ settlementId: 1, transactionType: "itemOverageFee" })
        .transactionTypeCode,
    ).toBe(32);
    expect(() =>
      validateSettlementTransactionsInput({
        settlementId: 1,
        transactionType: "bogus" as never,
      }),
    ).toThrowError(NeweggValidationError);
  });

  it("builds paged and file result requests", () => {
    expect(buildPagedResultRequest("SettlementSummaryReportRequest", "R1", 3)).toEqual({
      OperationType: "SettlementSummaryReportRequest",
      RequestBody: { RequestID: "R1", PageInfo: { PageIndex: 3, PageSize: 100 } },
    });
    expect(buildFileResultRequest("InternationalInventoryReportRequest", "R1")).toEqual({
      OperationType: "InternationalInventoryReportRequest",
      RequestBody: { RequestID: "R1" },
    });
  });
});

// ---------------------------------------------------------------------------
// parsers (fixtures use the docs' placeholder values, never account data)
// ---------------------------------------------------------------------------
describe("asAmount", () => {
  it("reads strings, thousands separators, parentheses and rejects junk", () => {
    expect(asAmount("102.95")).toBe(102.95);
    expect(asAmount("-1.98")).toBe(-1.98);
    expect(asAmount("1,234.50")).toBe(1234.5);
    expect(asAmount("(12.00)")).toBe(-12);
    expect(asAmount("$5")).toBe(5);
    expect(asAmount(7)).toBe(7);
    expect(asAmount("null")).toBeUndefined();
    expect(asAmount("")).toBeUndefined();
    expect(asAmount("n/a")).toBeUndefined();
    expect(asAmount({})).toBeUndefined();
  });
});

const SUMMARY_ROW = {
  SettlementDate: "2/21/2012 12:00:00",
  SettlementDateFrom: "8/5/2011 12:00:00",
  SettlementDateTo: "2/21/2012 12:00:00",
  SettlementID: "0",
  ItemPrice: "71.00",
  Shipping: "31.95",
  Other: "0.00",
  TotalOrderAmount: "102.95",
  Refunds: "-1.98",
  NeweggStorageFee: "-59.05",
  NeweggRMABuyoutFee: "-0.72",
  TotalNeweggFee: "-638.63",
  TotalSettlement: "(720.19)",
  ReservedBalance: "12.22",
  PreviousReservedBalance: "1.22",
  SalerTaxFeeCollectedFromCustomer: "-1.10",
  SalesTaxFeesLiabilityShiftToNewegg: "1.10",
  CheckNumber: [],
  Memo: "null",
  SomeFutureField: "abc",
};

describe("parseSettlementSummaryPage", () => {
  it("parses the wrapped documented shape (strings, typo key, empty CheckNumber array)", () => {
    const page = parseSettlementSummaryPage({
      NeweggAPIResponse: {
        IsSuccess: "true",
        ResponseBody: {
          PageInfo: { TotalCount: "1", TotalPageCount: "1", PageSize: "10", PageIndex: "1" },
          RequestID: "R1",
          RequestDate: "2/21/2012 15:12:55",
          SettlementSummaryList: [SUMMARY_ROW],
        },
      },
    });
    expect(page).toMatchObject({ page: 1, pageSize: 10, totalCount: 1, totalPageCount: 1 });
    expect(page.requestDate?.raw).toBe("2/21/2012 15:12:55");
    const row = page.rows[0];
    expect(row).toMatchObject({
      settlementId: "0",
      itemPrice: 71,
      shipping: 31.95,
      other: 0,
      totalOrderAmount: 102.95,
      refunds: -1.98,
      neweggStorageFee: -59.05,
      neweggRmaBuyoutFee: -0.72,
      totalNeweggFee: -638.63,
      totalSettlement: -720.19,
      reservedBalance: 12.22,
      previousReservedBalance: 1.22,
      salesTaxFeeCollectedFromCustomer: -1.1,
      salesTaxFeesLiabilityShiftToNewegg: 1.1,
      unmapped: { SomeFutureField: "abc" },
    });
    expect(row?.settlementDate?.raw).toBe("2/21/2012 12:00:00");
    expect(row?.settlementDate?.iso).toBeDefined();
    expect(row?.checkNumber).toBeUndefined();
    expect(row?.memo).toBeUndefined();
  });

  it("accepts unwrapped bodies, a single-object list and the XML-era child wrapper", () => {
    const single = parseSettlementSummaryPage({
      ResponseBody: {
        PageInfo: { TotalCount: 1, TotalPageCount: 1, PageSize: 100, PageIndex: 1 },
        SettlementSummaryList: { ItemPrice: "5.00", CheckNumber: ["12345"] },
      },
    });
    expect(single.rows).toHaveLength(1);
    expect(single.rows[0]).toMatchObject({ itemPrice: 5, checkNumber: "12345" });

    const xml = parseSettlementSummaryPage({
      ResponseBody: {
        SettlementSummaryList: {
          SettlementSummaryInfo: [{ ItemPrice: "1.00" }, { ItemPrice: "2.00" }],
        },
      },
    });
    expect(xml.rows.map((r) => r.itemPrice)).toEqual([1, 2]);
    // No PageInfo: totals fall back to what was parsed.
    expect(xml.totalCount).toBe(2);
    expect(xml.totalPageCount).toBe(1);
  });

  it("returns an empty page for a body without rows", () => {
    expect(parseSettlementSummaryPage({ ResponseBody: {} }).rows).toEqual([]);
    expect(parseSettlementSummaryPage(undefined).rows).toEqual([]);
    expect(parseSettlementSummaryPage("garbage").totalCount).toBe(0);
  });

  it("reads PageInfo from the root when the body omits it", () => {
    const page = parseSettlementSummaryPage({
      PageInfo: { TotalCount: "300", TotalPageCount: "3", PageIndex: "2", PageSize: "100" },
      ResponseBody: { SettlementSummaryList: [{ ItemPrice: "1" }] },
    });
    expect(page).toMatchObject({ page: 2, totalPageCount: 3, totalCount: 300 });
  });
});

describe("parseSettlementTransactionsPage", () => {
  it("parses the documented row (labels, strings, null settlement id)", () => {
    const page = parseSettlementTransactionsPage({
      NeweggAPIResponse: {
        ResponseBody: {
          PageInfo: { TotalCount: "21", TotalPageCount: "3", PageSize: "10", PageIndex: "1" },
          SettlementTransactionInfoList: {
            SettlementTransactionInfo: {
              TransactionDate: "8/9/2011 12:00:00",
              TransactionType: "Order",
              OrderID: "87123017",
              InvoiceID: "75994476",
              SellerPartNumber: "SKU-1",
              NeweggItemNumber: "9SIA00X0002HJ5",
              ItemDescription: "A thing",
              ItemCondition: "New",
              Amount: "10.00",
              Shipping: "2.00",
              CommissionFee: "-0.75",
              SettlementID: "null",
            },
          },
        },
        Memo: null,
      },
    });
    expect(page).toMatchObject({ totalCount: 21, totalPageCount: 3, page: 1 });
    expect(page.rows[0]).toEqual({
      transactionDate: expect.objectContaining({ raw: "8/9/2011 12:00:00" }),
      transactionType: "Order",
      orderNumber: "87123017",
      invoiceNumber: "75994476",
      sellerPartNumber: "SKU-1",
      neweggItemNumber: "9SIA00X0002HJ5",
      itemDescription: "A thing",
      itemCondition: "New",
      amount: 10,
      shipping: 2,
      commissionFee: -0.75,
    });
  });

  it("tolerates lower-case key drift", () => {
    const page = parseSettlementTransactionsPage({
      ResponseBody: {
        SettlementTransactionInfoList: [{ amount: "1.50", sellerpartnumber: "S" }],
      },
    });
    expect(page.rows[0]).toMatchObject({ amount: 1.5, sellerPartNumber: "S" });
  });
});

describe("file row mapping", () => {
  it("maps a US inventory row", () => {
    const [record] = recordsFromRows(
      parseDelimited(
        "Seller Part #,NE Item #,Warehouse Location,Fulfillment Option,Inventory\nSKU-1,9SI1,USA,Seller Only,12\n",
      ),
    );
    expect(inventoryRowFromRecord(record ?? {})).toEqual({
      sellerPartNumber: "SKU-1",
      neweggItemNumber: "9SI1",
      warehouseLocation: "USA",
      fulfillmentOption: "Seller Only",
      inventory: 12,
    });
  });

  it("maps a B2B/CAN inventory row with price, booleans and unknown columns", () => {
    const [record] = recordsFromRows(
      parseDelimited(
        "Seller Part #\tNE Item #\tCurrency\tMSRP\tMAP\tCheckout MAP\tSelling Price\tInventory\tFulfillment Option\tShipping\tActivation Mark\tMemo\tFuture Col\n" +
          "SKU-2\t9SI2\tCAD\t1,299.99\t\tFalse\t1099.00\t3\tSeller\tdefault\tTrue\thello\tzzz\n",
      ),
    );
    expect(inventoryRowFromRecord(record ?? {})).toEqual({
      sellerPartNumber: "SKU-2",
      neweggItemNumber: "9SI2",
      currency: "CAD",
      msrp: 1299.99,
      checkoutMap: false,
      sellingPrice: 1099,
      inventory: 3,
      fulfillmentOption: "Seller",
      shipping: "default",
      activationMark: true,
      memo: "hello",
      extra: { futurecol: "zzz" },
    });
  });

  it("maps a price row", () => {
    const [record] = recordsFromRows(
      parseDelimited(
        "Seller Part #,NE Item #,CountryCode,Currency,MSRP,MAP,Checkout MAP,Selling Price,Shipping,Activation Mark,Memo\nS,9SI,USA,USD,10,9,True,8.5,free,False,\n",
      ),
    );
    expect(priceRowFromRecord(record ?? {})).toEqual({
      sellerPartNumber: "S",
      neweggItemNumber: "9SI",
      countryCode: "USA",
      currency: "USD",
      msrp: 10,
      map: 9,
      checkoutMap: true,
      sellingPrice: 8.5,
      shipping: "free",
      activationMark: false,
    });
  });

  it("returns no records for an empty file", () => {
    expect(recordsFromRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// API: settlement summary
// ---------------------------------------------------------------------------
function pagedRoutes(opts: {
  type: string;
  listKey: string;
  rowsByPage: Array<Array<Record<string, unknown>>>;
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
            ResponseBody: {
              PageInfo: {
                TotalCount: String(opts.rowsByPage.flat().length),
                TotalPageCount: String(opts.rowsByPage.length),
                PageIndex: String(index),
                PageSize: "100",
              },
              [opts.listKey]: opts.rowsByPage[index - 1] ?? [],
            },
          },
        };
      },
    },
  ];
}

describe("reports.settlementSummary", () => {
  it("submits via POST with the documented body on every platform prefix", async () => {
    for (const [marketplace, prefix] of [
      ["us", "/marketplace/reportmgmt/"],
      ["b2b", "/marketplace/b2b/reportmgmt/"],
      ["ca", "/marketplace/can/reportmgmt/"],
    ] as const) {
      const { client, calls } = makeClient(
        marketplace,
        pagedRoutes({ type: "SETTLEMENT_SUMMARY_REPORT", listKey: "X", rowsByPage: [[]] }),
      );
      const submission = await client.reports.settlementSummary.submit({
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
      });
      expect(submission).toMatchObject({
        marketplace,
        requestId: "REQ1",
        requestType: "SETTLEMENT_SUMMARY_REPORT",
      });
      expect(submission.requestDate?.raw).toBe("07/12/2014 11:34:57");
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url.pathname).toBe(`${prefix}report/submitrequest`);
      expect(calls[0]?.url.searchParams.get("sellerid")).toBe("A006");
      expect(calls[0]?.url.searchParams.has("version")).toBe(false);
      expect(calls[0]?.bodyJson).toMatchObject({ OperationType: "SettlementSummaryReportRequest" });
    }
  });

  it("validates input before any request", async () => {
    const { client, calls } = makeClient("us", []);
    await expect(
      client.reports.settlementSummary.submit({ dateFrom: "x", dateTo: "2026-09-30" }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("status maps states, request type and total", async () => {
    const { client, calls } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "X",
        rowsByPage: [[]],
        statuses: ["IN_PROGRESS"],
      }),
    );
    const status = await client.reports.settlementSummary.status("REQ1");
    expect(status).toMatchObject({ status: "inProgress", requestType: "X", totalCount: 2 });
    expect(calls[0]?.method).toBe("PUT");
    await expect(client.reports.status("")).rejects.toBeInstanceOf(NeweggValidationError);
  });

  it("result sends version=313 by default, honors an override, and parses rows", async () => {
    const seen: string[] = [];
    const { client, calls } = makeClient(
      "ca",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "SettlementSummaryList",
        rowsByPage: [[{ ItemPrice: "10.50", GSTAndHST: "1.20" }]],
        onResult: (url) => seen.push(url.searchParams.get("version") ?? "none"),
      }),
    );
    const page = await client.reports.settlementSummary.result("REQ1");
    expect(page.rows[0]).toMatchObject({ itemPrice: 10.5, gstAndHst: 1.2 });
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "SettlementSummaryReportRequest",
      RequestBody: { RequestID: "REQ1", PageInfo: { PageIndex: 1, PageSize: 100 } },
    });
    await client.reports.settlementSummary.result("REQ1", 1, { version: "310" });
    expect(seen).toEqual(["313", "310"]);
    await expect(client.reports.settlementSummary.result("REQ1", 0)).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
  });

  it("waitForResult runs submit -> poll -> every page and collects rows", async () => {
    const { client, calls } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "SettlementSummaryList",
        rowsByPage: [[{ ItemPrice: "1" }, { ItemPrice: "2" }], [{ ItemPrice: "3" }]],
        statuses: ["SUBMITTED", "IN_PROGRESS", "FINISHED"],
      }),
    );
    const collected = await client.reports.settlementSummary.waitForResult(
      { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
      FAST,
    );
    expect(collected.rows.map((r) => r.itemPrice)).toEqual([1, 2, 3]);
    expect(collected).toMatchObject({
      requestId: "REQ1",
      totalCount: 3,
      pagesFetched: 2,
      truncated: false,
      marketplace: "us",
    });
    const kinds = calls.map((c) => `${c.method} ${c.url.pathname.split("/").pop()}`);
    expect(kinds).toEqual([
      "POST submitrequest",
      "PUT status",
      "PUT status",
      "PUT status",
      "PUT result",
      "PUT result",
    ]);
    // One correlation id across the whole flow.
    expect(new Set(calls.map((c) => c.headers.get("x-correlation-id") ?? "n/a")).size).toBe(1);
  });

  it("stops at maxPages and flags truncation", async () => {
    const { client } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "SettlementSummaryList",
        rowsByPage: [[{ ItemPrice: "1" }], [{ ItemPrice: "2" }], [{ ItemPrice: "3" }]],
      }),
    );
    const collected = await client.reports.settlementSummary.waitForRequest("REQ1", {
      ...FAST,
      maxPages: 2,
    });
    expect(collected.rows).toHaveLength(2);
    expect(collected).toMatchObject({ truncated: true, pagesFetched: 2, totalCount: 3 });
  });

  it("throws ReportTimeoutError carrying the requestId when the report never finishes", async () => {
    const { client } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "X",
        rowsByPage: [[]],
        statuses: ["IN_PROGRESS"],
      }),
    );
    const error = await client.reports.settlementSummary
      .waitForResult(
        { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
        { timeoutMs: 20, pollIntervalMs: 5, maxPollIntervalMs: 5 },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportTimeoutError);
    expect((error as ReportTimeoutError).requestId).toBe("REQ1");
    expect((error as ReportTimeoutError).retryable).toBe(true);
    expect((error as ReportTimeoutError).toJSON()).toMatchObject({
      code: "report_timeout",
      requestId: "REQ1",
    });
  });

  it("throws a non-retryable ReportTimeoutError when Newegg cancels the report", async () => {
    const { client } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "X",
        rowsByPage: [[]],
        statuses: ["CANCELLED"],
      }),
    );
    const error = await client.reports.settlementSummary
      .waitForRequest("REQ1", FAST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportTimeoutError);
    expect((error as ReportTimeoutError).retryable).toBe(false);
  });

  it("honors an AbortSignal while polling", async () => {
    const controller = new AbortController();
    const { client } = makeClient(
      "us",
      pagedRoutes({
        type: "SETTLEMENT_SUMMARY_REPORT",
        listKey: "X",
        rowsByPage: [[]],
        statuses: ["IN_PROGRESS"],
      }),
    );
    setTimeout(() => controller.abort(), 15);
    await expect(
      client.reports.settlementSummary.waitForRequest("REQ1", {
        signal: controller.signal,
        pollIntervalMs: 5,
        maxPollIntervalMs: 5,
        timeoutMs: 5000,
      }),
    ).rejects.toBeDefined();
  });

  it("raises NeweggApiError when the submit response carries no request id", async () => {
    const { client } = makeClient("us", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: { IsSuccess: true, ResponseBody: {} } }),
      },
    ]);
    await expect(
      client.reports.settlementSummary.submit({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }),
    ).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("maps every upstream error shape (JSON object, JSON array, XML, plain text)", async () => {
    const shapes: Array<{ status: number; body: unknown; code?: string }> = [
      { status: 400, body: { Code: "RP018", Message: "Invalid Settlement Date" }, code: "RP018" },
      { status: 400, body: [{ Code: "RP020", Message: "criteria" }], code: "RP020" },
      {
        status: 400,
        body: "<?xml version='1.0'?><Errors><Error><Code>RP018</Code><Message>bad</Message></Error></Errors>",
        code: "RP018",
      },
      { status: 400, body: "totally unexpected plain text" },
    ];
    for (const shape of shapes) {
      const { client } = makeClient("us", [
        {
          method: "POST",
          pathPattern: paths.reportSubmit,
          reply: () => ({ status: shape.status, body: shape.body }),
        },
      ]);
      const error = await client.reports.settlementSummary
        .submit({ dateFrom: "2026-09-01", dateTo: "2026-09-30" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeweggApiError);
      expect((error as NeweggApiError).neweggErrorCode).toBe(shape.code);
    }
  });

  it("maps 429 to NeweggRateLimitError", async () => {
    const { client } = makeClient(
      "us",
      [
        {
          method: "POST",
          pathPattern: paths.reportSubmit,
          reply: () => ({ status: 429, body: [{ Code: "429", Message: "Too many request." }] }),
        },
      ],
      { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
    );
    await expect(
      client.reports.settlementSummary.submit({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }),
    ).rejects.toBeInstanceOf(NeweggRateLimitError);
  });
});

describe("reports.settlementTransactions", () => {
  it("submits criteria, no version query, and fetches pages without a version", async () => {
    const seenVersions: Array<string | null> = [];
    const { client, calls } = makeClient(
      "ca",
      pagedRoutes({
        type: "SETTLEMENT_TRANSACTION_REPORT",
        listKey: "SettlementTransactionInfoList",
        rowsByPage: [
          [{ OrderID: "1", Amount: "5.00", CommissionFee: "-0.25" }],
          [{ OrderID: "2", Amount: "6.00" }],
        ],
        onResult: (url) => seenVersions.push(url.searchParams.get("version")),
      }),
    );
    const collected = await client.reports.settlementTransactions.waitForResult(
      { settlementId: 99, transactionType: "order" },
      FAST,
    );
    expect(collected.rows.map((r) => r.orderNumber)).toEqual(["1", "2"]);
    expect(collected.rows[0]).toMatchObject({ amount: 5, commissionFee: -0.25 });
    expect(seenVersions).toEqual([null, null]);
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "SettlementTransactionReportRequest",
      RequestBody: {
        SettlementTransactionReportCriteria: {
          RequestType: "SETTLEMENT_TRANSACTION_REPORT",
          TransactionType: "1",
          SettlementID: "99",
        },
      },
    });
  });

  it("rejects an RP020-shaped request locally", async () => {
    const { client, calls } = makeClient("us", []);
    await expect(client.reports.settlementTransactions.submit({})).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// API: file reports
// ---------------------------------------------------------------------------
const SECRET_URL =
  "ftp://APIuser123:Sup3rSecretPw@ftp03.newegg.com/InternationalInventoryReport_REQ1.csv";

function fileRoutes(url: string | null = SECRET_URL, wrapped = true) {
  return [
    {
      method: "POST",
      pathPattern: paths.reportSubmit,
      reply: () => ({ status: 200, body: SUBMIT_OK("INTERNATIONAL_INVENTORY_REPORT") }),
    },
    {
      method: "PUT",
      pathPattern: paths.reportStatus,
      reply: () => ({ status: 200, body: STATUS("FINISHED") }),
    },
    {
      method: "PUT",
      pathPattern: paths.reportResult,
      reply: () => {
        const inner = {
          IsSuccess: "true",
          sellerID: "A006",
          OperationType: "InternationalInventoryReportResponse",
          ResponseBody: {
            RequestID: "REQ1",
            RequestType: "INTERNATIONAL_INVENTORY_REPORT",
            RequestDate: "2/21/2012 15:32:57",
            ...(url !== null ? { ReportFileURL: url } : {}),
          },
          Memo: null,
        };
        return { status: 200, body: wrapped ? { NeweggAPIResponse: inner } : inner };
      },
    },
  ];
}

const US_CSV =
  "Seller Part #,NE Item #,Warehouse Location,Fulfillment Option,Inventory\n" +
  'SKU-1,9SI1,USA,Seller Only,5\n"SKU,2",9SI2,USA,Seller Only,0\n';

describe("reports.dailyInventory", () => {
  it("builds the US submit body with warehouses, fulfill type, file type and version=310", async () => {
    const { client, calls } = makeClient("us", fileRoutes());
    await client.reports.dailyInventory.submit({
      fulfillType: "seller",
      warehouses: ["USA", "AUS", "USA"],
      fileType: "txt",
    });
    expect(calls[0]?.url.searchParams.get("version")).toBe("310");
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "InternationalInventoryReportRequest",
      RequestBody: {
        DailyInventoryReportCriteria: {
          FulfillType: "1",
          WarehouseList: { WarehouseLocation: ["USA", "AUS"] },
          RequestType: "INTERNATIONAL_INVENTORY_REPORT",
          FileType: "TXT",
        },
      },
    });
  });

  it("builds the B2B/CAN submit body (no warehouses) and rejects warehouses", async () => {
    for (const marketplace of ["b2b", "ca"] as const) {
      const { client, calls } = makeClient(marketplace, fileRoutes());
      await client.reports.dailyInventory.submit({});
      expect(calls[0]?.url.pathname).toContain(marketplace === "ca" ? "/can/" : "/b2b/");
      expect(calls[0]?.url.searchParams.get("version")).toBe("310");
      expect(calls[0]?.bodyJson).toEqual({
        OperationType: "DailyInventoryReportRequest",
        RequestBody: {
          DailyInventoryReportCriteria: {
            FulfillType: "0",
            RequestType: "DAILY_INVENTORY_REPORT",
            FileType: "CSV",
          },
        },
      });
      await expect(
        client.reports.dailyInventory.submit({ warehouses: ["USA"] }),
      ).rejects.toBeInstanceOf(NeweggValidationError);
    }
  });

  it("rejects malformed warehouse codes", async () => {
    const { client } = makeClient("us", []);
    await expect(
      client.reports.dailyInventory.submit({ warehouses: ["usa"] }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
  });

  it("result() exposes host + file name but never the credential-bearing URL", async () => {
    for (const wrapped of [true, false]) {
      const { client, calls } = makeClient("us", fileRoutes(SECRET_URL, wrapped));
      const info = await client.reports.dailyInventory.result("REQ1", { includeRaw: true });
      expect(info).toMatchObject({
        available: true,
        host: "ftp03.newegg.com",
        fileName: "InternationalInventoryReport_REQ1.csv",
        requestId: "REQ1",
      });
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain("Sup3rSecretPw");
      expect(serialized).not.toContain("APIuser123");
      expect(serialized).toContain("ftp://***@ftp03.newegg.com");
      expect(calls[0]?.bodyJson).toEqual({
        OperationType: "InternationalInventoryReportRequest",
        RequestBody: { RequestID: "REQ1" },
      });
    }
  });

  it("result() reports available=false when no file URL is present yet", async () => {
    const { client } = makeClient("us", fileRoutes(null));
    expect(await client.reports.dailyInventory.result("REQ1")).toMatchObject({ available: false });
    await expect(client.reports.dailyInventory.download("REQ1")).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });

  it("download() fetches via the injected downloader and parses CSV (quoted comma)", async () => {
    const received: string[] = [];
    const { client } = makeClient("us", fileRoutes(), {
      reportFileDownloader: async (url) => {
        received.push(url);
        return Buffer.from(US_CSV);
      },
    });
    const report = await client.reports.dailyInventory.download("REQ1");
    expect(received).toEqual([SECRET_URL]);
    expect(report).toMatchObject({
      requestId: "REQ1",
      fileName: "InternationalInventoryReport_REQ1.csv",
      totalRows: 2,
      truncated: false,
      fileCount: 1,
    });
    expect(report.rows).toEqual([
      {
        sellerPartNumber: "SKU-1",
        neweggItemNumber: "9SI1",
        warehouseLocation: "USA",
        fulfillmentOption: "Seller Only",
        inventory: 5,
      },
      {
        sellerPartNumber: "SKU,2",
        neweggItemNumber: "9SI2",
        warehouseLocation: "USA",
        fulfillmentOption: "Seller Only",
        inventory: 0,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("Sup3rSecretPw");
  });

  it("reads a zip package holding several files and counts them", async () => {
    const zip = buildZip([
      { name: "part1.csv", data: US_CSV },
      { name: "part2.csv", data: US_CSV },
    ]);
    const { client } = makeClient("us", fileRoutes(), { reportFileDownloader: async () => zip });
    const report = await client.reports.dailyInventory.download("REQ1");
    expect(report).toMatchObject({ fileCount: 2, totalRows: 4 });
    expect(report.rows).toHaveLength(4);
  });

  it("caps kept rows at maxRows but still counts every row", async () => {
    const { client } = makeClient("us", fileRoutes(), {
      reportFileDownloader: async () => Buffer.from(US_CSV),
    });
    const report = await client.reports.dailyInventory.download("REQ1", { maxRows: 1 });
    expect(report).toMatchObject({ totalRows: 2, truncated: true });
    expect(report.rows).toHaveLength(1);
  });

  it("refuses a binary XLS workbook with guidance", async () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const { client } = makeClient("us", fileRoutes(), { reportFileDownloader: async () => xls });
    await expect(client.reports.dailyInventory.download("REQ1")).rejects.toThrowError(/XLS/);
  });

  it("redacts the URL from errors thrown by a downloader and keeps typed errors intact", async () => {
    const { client } = makeClient("us", fileRoutes(), {
      reportFileDownloader: async (url) => {
        throw new Error(`boom while fetching ${url}`);
      },
    });
    const error = await client.reports.dailyInventory.download("REQ1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    const serialized = JSON.stringify((error as NeweggApiError).toJSON()) + String(error);
    expect(serialized).not.toContain("Sup3rSecretPw");
    expect(serialized).not.toContain("APIuser123");
    expect((error as NeweggApiError).message).toBe("Report file download failed.");

    const { client: typed } = makeClient("us", fileRoutes(), {
      reportFileDownloader: async () => {
        throw new NeweggApiError("typed failure", { retryable: false });
      },
    });
    await expect(typed.reports.dailyInventory.download("REQ1")).rejects.toThrowError(
      "typed failure",
    );
  });

  it("waitForResult submits, polls, downloads and parses (B2B/CAN columns)", async () => {
    const csv =
      "Seller Part #,NE Item #,Currency,MSRP,MAP,Checkout MAP,Selling Price,Inventory,Fulfillment Option,Shipping,Activation Mark,Memo\n" +
      "SKU-9,9SI9,CAD,100,,False,89.99,4,Seller,default,True,\n";
    const { client, calls } = makeClient("ca", fileRoutes(), {
      reportFileDownloader: async () => Buffer.from(csv),
    });
    const report = await client.reports.dailyInventory.waitForResult({}, FAST);
    expect(report.rows[0]).toEqual({
      sellerPartNumber: "SKU-9",
      neweggItemNumber: "9SI9",
      currency: "CAD",
      msrp: 100,
      checkoutMap: false,
      sellingPrice: 89.99,
      inventory: 4,
      fulfillmentOption: "Seller",
      shipping: "default",
      activationMark: true,
    });
    // CAN result request uses the DailyInventoryReportRequest operation type.
    expect(calls[calls.length - 1]?.bodyJson).toEqual({
      OperationType: "DailyInventoryReportRequest",
      RequestBody: { RequestID: "REQ1" },
    });
  });
});

describe("reports.dailyPrice", () => {
  it("builds the US body (countries, file type, version=310) and parses the file", async () => {
    const csv =
      "Seller Part #,NE Item #,CountryCode,Currency,MSRP,MAP,Checkout MAP,Selling Price,Shipping,Activation Mark,Memo\nS,9SI,USA,USD,10,,False,8,default,True,\n";
    const { client, calls } = makeClient("us", fileRoutes(), {
      reportFileDownloader: async () => Buffer.from(csv),
    });
    const report = await client.reports.dailyPrice.waitForResult(
      { countries: ["USA"], fileType: "csv" },
      FAST,
    );
    expect(calls[0]?.url.searchParams.get("version")).toBe("310");
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "InternationalPriceReportRequest",
      RequestBody: {
        DailyPriceReportCriteria: {
          CountryList: { CountryCode: ["USA"] },
          RequestType: "INTERNATIONAL_PRICE_REPORT",
          FileType: "CSV",
        },
      },
    });
    expect(calls[calls.length - 1]?.bodyJson).toMatchObject({
      OperationType: "InternationalPriceReportRequest",
    });
    expect(report.rows[0]).toMatchObject({
      countryCode: "USA",
      sellingPrice: 8,
      shipping: "default",
    });
  });

  it("omits CountryList when no countries are given", async () => {
    const { client, calls } = makeClient("us", fileRoutes());
    await client.reports.dailyPrice.submit({});
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "InternationalPriceReportRequest",
      RequestBody: {
        DailyPriceReportCriteria: { RequestType: "INTERNATIONAL_PRICE_REPORT", FileType: "CSV" },
      },
    });
  });

  it("is Newegg.com only: B2B and CAN throw before any request", async () => {
    for (const marketplace of ["b2b", "ca"] as const) {
      const { client, calls } = makeClient(marketplace, []);
      await expect(client.reports.dailyPrice.submit({})).rejects.toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      await expect(client.reports.dailyPrice.status("R")).rejects.toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      await expect(client.reports.dailyPrice.result("R")).rejects.toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      await expect(client.reports.dailyPrice.waitForRequest("R")).rejects.toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      expect(calls).toHaveLength(0);
    }
  });
});

describe("includeRaw redaction", () => {
  it("never leaks FTP credentials through raw on any report call", async () => {
    const { client } = makeClient("us", fileRoutes());
    const info = await client.reports.dailyInventory.result("REQ1", { includeRaw: true });
    expect(JSON.stringify(info.raw)).not.toContain("Sup3rSecretPw");
  });
});
