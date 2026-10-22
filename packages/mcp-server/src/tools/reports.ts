/**
 * Read-only Reports Management tools: `newegg_reports_settlement_summary`,
 * `newegg_reports_settlement_transactions`, `newegg_reports_daily_inventory`,
 * `newegg_reports_daily_price` and `newegg_reports_status`. They consume only the SDK's public
 * `ReportsApi` - report submission creates a report job and mutates nothing on the seller account
 * (contracts §12 / §17) - and register unconditionally (independent of write-gating).
 *
 * File-style reports (daily inventory / price) are answered with an FTP URL that embeds
 * credentials. The SDK downloads and parses the file itself and never hands the URL out, so no
 * tool output can contain it; only parsed rows, a row count and the file name are returned.
 *
 * Each report tool waits up to `waitSeconds` for the async report. If it is still processing, the
 * tool returns `pending: true` with a `requestId` for `newegg_reports_status` - resubmitting is
 * wrong (submissions are limited to 100/hour).
 */
export {
  reportsSettlementSummaryTool,
  reportsSettlementTransactionsTool,
} from "./reports/settlement.js";
export {
  reportsDailyInventoryTool,
  reportsDailyPriceTool,
  reportsItemBasicInfoTool,
} from "./reports/file-reports.js";
export { reportsOrderListTool } from "./reports/order-list.js";
export { reportsRmaListTool } from "./reports/rma-list.js";
export { reportsStatusTool } from "./reports/status.js";
