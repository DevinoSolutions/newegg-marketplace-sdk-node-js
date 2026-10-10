import { describe, expect, it } from "vitest";
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";
import type { NeweggClient, NeweggMarketplace } from "@devino/newegg-marketplace-sdk";
import { createMockFetch, type MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { SENTINELS, callTool, makeEnv, startHarness } from "./helpers.js";

// Wire routes: shapes from the SDK's own reports tests / contracts §17. The FTP URL below is a
// fake with obvious sentinel credentials so leak assertions are trivial.
const FTP_SECRET =
  "ftp://FTPUSER-SENTINEL:FTPPASS-SENTINEL@ftp03.newegg.com/InternationalInventoryReport_RPT1.csv";

const submitOk = (type: string): MockRoute => ({
  method: "POST",
  pathPattern: /reportmgmt\/report\/submitrequest/,
  reply: () => ({
    status: 200,
    body: {
      IsSuccess: true,
      ResponseBody: {
        ResponseList: [{ RequestId: "RPT1", RequestType: type, RequestStatus: "SUBMITTED" }],
      },
    },
  }),
});

const statusRoute = (status: string): MockRoute => ({
  method: "PUT",
  pathPattern: /reportmgmt\/report\/status/,
  reply: () => ({
    status: 200,
    body: { ResponseBody: { ResponseList: [{ RequestId: "RPT1", RequestStatus: status }] } },
  }),
});

const pagedResult = (listKey: string, rows: Array<Record<string, unknown>>): MockRoute => ({
  method: "PUT",
  pathPattern: /reportmgmt\/report\/result/,
  reply: () => ({
    status: 200,
    body: {
      ResponseBody: {
        PageInfo: {
          TotalCount: String(rows.length),
          TotalPageCount: "1",
          PageIndex: "1",
          PageSize: "100",
        },
        [listKey]: rows,
      },
    },
  }),
});

const fileResult: MockRoute = {
  method: "PUT",
  pathPattern: /reportmgmt\/report\/result/,
  reply: () => ({
    status: 200,
    body: {
      NeweggAPIResponse: {
        IsSuccess: "true",
        ResponseBody: { RequestID: "RPT1", ReportFileURL: FTP_SECRET },
      },
    },
  }),
};

function clientWith(
  routes: MockRoute[],
  marketplace: NeweggMarketplace,
  csv?: string,
): { client: NeweggClient } {
  const { fetch } = createMockFetch(routes);
  const client = createNeweggClient({
    sellerId: SENTINELS.sellerId,
    apiKey: SENTINELS.apiKey,
    secretKey: SENTINELS.secretKey,
    marketplace,
    fetch,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...(csv !== undefined ? { reportFileDownloader: async () => Buffer.from(csv) } : {}),
  });
  return { client };
}

describe("newegg_reports_settlement_summary", () => {
  it("returns the settlement rows (numbers parsed, bounded by limit)", async () => {
    const harness = await startHarness({
      routes: [
        submitOk("SETTLEMENT_SUMMARY_REPORT"),
        statusRoute("FINISHED"),
        pagedResult("SettlementSummaryList", [
          { SettlementID: "11", ItemPrice: "10.00", TotalSettlement: "8.50" },
          { SettlementID: "12", ItemPrice: "20.00", TotalSettlement: "17.00" },
        ]),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_summary", {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
        limit: 1,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        marketplace: "ca",
        pending: false,
        requestId: "RPT1",
        totalRows: 2,
        returnedRows: 1,
        truncated: true,
      });
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
        settlementId: "11",
        itemPrice: 10,
        totalSettlement: 8.5,
      });
      // Read-only: the only POST is the report submission.
      expect(harness.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("returns pending with the requestId when the report is still processing", async () => {
    const harness = await startHarness({
      routes: [submitOk("SETTLEMENT_SUMMARY_REPORT"), statusRoute("IN_PROGRESS")],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_summary", {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
        waitSeconds: 5,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ pending: true, requestId: "RPT1" });
      expect(String(res.json.message)).toContain("newegg_reports_status");
    } finally {
      await harness.close();
    }
  }, 15_000);

  it("rejects malformed dates before any report is submitted", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_summary", {
        dateFrom: "not a date at all",
        dateTo: "2026-09-30",
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys (strict schema)", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_summary", {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
        overwrite: "Yes",
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_reports_settlement_transactions", () => {
  it("requires a settlement criterion (RP020) and maps it to an error payload", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_transactions", {
        transactionType: "order",
      });
      expect(res.isError).toBe(true);
      expect(String(res.json.message)).toMatch(/RP020/);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("returns transaction rows for a settlement id", async () => {
    const harness = await startHarness({
      routes: [
        submitOk("SETTLEMENT_TRANSACTION_REPORT"),
        statusRoute("FINISHED"),
        pagedResult("SettlementTransactionInfoList", [
          { OrderID: "1001", TransactionType: "Order", Amount: "25.00", CommissionFee: "-1.00" },
        ]),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_settlement_transactions", {
        settlementId: "77",
        transactionType: "order",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ totalRows: 1, truncated: false });
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
        orderNumber: "1001",
        amount: 25,
        commissionFee: -1,
      });
      const submit = harness.calls.find((c) => c.method === "POST");
      expect(submit?.bodyJson).toMatchObject({
        RequestBody: {
          SettlementTransactionReportCriteria: { TransactionType: "1", SettlementID: "77" },
        },
      });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_reports_daily_inventory / daily_price", () => {
  it("returns parsed inventory rows and NEVER the credential-bearing file URL", async () => {
    const csv =
      "Seller Part #,NE Item #,Warehouse Location,Fulfillment Option,Inventory\nSKU-A,9SIA,USA,Seller Only,7\n";
    const { client } = clientWith(
      [submitOk("INTERNATIONAL_INVENTORY_REPORT"), statusRoute("FINISHED"), fileResult],
      "us",
      csv,
    );
    const harness = await startHarness({ client, env: makeEnv({ NEWEGG_MARKETPLACE: "us" }) });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_daily_inventory", {
        warehouses: ["USA"],
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        totalRows: 1,
        fileName: "InternationalInventoryReport_RPT1.csv",
      });
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
        sellerPartNumber: "SKU-A",
        warehouseLocation: "USA",
        inventory: 7,
      });
      expect(res.text).not.toContain("FTPUSER-SENTINEL");
      expect(res.text).not.toContain("FTPPASS-SENTINEL");
      expect(res.text).not.toContain("ftp://");
    } finally {
      await harness.close();
    }
  });

  it("daily price is Newegg.com only: CA returns an unsupported-operation error", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_daily_price", {});
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("unsupported_operation");
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("daily price on US parses the price file", async () => {
    const csv =
      "Seller Part #,NE Item #,CountryCode,Currency,MSRP,MAP,Checkout MAP,Selling Price,Shipping,Activation Mark,Memo\nSKU-B,9SIB,USA,USD,10,,False,8.5,free,True,\n";
    const { client } = clientWith(
      [submitOk("INTERNATIONAL_PRICE_REPORT"), statusRoute("FINISHED"), fileResult],
      "us",
      csv,
    );
    const harness = await startHarness({ client, env: makeEnv({ NEWEGG_MARKETPLACE: "us" }) });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_daily_price", { countries: ["USA"] });
      expect(res.isError).toBe(false);
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
        sellerPartNumber: "SKU-B",
        sellingPrice: 8.5,
      });
      expect(res.text).not.toContain("FTPPASS-SENTINEL");
    } finally {
      await harness.close();
    }
  });

  it("a download failure never echoes the credential-bearing URL", async () => {
    const { fetch } = createMockFetch([
      submitOk("INTERNATIONAL_INVENTORY_REPORT"),
      statusRoute("FINISHED"),
      fileResult,
    ]);
    const client = createNeweggClient({
      sellerId: SENTINELS.sellerId,
      apiKey: SENTINELS.apiKey,
      secretKey: SENTINELS.secretKey,
      marketplace: "us",
      fetch,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      reportFileDownloader: async (url) => {
        throw new Error(`cannot reach ${url}`);
      },
    });
    const harness = await startHarness({ client, env: makeEnv({ NEWEGG_MARKETPLACE: "us" }) });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_daily_inventory", {});
      expect(res.isError).toBe(true);
      expect(res.text).not.toContain("FTPPASS-SENTINEL");
      expect(res.text).not.toContain("FTPUSER-SENTINEL");
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_reports_status", () => {
  it("returns the in-flight status without rows", async () => {
    const harness = await startHarness({ routes: [statusRoute("IN_PROGRESS")] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "settlementSummary",
      });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBe("inProgress");
      expect(res.json.rows).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("returns rows once a paged report is finished", async () => {
    const harness = await startHarness({
      routes: [
        statusRoute("FINISHED"),
        pagedResult("SettlementSummaryList", [{ SettlementID: "5", ItemPrice: "3.00" }]),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "settlementSummary",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "finished", totalRows: 1 });
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ itemPrice: 3 });
    } finally {
      await harness.close();
    }
  });

  it("returns parsed rows for a finished file report without exposing the URL", async () => {
    const csv = "Seller Part #,NE Item #,Inventory\nSKU-C,9SIC,2\n";
    const { client } = clientWith([statusRoute("FINISHED"), fileResult], "ca", csv);
    const harness = await startHarness({ client });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "dailyInventory",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "finished", totalRows: 1 });
      expect(res.text).not.toContain("FTPPASS-SENTINEL");
    } finally {
      await harness.close();
    }
  });

  it("validates reportType and requestId", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const bad = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "orders",
      });
      expect(bad.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
