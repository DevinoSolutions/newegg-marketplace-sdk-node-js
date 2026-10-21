import { describe, expect, it } from "vitest";
import { ReportTimeoutError, type OrderStatus } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live checks for the Item Basic Information, Order List and RMA List reports
 * (contracts §17.6 / §17.8). Report submission creates a report job and mutates nothing on the
 * seller account. Budget: at most ONE submission per test per run (submit is 100/hour) - and none
 * when the optional `NEWEGG_LIVE_REPORT_*_ID` variables name an already-submitted report, which is
 * then only polled/fetched. Status polling never goes faster than every 15 s (Newegg answers 429
 * to aggressive polling). Assertions are SHAPE-ONLY: no SKU, order number, RMA number, buyer field
 * or amount is asserted, printed, logged or written, and the credential-bearing FTP URL is never
 * read here - the SDK downloads and parses the file internally. A report still processing after
 * the budget is a valid outcome (ReportTimeoutError carries the requestId): a soft pass.
 */
const POLL = { timeoutMs: 420_000, pollIntervalMs: 15_000, maxPollIntervalMs: 15_000 };
const TEST_TIMEOUT = 480_000;

const env = process.env;

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Runtime discovery (a free, synchronous read): an order status that actually has orders. */
async function discoverOrderStatus(): Promise<Exclude<OrderStatus, "unknown">> {
  const client = makeLiveClient();
  const statuses = ["shipped", "invoiced", "unshipped", "voided"] as const;
  for (const status of statuses) {
    try {
      const page = await client.orders.list({
        status,
        dateFrom: "01/01/2020 00:00:00",
        dateTo: "12/31/2026 23:59:59",
        pageSize: 1,
      });
      if (page.totalCount > 0) return status;
    } catch {
      // best-effort discovery only
    }
  }
  return "shipped";
}

describe.skipIf(!liveEnabled)("live (read-only): item / order / RMA list reports", () => {
  it(
    "item basic info: enumerates the listings (shape only)",
    { timeout: TEST_TIMEOUT },
    async () => {
      const client = makeLiveClient();
      const existing = env.NEWEGG_LIVE_REPORT_ITEM_BASIC_INFO_ID;
      try {
        const report = existing
          ? await client.reports.itemBasicInfo.waitForRequest(existing, { ...POLL, maxRows: 200 })
          : await client.reports.itemBasicInfo.waitForResult({}, { ...POLL, maxRows: 200 });
        expect(report.marketplace).toBe(marketplace());
        expect(report.requestId).toMatch(/\S/);
        expect(report.fileCount).toBeGreaterThanOrEqual(1);
        expect(report.totalRows).toBeGreaterThanOrEqual(report.rows.length);
        for (const row of report.rows) {
          expect(typeof row.sellerPartNumber).toBe("string");
          expect(typeof row.neweggItemNumber).toBe("string");
          if (row.status !== undefined) {
            expect(["active", "inactive"]).toContain(row.status.toLowerCase());
            expect(typeof row.active).toBe("boolean");
          }
          if (row.itemLength !== undefined) expect(typeof row.itemLength).toBe("number");
          if (row.dateCreated !== undefined) expect(row.dateCreated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        // The descriptor never carries the credential-bearing URL.
        const info = await client.reports.itemBasicInfo.result(report.requestId, {
          includeRaw: true,
        });
        expect(info.available).toBe(true);
        expect(JSON.stringify(info)).not.toMatch(/ftp:\/\/[^*]/);
      } catch (err) {
        if (!(err instanceof ReportTimeoutError)) throw err;
        expect(err.requestId).toMatch(/\S/);
      }
    },
  );

  it("order list: fetches a page of orders (shape only)", { timeout: TEST_TIMEOUT }, async () => {
    const client = makeLiveClient();
    const existing = env.NEWEGG_LIVE_REPORT_ORDER_LIST_ID;
    try {
      const options = { ...POLL, maxPages: 1 };
      const collected = existing
        ? await client.reports.orderList.waitForRequest(existing, options)
        : await client.reports.orderList.waitForResult(
            { status: await discoverOrderStatus(), dateFrom: "2020-01-01", dateTo: dayOffset(0) },
            options,
          );
      expect(collected.marketplace).toBe(marketplace());
      expect(typeof collected.totalCount).toBe("number");
      expect(collected.totalCount).toBeGreaterThanOrEqual(collected.rows.length);
      for (const order of collected.rows) {
        expect(order.orderNumber).toMatch(/^\d+$/);
        expect([
          "unshipped",
          "partiallyShipped",
          "shipped",
          "invoiced",
          "voided",
          "paymentPending",
        ]).toContain(order.status);
        expect(Array.isArray(order.items)).toBe(true);
        expect(Array.isArray(order.packages)).toBe(true);
        if (order.amounts.total !== undefined) expect(typeof order.amounts.total).toBe("number");
      }
    } catch (err) {
      if (!(err instanceof ReportTimeoutError)) throw err;
      expect(err.requestId).toMatch(/\S/);
    }
  });

  it("rma list: fetches a page of RMAs (shape only)", { timeout: TEST_TIMEOUT }, async () => {
    const client = makeLiveClient();
    const existing = env.NEWEGG_LIVE_REPORT_RMA_LIST_ID;
    try {
      const options = { ...POLL, maxPages: 1 };
      const collected = existing
        ? await client.reports.rmaList.waitForRequest(existing, options)
        : await client.reports.rmaList.waitForResult(
            { dateFrom: "2020-01-01", dateTo: dayOffset(0) },
            options,
          );
      expect(collected.marketplace).toBe(marketplace());
      expect(collected.totalCount).toBeGreaterThanOrEqual(collected.rows.length);
      for (const rma of collected.rows) {
        expect(rma.rmaNumber).toMatch(/^\d+$/);
        expect(["replacement", "refund"]).toContain(rma.type);
        expect(rma.status).not.toBe("unknown");
        for (const item of rma.items) {
          // The nested RefundInfo block must have been flattened onto the numeric fields.
          if (item.returnQuantity !== undefined) expect(typeof item.returnQuantity).toBe("number");
          if (item.rmaTotalRefund !== undefined) expect(typeof item.rmaTotalRefund).toBe("number");
        }
      }
    } catch (err) {
      if (!(err instanceof ReportTimeoutError)) throw err;
      expect(err.requestId).toMatch(/\S/);
    }
  });
});
