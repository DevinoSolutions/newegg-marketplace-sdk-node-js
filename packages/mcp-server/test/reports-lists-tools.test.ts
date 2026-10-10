import { describe, expect, it } from "vitest";
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";
import type { NeweggClient } from "@devino/newegg-marketplace-sdk";
import { createMockFetch, type MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { SENTINELS, callTool, startHarness } from "./helpers.js";

/**
 * Item Basic Information / Order List / RMA List MCP tools (contracts §17.6 / §17.8). Every buyer
 * field in the fixtures carries a PII-SENTINEL value so a leak is a trivial substring assertion.
 */
const FTP_SECRET =
  "ftp://FTPUSER-SENTINEL:FTPPASS-SENTINEL@mktpftpreport.newegg.com/ApiItemBaseInfoReport_RPT1.zip";

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
  csv: string,
): { client: NeweggClient; calls: ReturnType<typeof createMockFetch>["calls"] } {
  const { fetch, calls } = createMockFetch(routes);
  const client = createNeweggClient({
    sellerId: SENTINELS.sellerId,
    apiKey: SENTINELS.apiKey,
    secretKey: SENTINELS.secretKey,
    marketplace: "ca",
    fetch,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    reportFileDownloader: async () => Buffer.from(csv),
  });
  return { client, calls };
}

const PII = [
  "PII-NAME-SENTINEL",
  "PII-PHONE-SENTINEL",
  "PII-EMAIL-SENTINEL",
  "PII-ADDRESS-SENTINEL",
  "PII-NOTE-SENTINEL",
  "PII-TRACKING-SENTINEL",
];

function expectNoPii(text: string): void {
  for (const sentinel of PII) expect(text, sentinel).not.toContain(sentinel);
  expect(text).not.toContain("FTPPASS-SENTINEL");
  expect(text).not.toContain("ftp://");
}

const ITEM_CSV =
  "Seller Part #,NE Item #,Manufacturer Part #,UPC,Status,Wesite Short Title,Industry,Subcategory," +
  "Bullet Description,Item Image,Date Created,Platform,Item Group ID,Custom Variety 1 Name," +
  "Custom Variety 1 Value,Brand New Column\n" +
  "SKU-1,9SIEXAMPLE0001,MPN-1,012345678905,Active,Example Widget,Hardware,Widgets,A long description," +
  "https://img.example.test/a.jpg,03/07/2026,CAN,555,Color,Blue,hidden\n" +
  "SKU-2,9SIEXAMPLE0002,MPN-2,,Inactive,Other Widget,Hardware,Widgets,,,10/01/2025,CAN,,,,\n";

describe("newegg_reports_item_basic_info", () => {
  it("returns the explicit listing rows, never the URL, description, images or unmapped columns", async () => {
    const { client, calls } = clientWith(
      [submitOk("ITEM_BASIC_INFO_REPORT"), statusRoute("FINISHED"), fileResult],
      ITEM_CSV,
    );
    const harness = await startHarness({ client });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_item_basic_info", {
        status: "all",
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
        fileName: "ApiItemBaseInfoReport_RPT1.zip",
      });
      expect((res.json.rows as Array<Record<string, unknown>>)[0]).toEqual({
        sellerPartNumber: "SKU-1",
        neweggItemNumber: "9SIEXAMPLE0001",
        manufacturerPartNumber: "MPN-1",
        upc: "012345678905",
        status: "Active",
        active: true,
        title: "Example Widget",
        industry: "Hardware",
        subcategory: "Widgets",
        dateCreated: "2026-03-07",
        platform: "CAN",
        itemGroupId: "555",
        varieties: [{ name: "Color", value: "Blue" }],
      });
      expect(res.text).not.toContain("A long description");
      expect(res.text).not.toContain("img.example.test");
      expect(res.text).not.toContain("hidden");
      expectNoPii(res.text);
      // The submit body carries the requested status filter (0 = all, 1 = active only).
      const submit = calls.find((c) => c.method === "POST");
      expect(JSON.stringify(submit?.bodyJson)).toContain('"Status":"0"');
    } finally {
      await harness.close();
    }
  });

  it("returns pending with the requestId while Newegg is still building the report", async () => {
    const harness = await startHarness({
      routes: [submitOk("ITEM_BASIC_INFO_REPORT"), statusRoute("IN_PROGRESS")],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_item_basic_info", {
        waitSeconds: 5,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ pending: true, requestId: "RPT1" });
      expect(String(res.json.message)).toContain("newegg_reports_status");
    } finally {
      await harness.close();
    }
  }, 15_000);

  it("rejects an over-large limit and an unknown status at the schema", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      expect(
        (await callTool(harness.mcp, "newegg_reports_item_basic_info", { limit: 501 })).isError,
      ).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_reports_item_basic_info", { status: "everything" }))
          .isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

const ORDER_ROW = {
  OrderNumber: "100000001",
  InvoiceNumber: "200000001",
  OrderDate: "2/21/2012 14:38:17",
  OrderStatus: "3",
  OrderStatusDescription: "Invoiced",
  CustomerName: "PII-NAME-SENTINEL",
  CustomerPhoneNumber: "PII-PHONE-SENTINEL",
  CustomerEmailAddress: "PII-EMAIL-SENTINEL@example.test",
  ShipToFirstName: "PII-NAME-SENTINEL",
  ShipToLastName: "PII-NAME-SENTINEL",
  ShipToAddress1: "PII-ADDRESS-SENTINEL",
  ShipToCityName: "PII-ADDRESS-SENTINEL",
  ShipToZipCode: "PII-ADDRESS-SENTINEL",
  ShipService: "Standard",
  OrderItemAmount: "8.00",
  GSTorHSTAmount: "0.40",
  OrderTotalAmount: "8.40",
  OrderQty: "1",
  ItemInfoList: [
    {
      SellerPartNumber: "SKU-1",
      NeweggItemNumber: "9SIEXAMPLE0001",
      Description: "Example Widget",
      OrderedQty: "1",
      ShippedQty: "1",
      Status: "2",
      StatusDescription: "Shipped",
    },
  ],
  PackageInfoList: [
    {
      PackageType: "Shipped",
      ShipCarrier: "Example Carrier",
      ShipService: "Standard",
      TrackingNumber: "TRK1",
      ShipDate: "2/22/2012 10:00:00",
      Memo: "PII-NOTE-SENTINEL",
      ItemInfoList: [{ SellerPartNumber: "SKU-1", MfrPartNumber: "MPN-1", ShippedQty: "1" }],
    },
  ],
};

describe("newegg_reports_order_list", () => {
  it("maps orders explicitly: business fields in, buyer data and package memos out", async () => {
    const harness = await startHarness({
      routes: [
        submitOk("ORDER_LIST_REPORT"),
        statusRoute("FINISHED"),
        pagedResult("OrderInfoList", [ORDER_ROW]),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_order_list", {
        status: "invoiced",
        dateFrom: "2026-01-01",
        dateTo: "2026-02-01",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        pending: false,
        totalRows: 1,
        returnedRows: 1,
        truncated: false,
        currency: "CAD",
      });
      const row = (res.json.rows as Array<Record<string, unknown>>)[0];
      expect(row).toMatchObject({
        orderNumber: "100000001",
        status: "invoiced",
        amounts: { itemAmount: 8, gstOrHstAmount: 0.4, total: 8.4 },
        items: [{ sellerPartNumber: "SKU-1", status: "shipped" }],
        packages: [
          {
            shipCarrier: "Example Carrier",
            items: [{ sellerPartNumber: "SKU-1", mfrPartNumber: "MPN-1", shippedQty: 1 }],
          },
        ],
      });
      expect(row).not.toHaveProperty("customer");
      expect((row?.packages as Array<Record<string, unknown>>)[0]).not.toHaveProperty("memo");
      expectNoPii(res.text);
      // Read-only: the only POST is the report submission, and it carries the wire criteria.
      const posts = harness.calls.filter((c) => c.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts[0]?.bodyJson)).toContain('"Status":"3"');
    } finally {
      await harness.close();
    }
  });

  it("requires a status, offers no customer search and rejects Newegg.com-only criteria on CA", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_reports_order_list", {})).isError).toBe(true);
      expect(
        (
          await callTool(harness.mcp, "newegg_reports_order_list", {
            status: "shipped",
            keywordType: "customerName",
            keywordValue: "x",
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await callTool(harness.mcp, "newegg_reports_order_list", {
            status: "shipped",
            keywordType: "orderNumber",
          })
        ).isError,
      ).toBe(true);
      const us = await callTool(harness.mcp, "newegg_reports_order_list", {
        status: "shipped",
        countryCode: "USA",
      });
      expect(us.isError).toBe(true);
      expect(us.json.errorCode).toBe("validation");
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("returns pending with the requestId when slow", async () => {
    const harness = await startHarness({
      routes: [submitOk("ORDER_LIST_REPORT"), statusRoute("IN_PROGRESS")],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_order_list", {
        status: "shipped",
        waitSeconds: 5,
      });
      expect(res.json).toMatchObject({ pending: true, requestId: "RPT1" });
    } finally {
      await harness.close();
    }
  }, 15_000);
});

const RMA_ROW = {
  RMANumber: "300000001",
  RMAType: "2",
  RMATypeDescription: "Refund",
  RMADate: "2/21/2012 14:38:17",
  RMAStatus: "5",
  RMAStatusDescription: "Closed",
  LastEditUser: "PII-EMAIL-SENTINEL@example.test",
  OrderNumber: "100000001",
  OrderAmount: "8.00",
  RMAProcessedBy: "Seller",
  CustomerName: "PII-NAME-SENTINEL",
  CustomerPhoneNumber: "PII-PHONE-SENTINEL",
  CustomerAddress: "PII-ADDRESS-SENTINEL",
  RMANote: "PII-NOTE-SENTINEL",
  RefundGSTorHSTAmount: "0.40",
  ReturnShippingLabel: [
    {
      TrackingNumber: "PII-TRACKING-SENTINEL",
      TrackingURL: "https://example.test/PII-TRACKING-SENTINEL",
    },
  ],
  RMATransactionList: [
    {
      SellerPartNumber: "SKU-1",
      NeweggItemNumber: "9SIEXAMPLE0001",
      UnitPrice: "8.00",
      RefundInfo: {
        ItemReturnQty: "1",
        ItemRefundPerQty: "8.00",
        RMATotalRefund: "8.40",
        RefundReason: "2",
        RefundReasonDescription: "Defective",
      },
    },
  ],
};

describe("newegg_reports_rma_list", () => {
  it("maps RMAs explicitly: business fields in, buyer data, notes and tracking out", async () => {
    const harness = await startHarness({
      routes: [
        submitOk("RMA_LIST_REPORT"),
        statusRoute("FINISHED"),
        pagedResult("RMAInfoList", [RMA_ROW]),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_rma_list", {
        status: "closed",
        type: "refund",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ totalRows: 1, currency: "CAD", pending: false });
      const row = (res.json.rows as Array<Record<string, unknown>>)[0];
      expect(row).toMatchObject({
        rmaNumber: "300000001",
        type: "refund",
        status: "closed",
        orderNumber: "100000001",
        refundGstOrHstAmount: 0.4,
        items: [
          {
            sellerPartNumber: "SKU-1",
            returnQuantity: 1,
            returnUnitPrice: 8,
            rmaTotalRefund: 8.4,
            reason: "defective",
          },
        ],
      });
      for (const banned of ["customer", "note", "issueUser", "returnLabel"]) {
        expect(row).not.toHaveProperty(banned);
      }
      expectNoPii(res.text);
    } finally {
      await harness.close();
    }
  });

  it("offers no customer-name search and keeps the keyword pair together", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      expect(
        (
          await callTool(harness.mcp, "newegg_reports_rma_list", {
            keywordType: "customerName",
            keywordValue: "x",
          })
        ).isError,
      ).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_reports_rma_list", { keywordValue: "x" })).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_reports_status with the new report types", () => {
  it("returns PII-free order rows once an order list is finished", async () => {
    const harness = await startHarness({
      routes: [statusRoute("FINISHED"), pagedResult("OrderInfoList", [ORDER_ROW])],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "orderList",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "finished", totalRows: 1, currency: "CAD" });
      expectNoPii(res.text);
    } finally {
      await harness.close();
    }
  });

  it("returns PII-free RMA rows once an RMA list is finished", async () => {
    const harness = await startHarness({
      routes: [statusRoute("FINISHED"), pagedResult("RMAInfoList", [RMA_ROW])],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "rmaList",
      });
      expect(res.json).toMatchObject({ status: "finished", totalRows: 1 });
      expectNoPii(res.text);
    } finally {
      await harness.close();
    }
  });

  it("returns listing rows for a finished item basic info report without the URL", async () => {
    const { client } = clientWith([statusRoute("FINISHED"), fileResult], ITEM_CSV);
    const harness = await startHarness({ client });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "itemBasicInfo",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "finished", totalRows: 2 });
      expectNoPii(res.text);
    } finally {
      await harness.close();
    }
  });

  it("returns the in-flight status for a still-running report", async () => {
    const harness = await startHarness({ routes: [statusRoute("IN_PROGRESS")] });
    try {
      const res = await callTool(harness.mcp, "newegg_reports_status", {
        requestId: "RPT1",
        reportType: "itemBasicInfo",
      });
      expect(res.json.status).toBe("inProgress");
      expect(res.json.rows).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
