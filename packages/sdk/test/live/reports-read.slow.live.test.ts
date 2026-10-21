import { describe, expect, it } from "vitest";
import { ReportTimeoutError } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live checks for the Reports Management reports (contracts §17). Report submission
 * creates a report job and mutates nothing on the seller account (classified READ, §12 / §17).
 * Budget: ONE submission per test per run (submit is 100/hour). Assertions are SHAPE-ONLY: no
 * account value (settlement amount, SKU, order number, warehouse quantity) is asserted, printed,
 * logged or written anywhere, and the credential-bearing FTP URL is never read by this file - the
 * SDK downloads and parses the file internally. A report still processing after the budget is a
 * valid outcome (ReportTimeoutError carries the requestId) and is treated as a soft pass.
 */
const FAST_BUDGET = { timeoutMs: 240_000, pollIntervalMs: 5_000, maxPollIntervalMs: 15_000 };

function dayOffset(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

describe.skipIf(!liveEnabled)("live (read-only): reports", () => {
  it(
    "settlement summary: submit, poll and fetch a page (shape only)",
    { timeout: 300_000 },
    async () => {
      const client = makeLiveClient();
      try {
        const collected = await client.reports.settlementSummary.waitForResult(
          { dateFrom: dayOffset(-60), dateTo: dayOffset(-1) },
          { ...FAST_BUDGET, maxPages: 1 },
        );
        expect(collected.marketplace).toBe(marketplace());
        expect(collected.requestId).toMatch(/\S/);
        expect(Array.isArray(collected.rows)).toBe(true);
        expect(typeof collected.totalCount).toBe("number");
        for (const row of collected.rows) {
          // Money fields must have been parsed to numbers (never left as strings).
          for (const [key, value] of Object.entries(row)) {
            if (key === "unmapped" || key.startsWith("settlement") || key === "checkNumber")
              continue;
            if (key === "memo") continue;
            expect(typeof value).toBe("number");
          }
        }
      } catch (err) {
        if (!(err instanceof ReportTimeoutError)) throw err;
        expect(err.requestId).toMatch(/\S/);
      }
    },
  );

  it(
    "daily inventory: submit, poll, download and parse the FTP file (counts only)",
    { timeout: 300_000 },
    async () => {
      const client = makeLiveClient();
      try {
        const report = await client.reports.dailyInventory.waitForResult(
          {},
          { ...FAST_BUDGET, maxRows: 5 },
        );
        expect(report.marketplace).toBe(marketplace());
        expect(typeof report.totalRows).toBe("number");
        expect(report.rows.length).toBeLessThanOrEqual(5);
        expect(report.fileCount).toBeGreaterThanOrEqual(1);
        // The descriptor never carries the credential-bearing URL.
        const info = await client.reports.dailyInventory.result(report.requestId, {
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
});
