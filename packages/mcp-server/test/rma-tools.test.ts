import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

// Sentinels: every one of these is PII (or PII-adjacent free text) that must NEVER reach tool output.
const PII = [
  "NAME-SENTINEL",
  "555-SENTINEL-PHONE",
  "relay-sentinel@marketplace.newegg.com",
  "ADDR-SENTINEL-STREET",
  "CITY-SENTINEL",
  "ZIP-SENTINEL",
  "TRACK-SENTINEL",
  "http://track.sentinel.invalid",
  "RMA-NOTE-SENTINEL",
  "ITEM-MEMO-SENTINEL",
  "CUSTOMER-NOTE-SENTINEL",
  "issuer-sentinel@example.invalid",
];

const RMA_BODY = {
  NeweggAPIResponse: {
    IsSuccess: "true",
    ResponseBody: {
      PageInfo: { TotalCount: "1", TotalPageCount: "1", PageIndex: "1", PageSize: "100" },
      RMAInfoList: {
        RMAInfo: {
          RMANumber: "900000001",
          RMAType: "2",
          RMAStatus: "1",
          RMAStatusDescription: "Open",
          SellerRMANumber: "SELLER-RMA-1",
          IssueUser: "issuer-sentinel@example.invalid",
          RMADate: "12/19/2012 00:06:30",
          OrderNumber: "900000002",
          InvoiceNumber: "900000003",
          OrderAmount: "10.00",
          AvailableRefundAmount: "4.00",
          PriorRefundAmount: "1.00",
          RMAProcessedBy: "Seller",
          RMANote: "RMA-NOTE-SENTINEL",
          CustomerName: "NAME-SENTINEL",
          CustomerPhoneNumber: "555-SENTINEL-PHONE",
          CustomerEmailAddress: "relay-sentinel@marketplace.newegg.com",
          ShipToAddress1: "ADDR-SENTINEL-STREET",
          ShipToCityName: "CITY-SENTINEL",
          ShipToZipCode: "ZIP-SENTINEL",
          ShipToFirstName: "NAME-SENTINEL",
          ShipToLastName: "NAME-SENTINEL",
          ReturnShippingLabel: {
            Label: {
              TrackingNumber: "TRACK-SENTINEL",
              TrackingURL: "http://track.sentinel.invalid",
              LabelEstimateCost: "6.19",
              PaidBy: "Seller",
            },
          },
          RMATransactionList: {
            RMATransaction: {
              SellerPartNumber: "SKU-PLACEHOLDER",
              ReturnQuantity: "1",
              ReturnUnitPrice: "3.99",
              RMAReason: "4",
              RMAReasonDescription: "No longer needed",
              UnOpen: "1",
              Memo: "ITEM-MEMO-SENTINEL",
            },
          },
        },
      },
    },
  },
};

const REFUND_BODY = {
  ResponseBody: {
    PageInfo: { TotalCount: "1", TotalPageCount: "1", PageSize: "100", PageIndex: "1" },
    CourtesyRefundInfoList: {
      CourtesyrefundInfo: {
        CourtesyRefundID: "00000000-0000-4000-8000-000000000001",
        SONumber: "900000002",
        SOAmount: "50.00",
        RefundAmount: "2.01",
        ReasonCode: "2",
        Reason: "Pricing error",
        NoteToCustomer: "CUSTOMER-NOTE-SENTINEL",
        Status: "Close",
        IsNeweggRefund: "false",
        InUserName: "issuer-sentinel@example.invalid",
        InDate: "2012-02-17 12:10:00",
        EditUserName: "issuer-sentinel@example.invalid",
        EditDate: "2012-02-17 12:10:00",
      },
    },
  },
};

const STATUS_BODY = {
  ResponseBody: {
    ResponseList: {
      ResponseInfo: {
        RequestId: "00000000-0000-4000-8000-000000000001",
        RequestStatus: "FINISHED",
        RequestDate: "2012-03-07 12:37:09",
        Result: {
          CourtesyRefundInfo: REFUND_BODY.ResponseBody.CourtesyRefundInfoList.CourtesyrefundInfo,
        },
      },
    },
  },
};

const route = (pattern: RegExp, body: unknown, status = 200): MockRoute => ({
  method: "PUT",
  pathPattern: pattern,
  reply: () => ({ status, body }),
});
const RMA_ROUTE = /servicemgmt\/rma\/rmainfo/;
const INFO_ROUTE = /servicemgmt\/courtesyrefund\/info/;
const STATUS_ROUTE = /servicemgmt\/courtesyrefund\/requeststatus/;

function expectNoPii(text: string): void {
  for (const sentinel of PII) expect(text).not.toContain(sentinel);
}

describe("newegg_rma_list / newegg_rma_get", () => {
  it("returns business fields only and forwards criteria (CA: CAD, /can/ prefix)", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MARKETPLACE: "ca" }),
      routes: [route(RMA_ROUTE, RMA_BODY)],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_rma_list", {
        status: "open",
        type: "refund",
        pageSize: 5,
      });
      expect(res.isError).toBe(false);
      expectNoPii(res.text);
      expect(res.json).toMatchObject({ marketplace: "ca", currency: "CAD", totalCount: 1 });
      const rma = (res.json.rmas as Array<Record<string, unknown>>)[0]!;
      expect(rma).toMatchObject({
        rmaNumber: "900000001",
        type: "refund",
        status: "open",
        orderNumber: "900000002",
        availableRefundAmount: 4,
        processedBy: "seller",
        returnLabelCost: 6.19,
      });
      expect(rma).not.toHaveProperty("customer");
      expect(rma).not.toHaveProperty("note");
      expect((rma.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        sellerPartNumber: "SKU-PLACEHOLDER",
        reason: "noLongerNeeded",
        returnQuantity: 1,
      });
      expect(harness.calls[0]!.url.pathname).toContain("/can/servicemgmt/rma/rmainfo");
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        RequestBody: { Status: "1", RMAType: "2", PageInfo: { PageSize: "5" } },
      });
    } finally {
      await harness.close();
    }
  });

  it("get returns found=true without PII and found=false when absent", async () => {
    const harness = await startHarness({ routes: [route(RMA_ROUTE, RMA_BODY)] });
    try {
      const hit = await callTool(harness.mcp, "newegg_rma_get", { rmaNumber: "900000001" });
      expect(hit.json).toMatchObject({ found: true, rma: { rmaNumber: "900000001" } });
      expectNoPii(hit.text);
      const miss = await callTool(harness.mcp, "newegg_rma_get", { rmaNumber: 123 });
      expect(miss.json).toEqual({ found: false });
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys, mismatched keyword args and non-numeric RMA numbers", async () => {
    const harness = await startHarness({ routes: [route(RMA_ROUTE, RMA_BODY)] });
    try {
      expect((await callTool(harness.mcp, "newegg_rma_list", { bogus: 1 })).isError).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_rma_list", { keywordType: "rmaNumber" })).isError,
      ).toBe(true);
      expect((await callTool(harness.mcp, "newegg_rma_get", { rmaNumber: "1 OR 1" })).isError).toBe(
        true,
      );
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("maps upstream errors to a structured tool error", async () => {
    const harness = await startHarness({
      routes: [
        route(RMA_ROUTE, [{ Code: "CE001", Message: "SellerID cannot be null or empty" }], 400),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_rma_list", {});
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "CE001", httpStatus: 400 });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_refund_list / newegg_refund_status", () => {
  it("lists courtesy refunds without the customer note or user names", async () => {
    const harness = await startHarness({ routes: [route(INFO_ROUTE, REFUND_BODY)] });
    try {
      const res = await callTool(harness.mcp, "newegg_refund_list", {
        status: "closed",
        keywordType: "orderNumber",
        keywordValue: "900000002",
      });
      expect(res.isError).toBe(false);
      expectNoPii(res.text);
      const refund = (res.json.refunds as Array<Record<string, unknown>>)[0]!;
      expect(refund).toMatchObject({
        orderNumber: "900000002",
        refundAmount: 2.01,
        reason: "pricingError",
        status: "closed",
      });
      expect(refund).not.toHaveProperty("noteToCustomer");
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        RequestBody: { Status: "3", KeywordsType: "2", KeywordsValue: "900000002" },
      });
    } finally {
      await harness.close();
    }
  });

  it("reports request status, including the resulting refund, without PII", async () => {
    const harness = await startHarness({ routes: [route(STATUS_ROUTE, STATUS_BODY)] });
    try {
      const res = await callTool(harness.mcp, "newegg_refund_status", {
        requestIds: ["00000000-0000-4000-8000-000000000001"],
      });
      expect(res.isError).toBe(false);
      expectNoPii(res.text);
      const request = (res.json.requests as Array<Record<string, unknown>>)[0]!;
      expect(request).toMatchObject({ state: "finished", refund: { refundAmount: 2.01 } });
    } finally {
      await harness.close();
    }
  });

  it("registers the read tools even with writes disabled and exposes no refund-write tool", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }),
      routes: [],
    });
    try {
      const { tools } = (await harness.mcp.listTools()) as { tools: Array<{ name: string }> };
      const names = tools.map((tool) => tool.name);
      for (const name of [
        "newegg_rma_list",
        "newegg_rma_get",
        "newegg_refund_list",
        "newegg_refund_status",
      ]) {
        expect(names).toContain(name);
      }
      expect(names.filter((name) => /rma|refund/.test(name)).sort()).toEqual([
        "newegg_refund_list",
        "newegg_refund_status",
        // Read-only RMA List report (PII-free; contracts §17.6) - not an RMA write.
        "newegg_reports_rma_list",
        "newegg_rma_get",
        "newegg_rma_list",
      ]);
    } finally {
      await harness.close();
    }
  });
});
