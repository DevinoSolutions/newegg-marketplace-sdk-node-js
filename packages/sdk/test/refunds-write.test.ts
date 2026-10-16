import { describe, expect, it } from "vitest";
import {
  IndeterminateServiceWriteError,
  NeweggApiError,
  NeweggValidationError,
  type IssueCourtesyRefundInput,
  type NeweggMarketplace,
} from "../src/index.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";
import {
  ORDER_NUMBER,
  REQUEST_ID,
  courtesyIssueResponse,
  courtesyRecord,
  orderResponse,
  readRoutes,
  rmaRecord,
  type ReadFixtures,
} from "./service-write-helpers.js";

/**
 * Mocked coverage for Issue Courtesy Refund (contracts §20.5). It pays the customer, so the
 * same properties as the RMA writes are asserted: previews never POST, a blocker stops the write
 * before any POST, an ambiguous failure is indeterminate and never resent.
 */
const input: IssueCourtesyRefundInput = {
  orderNumber: ORDER_NUMBER,
  reason: "customerCourtesy",
  amount: 25.5,
  noteToCustomer: "Sorry for the trouble",
};

const issueOk: MockRoute = {
  method: "POST",
  pathPattern: paths.courtesyRefundNew,
  reply: () => ({ status: 200, body: courtesyIssueResponse() }),
};

function setup(
  marketplace: NeweggMarketplace,
  writeRoutes: MockRoute[],
  fixtures: ReadFixtures = {},
) {
  return makeClient(marketplace, [...readRoutes(fixtures), ...writeRoutes]);
}

const posts = <T extends { method: string }>(calls: T[]): T[] =>
  calls.filter((c) => c.method === "POST");

describe("refunds.previewIssue", () => {
  it("only reads and reports the amount, currency and the no-commission warning", async () => {
    const { client, calls } = setup("ca", [issueOk]);
    const preview = await client.refunds.previewIssue(input);
    expect(preview.blockers).toEqual([]);
    expect(preview.operation).toBe("refunds.issue");
    expect(preview.refundTotal).toBe(25.5);
    expect(preview.currency).toBe("CAD");
    expect(preview.warnings.join("\n")).toContain("does NOT refund the commission");
    expect(posts(calls)).toHaveLength(0);
  });

  it("blocks an amount above the order total and above the total minus prior refunds", async () => {
    const { client } = setup("ca", []);
    expect(
      (await client.refunds.previewIssue({ ...input, amount: 110.01 })).blockers.join("\n"),
    ).toContain("SE023");
    const prior = setup("ca", [], {
      rmas: [rmaRecord()],
      courtesyRefunds: [courtesyRecord({ RefundAmount: "20.00" })],
    });
    // 110 - 50 (open refund RMA) - 20 = 40 left.
    expect(
      (await prior.client.refunds.previewIssue({ ...input, amount: 40.01 })).blockers.join("\n"),
    ).toContain("SE034");
    const fits = await prior.client.refunds.previewIssue({ ...input, amount: 40 });
    expect(fits.blockers).toEqual([]);
    expect(fits.warnings.join("\n")).toContain("already has 1 RMA");
  });

  it("ignores voided courtesy refunds and rejected RMAs, and warns about a same-amount open one", async () => {
    const { client } = setup("ca", [], {
      rmas: [rmaRecord({ RMAStatus: "3" })],
      courtesyRefunds: [
        courtesyRecord({ RefundAmount: "100.00", Status: "Void" }),
        courtesyRecord({
          CourtesyRefundID: "00000000-0000-4000-8000-000000000002",
          RefundAmount: "25.50",
        }),
      ],
    });
    const preview = await client.refunds.previewIssue(input);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("same amount");
  });

  it("blocks a missing, voided, unshipped or replacement order", async () => {
    const missing = setup("ca", [], { order: null });
    expect((await missing.client.refunds.previewIssue(input)).blockers.join("\n")).toContain(
      "no such order",
    );
    for (const [overrides, code] of [
      [{ OrderStatus: 4 }, "SE027"],
      [{ OrderStatus: 0 }, "SE004"],
      [{ SalesChannel: 2 }, "SE026"],
    ] as const) {
      const { client } = setup("ca", [], { order: orderResponse(overrides) });
      expect((await client.refunds.previewIssue(input)).blockers.join("\n")).toContain(code);
    }
  });
});

describe("refunds.issue", () => {
  it("POSTs IssueCourtesyRefund per platform with a two-decimal string amount and no version", async () => {
    for (const [marketplace, pathname] of [
      ["us", "/marketplace/servicemgmt/courtesyrefund/new"],
      ["b2b", "/marketplace/b2b/servicemgmt/courtesyrefund/new"],
      ["ca", "/marketplace/can/servicemgmt/courtesyrefund/new"],
    ] as const) {
      const { client, calls } = setup(marketplace, [issueOk]);
      const result = await client.refunds.issue({ ...input, orderNumber: Number(ORDER_NUMBER) });
      const post = posts(calls);
      expect(post).toHaveLength(1);
      expect(post[0]!.url.pathname).toBe(pathname);
      expect(post[0]!.url.searchParams.get("sellerid")).toBe("A006");
      expect(post[0]!.url.searchParams.has("version")).toBe(false);
      expect(post[0]!.bodyJson).toEqual({
        OperationType: "IssueCourtesyRefund",
        RequestBody: {
          IssueCourtesyRefund: {
            SourceSONumber: ORDER_NUMBER,
            RefundReason: "6",
            TotalRefundAmount: "25.50",
            NoteToCustomer: "Sorry for the trouble",
          },
        },
      });
      expect(result).toMatchObject({
        requestId: REQUEST_ID,
        state: "submitted",
        stateRaw: "SUBMITTED",
        orderNumber: ORDER_NUMBER,
        amount: 25.5,
        currency: marketplace === "ca" ? "CAD" : "USD",
      });
      expect(result.requestDate?.raw).toBe("2026-10-15 09:00:00");
    }
  });

  it("maps every reason to its code and omits an absent note", async () => {
    const codes: Record<string, string> = {
      negativeCustomerFeedback: "1",
      pricingError: "2",
      wrongItemInformation: "3",
      shippingDelay: "4",
      packageNotReceived: "5",
      customerCourtesy: "6",
    };
    for (const [reason, code] of Object.entries(codes)) {
      const { client, calls } = setup("ca", [issueOk]);
      await client.refunds.issue({
        orderNumber: ORDER_NUMBER,
        reason: reason as IssueCourtesyRefundInput["reason"],
        amount: 1,
      });
      expect(posts(calls)[0]!.bodyJson).toEqual({
        OperationType: "IssueCourtesyRefund",
        RequestBody: {
          IssueCourtesyRefund: {
            SourceSONumber: ORDER_NUMBER,
            RefundReason: code,
            TotalRefundAmount: "1.00",
          },
        },
      });
    }
  });

  it("reads the table spellings RequestID / RequestSatus and a flat Memo", async () => {
    const { client } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.courtesyRefundNew,
        reply: () => ({
          status: 200,
          body: {
            IsSuccess: "true",
            ResponseBody: { RequestID: REQUEST_ID, RequestSatus: "SUBMITTED", Memo: "queued" },
          },
        }),
      },
    ]);
    const result = await client.refunds.issue(input);
    expect(result).toMatchObject({ requestId: REQUEST_ID, state: "submitted", memo: "queued" });
  });

  it("refuses to POST when a pre-send check blocks", async () => {
    const { client, calls } = setup("ca", [issueOk]);
    const err = await client.refunds.issue({ ...input, amount: 500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect((err as NeweggValidationError).issues[0]?.message).toContain("SE023");
    expect(posts(calls)).toHaveLength(0);
  });

  it("throws IndeterminateServiceWriteError on an ambiguous 502 and never resends", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.courtesyRefundNew,
        reply: () => ({ status: 502, body: "bad gateway" }),
      },
    ]);
    const err = await client.refunds.issue(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    expect((err as IndeterminateServiceWriteError).operation).toBe("refunds.issue");
    expect((err as IndeterminateServiceWriteError).orderNumber).toBe(ORDER_NUMBER);
    expect((err as IndeterminateServiceWriteError).guidance).toContain("refunds.listRequests");
    expect(posts(calls)).toHaveLength(1);
  });

  it("is indeterminate when a 200 response carries no request id", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.courtesyRefundNew,
        reply: () => ({ status: 200, body: { IsSuccess: "true", ResponseBody: {} } }),
      },
    ]);
    await expect(client.refunds.issue(input)).rejects.toBeInstanceOf(
      IndeterminateServiceWriteError,
    );
    expect(posts(calls)).toHaveLength(1);
  });

  it("passes a definitive 4xx SE error through and sends once", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.courtesyRefundNew,
        reply: () => ({
          status: 400,
          body: [{ Code: "SE019", Message: "Item total refund amount must be greater than 0" }],
        }),
      },
    ]);
    const err = await client.refunds.issue(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).neweggErrorCode).toBe("SE019");
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("courtesy refund input validation (nothing is read or sent)", () => {
  it("rejects zero, negative, three-decimal, huge, NaN amounts and bad shapes", async () => {
    const { client, calls } = setup("ca", [issueOk]);
    for (const bad of [
      { ...input, amount: 0 },
      { ...input, amount: -5 },
      { ...input, amount: 1.005 },
      { ...input, amount: 100000 },
      { ...input, amount: Number.NaN },
      { ...input, orderNumber: "ABC" },
      { ...input, reason: "other" },
      { ...input, noteToCustomer: "x".repeat(501) },
      { ...input, extra: 1 },
    ]) {
      await expect(
        client.refunds.previewIssue(bad as IssueCourtesyRefundInput),
      ).rejects.toBeInstanceOf(NeweggValidationError);
      await expect(client.refunds.issue(bad as IssueCourtesyRefundInput)).rejects.toBeInstanceOf(
        NeweggValidationError,
      );
    }
    expect(calls).toHaveLength(0);
  });
});
