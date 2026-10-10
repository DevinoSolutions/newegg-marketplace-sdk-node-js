import { describe, expect, it } from "vitest";
import { NeweggApiError, NeweggValidationError } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Courtesy refund fixtures modeled on the official §18.2 / §18.3 samples. Identifiers, order
 * numbers and amounts are fictional placeholders (the repo is public).
 */
const REFUND_ID = "00000000-0000-4000-8000-000000000001";

const REFUND_INFO = {
  CourtesyRefundID: REFUND_ID,
  SONumber: "900000002",
  SOAmount: "890.40",
  InvoiceNumber: "900000003",
  RefundAmount: "2.01",
  ReasonCode: "1",
  Reason: "Negative Customer Feedback",
  NoteToCustomer: "a note",
  Status: "Close",
  IsNeweggRefund: "false",
  InUserName: "A006",
  InDate: "2012-02-17 12:10:00",
  EditUserName: "EDI",
  EditDate: "2012-02-17 12:10:00",
};

const infoResponse = (list: unknown, page: Record<string, unknown> = {}) => ({
  NeweggAPIResponse: {
    IsSuccess: "true",
    OperationType: "GetCourtesyRefundResponse",
    SellerID: "A006",
    ResponseDate: "2012-02-17 15:12:00",
    ResponseBody: {
      PageInfo: { TotalCount: "1", TotalPageCount: "1", PageSize: "10", PageIndex: "1", ...page },
      CourtesyRefundInfoList: list,
    },
  },
});

const infoRoute = (reply: () => { status: number; body?: unknown }) => [
  { method: "PUT", pathPattern: paths.courtesyRefundInfo, reply },
];
const statusRoute = (reply: () => { status: number; body?: unknown }) => [
  { method: "PUT", pathPattern: paths.courtesyRefundStatus, reply },
];

describe("refunds.list", () => {
  it("sends Get Courtesy Refund Information as a PUT with string criteria and no version", async () => {
    const { client, calls } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse({ CourtesyrefundInfo: REFUND_INFO }) })),
    );
    await client.refunds.list({
      keyword: { type: "orderNumber", value: "900000002" },
      status: "closed",
      dateFrom: new Date("2023-06-15T20:30:00.000Z"),
      dateTo: "2023-06-16 09:00:00",
      page: 2,
      pageSize: 10,
    });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/servicemgmt/courtesyrefund/info");
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.url.searchParams.has("version")).toBe(false);
    expect(call.bodyJson).toEqual({
      OperationType: "GetCourtesyRefundInfo",
      RequestBody: {
        PageInfo: { PageIndex: "2", PageSize: "10" },
        KeywordsType: "2",
        KeywordsValue: "900000002",
        // Request-side table: 1 Open / 2 Void / 3 Close.
        Status: "3",
        DateFrom: "2023-06-15 13:30:00",
        DateTo: "2023-06-16 09:00:00",
      },
    });
  });

  it.each([
    ["open", "1"],
    ["void", "2"],
    ["closed", "3"],
  ] as const)("maps the %s status filter to wire code %s", async (status, code) => {
    const { client, calls } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse([]) })),
    );
    await client.refunds.list({ status });
    expect((calls[0]!.bodyJson as { RequestBody: { Status: string } }).RequestBody.Status).toBe(
      code,
    );
  });

  it.each([
    ["us", "/marketplace/servicemgmt/courtesyrefund/info", "USD"],
    ["b2b", "/marketplace/b2b/servicemgmt/courtesyrefund/info", "USD"],
    ["ca", "/marketplace/can/servicemgmt/courtesyrefund/info", "CAD"],
  ] as const)("uses the %s path prefix and currency", async (marketplace, pathname, currency) => {
    const { client, calls } = makeClient(
      marketplace,
      infoRoute(() => ({ status: 200, body: infoResponse([]) })),
    );
    const page = await client.refunds.list();
    expect(calls[0]!.url.pathname).toBe(pathname);
    expect(page.currency).toBe(currency);
  });

  it("maps a refund (single object under the doc's odd CourtesyrefundInfo casing)", async () => {
    const { client } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse({ CourtesyrefundInfo: REFUND_INFO }) })),
    );
    const page = await client.refunds.list();
    expect(page).toMatchObject({ page: 1, pageSize: 10, totalCount: 1, totalPageCount: 1 });
    expect(page.refunds[0]).toMatchObject({
      courtesyRefundId: REFUND_ID,
      orderNumber: "900000002",
      orderAmount: 890.4,
      invoiceNumber: "900000003",
      refundAmount: 2.01,
      reason: "negativeCustomerFeedback",
      reasonCode: 1,
      reasonDescription: "Negative Customer Feedback",
      noteToCustomer: "a note",
      status: "closed",
      issuedByNewegg: false,
      createdBy: "A006",
      editedBy: "EDI",
    });
    expect(page.refunds[0]!.createdDate).toEqual({
      raw: "2012-02-17 12:10:00",
      iso: "2012-02-17T20:10:00.000Z",
    });
  });

  it("tolerates arrays, the CourtesyRefundInfo casing, numeric wire values and digit statuses", async () => {
    const { client } = makeClient(
      "ca",
      infoRoute(() => ({
        status: 200,
        body: {
          ResponseBody: {
            PageInfo: { TotalCount: 3, TotalPageCount: 1, PageSize: 100, PageIndex: 1 },
            CourtesyRefundInfoList: {
              CourtesyRefundInfo: [
                { CourtesyRefundID: "a", ReasonCode: 2, Status: 1, IsNeweggRefund: true },
                { CourtesyRefundID: "b", ReasonCode: 6, Status: "3", RefundAmount: 5 },
                { CourtesyRefundID: "c", ReasonCode: 77, Status: "weird" },
              ],
            },
          },
        },
      })),
    );
    const { refunds } = await client.refunds.list();
    expect(refunds.map((r) => [r.courtesyRefundId, r.reason, r.status])).toEqual([
      ["a", "pricingError", "open"],
      ["b", "customerCourtesy", "void"],
      ["c", "unknown", "unknown"],
    ]);
    expect(refunds[0]!.issuedByNewegg).toBe(true);
    expect(refunds[1]!.refundAmount).toBe(5);
  });

  it("returns an empty page and honours the requested paging when PageInfo is absent", async () => {
    const { client } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: { ResponseBody: {} } })),
    );
    const page = await client.refunds.list({ page: 4, pageSize: 5 });
    expect(page.refunds).toEqual([]);
    expect(page).toMatchObject({ page: 4, pageSize: 5, totalCount: 0 });
  });

  it("copes with the doc sample's swapped PageSize/PageIndex (values are taken as given)", async () => {
    const { client } = makeClient(
      "us",
      infoRoute(() => ({
        status: 200,
        body: infoResponse({ CourtesyrefundInfo: REFUND_INFO }, { PageSize: "1", PageIndex: "10" }),
      })),
    );
    const page = await client.refunds.list();
    expect(page).toMatchObject({ page: 10, pageSize: 1 });
  });

  it("throws NeweggApiError on IsSuccess=false and maps error bodies", async () => {
    const failed = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: { NeweggAPIResponse: { IsSuccess: "false" } } })),
    );
    await expect(failed.client.refunds.list()).rejects.toBeInstanceOf(NeweggApiError);
    const coded = makeClient(
      "us",
      infoRoute(() => ({
        status: 400,
        body: "<Errors><Error><Code>CE001</Code><Message>SellerID cannot be null or empty</Message></Error></Errors>",
      })),
    );
    const error = (await coded.client.refunds.list().catch((e: unknown) => e)) as NeweggApiError;
    expect(error.neweggErrorCode).toBe("CE001");
  });

  it.each([
    [{ pageSize: 101 }, "pageSize"],
    [{ page: 0 }, "page"],
    [{ keyword: { type: "customerName" as const, value: "" } }, "keyword.value"],
    [{ dateFrom: "" }, "dateFrom"],
  ])("rejects invalid input %j before sending", async (input, path) => {
    const { client, calls } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse([]) })),
    );
    const error = await client.refunds.list(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggValidationError);
    expect((error as NeweggValidationError).issues.map((i) => i.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });
});

describe("refunds.get / tryGet", () => {
  it("searches by courtesyRefundId (KeywordsType 1) and returns the exact match", async () => {
    const { client, calls } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse({ CourtesyrefundInfo: REFUND_INFO }) })),
    );
    const refund = await client.refunds.get(REFUND_ID);
    expect(refund.courtesyRefundId).toBe(REFUND_ID);
    expect(calls[0]!.bodyJson).toMatchObject({
      RequestBody: { KeywordsType: "1", KeywordsValue: REFUND_ID },
    });
  });

  it("tryGet returns undefined for no match; get throws; blank ids are rejected locally", async () => {
    const { client, calls } = makeClient(
      "us",
      infoRoute(() => ({ status: 200, body: infoResponse([]) })),
    );
    expect(await client.refunds.tryGet("other")).toBeUndefined();
    await expect(client.refunds.get("other")).rejects.toBeInstanceOf(NeweggApiError);
    await expect(client.refunds.tryGet("  ")).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(2);
  });
});

describe("refunds.listRequests / getRequestStatus", () => {
  const FINISHED = {
    NeweggAPIResponse: {
      IsSuccess: "true",
      OperationType: "GetCourtesyRefundRequestStatusResponse",
      SellerID: "A006",
      ResponseBody: {
        ResponseList: {
          ResponseInfo: {
            RequestId: REFUND_ID,
            RequestType: "COURTESYREFUND",
            RequestDate: "2012-03-07 12:37:09",
            RequestStatus: "FINISHED",
            Result: { CourtesyRefundInfo: REFUND_INFO },
          },
        },
      },
    },
  };

  it("sends the GetRequestStatus envelope with the id list, MaxCount and status", async () => {
    const { client, calls } = makeClient(
      "us",
      statusRoute(() => ({ status: 200, body: FINISHED })),
    );
    await client.refunds.listRequests({ requestIds: [` ${REFUND_ID} `], maxCount: 5 });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/servicemgmt/courtesyrefund/requeststatus");
    expect(call.bodyJson).toEqual({
      OperationType: "GetCourtesyRefundStatusRequest",
      RequestBody: {
        GetRequestStatus: {
          RequestIDList: { RequestID: [REFUND_ID] },
          MaxCount: "5",
          RequestStatus: "ALL",
        },
      },
    });
  });

  it("sends status and date filters without an id list", async () => {
    const { client, calls } = makeClient(
      "ca",
      statusRoute(() => ({ status: 200, body: FINISHED })),
    );
    await client.refunds.listRequests({
      status: "inProgress",
      dateFrom: new Date("2023-06-15T20:30:00.000Z"),
      dateTo: "2023-06-16",
    });
    expect(calls[0]!.url.pathname).toBe(
      "/marketplace/can/servicemgmt/courtesyrefund/requeststatus",
    );
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetCourtesyRefundStatusRequest",
      RequestBody: {
        GetRequestStatus: {
          MaxCount: "100",
          RequestStatus: "IN_PROGRESS",
          RequestDateFrom: "2023-06-15 13:30:00",
          RequestDateTo: "2023-06-16",
        },
      },
    });
  });

  it("maps a FINISHED request including the resulting refund", async () => {
    const { client } = makeClient(
      "us",
      statusRoute(() => ({ status: 200, body: FINISHED })),
    );
    const status = await client.refunds.getRequestStatus(REFUND_ID);
    expect(status).toMatchObject({
      requestId: REFUND_ID,
      requestType: "COURTESYREFUND",
      state: "finished",
      stateRaw: "FINISHED",
      refund: { courtesyRefundId: REFUND_ID, refundAmount: 2.01, status: "closed" },
    });
    expect(status.requestDate?.iso).toBe("2012-03-07T20:37:09.000Z");
  });

  it("maps FAILED (ProcessMemo), IN_PROGRESS, CANCELED and unknown states from an array", async () => {
    const { client } = makeClient(
      "us",
      statusRoute(() => ({
        status: 200,
        body: {
          ResponseBody: {
            ResponseList: {
              ResponseInfo: [
                { RequestId: "1", RequestStatus: "FAILED", ProcessMemo: "bad order" },
                { RequestId: "2", RequestStatus: "in_progress" },
                { RequestId: "3", RequestStatus: "CANCELED" },
                { RequestId: "4", RequestStatus: "SUBMITTED" },
                { RequestId: "5", RequestStatus: "???" },
              ],
            },
          },
        },
      })),
    );
    const { requests, currency } = await client.refunds.listRequests();
    expect(currency).toBe("USD");
    expect(requests.map((r) => r.state)).toEqual([
      "failed",
      "inProgress",
      "cancelled",
      "submitted",
      "unknown",
    ]);
    expect(requests[0]!.processMemo).toBe("bad order");
    expect(requests[0]!.refund).toBeUndefined();
  });

  it("getRequestStatus throws NeweggApiError when Newegg returns nothing for the id", async () => {
    const { client } = makeClient(
      "us",
      statusRoute(() => ({ status: 200, body: { ResponseBody: { ResponseList: [] } } })),
    );
    await expect(client.refunds.getRequestStatus("nope")).rejects.toBeInstanceOf(NeweggApiError);
  });

  it.each([
    [{ requestIds: [] }, "requestIds"],
    [{ requestIds: ["ok", " "] }, "requestIds[1]"],
    [{ maxCount: 101 }, "maxCount"],
    [{ dateTo: "" }, "dateTo"],
  ])("rejects invalid input %j before sending", async (input, path) => {
    const { client, calls } = makeClient(
      "us",
      statusRoute(() => ({ status: 200, body: FINISHED })),
    );
    const error = await client.refunds.listRequests(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggValidationError);
    expect((error as NeweggValidationError).issues.map((i) => i.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it("rejects a blank request id without sending", async () => {
    const { client, calls } = makeClient(
      "us",
      statusRoute(() => ({ status: 200, body: FINISHED })),
    );
    await expect(client.refunds.getRequestStatus(" ")).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});
