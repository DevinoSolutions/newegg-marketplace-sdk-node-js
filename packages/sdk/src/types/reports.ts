/** Reports Management types (contracts §17). Re-exported from `../types.ts`. */

import type { ReportState } from "./catalog.js";
import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { Order, OrderStatus, OrderTypeFilter, PremierOrderFilter } from "./orders.js";
import type { Rma, RmaKeywordType, RmaProcessedBy, RmaStatus, RmaType } from "./rma.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// reports (Reports Management reads; contracts §17) — READ-only
// ----------------------------------------------------------------------------
/**
 * A date criterion for a report. Strings are sent as given and must be a calendar date
 * (`YYYY-MM-DD`, the form in Newegg's samples) or a Pacific date-time (`M/D/YYYY H:mm[:ss]`,
 * `YYYY-MM-DD HH:mm[:ss]`). A `Date` is rendered as its **Pacific** calendar date
 * (`YYYY-MM-DD`) - Newegg interprets every report date as Pacific Time.
 */
export type ReportDateInput = string | Date;

/** Download hook for file-style reports; receives the credential-bearing report file URL. */
export type ReportFileDownloader = (
  url: string,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number },
) => Promise<Uint8Array>;

export interface ReportSubmission {
  marketplace: NeweggMarketplace;
  /** Poll with `status(requestId)` / continue with `result` or `waitForRequest` - do NOT resubmit. */
  requestId: string;
  /** Newegg's `RequestType` echo, e.g. `SETTLEMENT_SUMMARY_REPORT`. */
  requestType?: string;
  /** Pacific `RequestDate`. */
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Sanitized raw payload (any credential-bearing URL is redacted). */
  raw?: unknown;
}

export interface ReportStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: ReportState;
  /** Newegg's literal status string, for diagnostics when `status` is `"unknown"`. */
  statusRaw?: string;
  requestType?: string;
  totalCount?: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Options for the `waitFor*` helpers. */
export interface ReportWaitOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  /**
   * Overall budget for submit + poll + fetch, ms. Default 120_000 for the file reports (daily
   * inventory / price); 300_000 for the settlement reports, which can take ~170 s to generate.
   */
  timeoutMs?: number;
  /** First poll delay, ms. Default 2_000. Grows 1.5x per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Poll delay ceiling, ms. Default 15_000. */
  maxPollIntervalMs?: number;
  /** Paged reports: stop after this many result pages (100 rows each). Default 50. */
  maxPages?: number;
  /** File reports: keep at most this many parsed rows (the rest are counted, not kept). Default 50_000. */
  maxRows?: number;
}

/** One result page of a paged (inline) report. */
export interface ReportResultPage<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  /** 1-based page index. */
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Every page of a paged report, gathered by `waitForRequest` / `waitForResult`. */
export interface CollectedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  /** Total rows Newegg reports for the whole report. */
  totalCount: number;
  pagesFetched: number;
  /** True when `maxPages` stopped the fetch before the last page (`rows.length < totalCount`). */
  truncated: boolean;
  correlationId: string;
}

/** Result-page options (the optional `version` query selects the response field set). */
export interface ReportResultOptions extends RequestOptions {
  /**
   * Response `version` query parameter (settlement summary: 306-313; each adds fields, §17.2).
   * Default `"313"`, the newest documented set. ASSUMPTION: accepted on every platform.
   */
  version?: string;
}

// -- settlement summary -------------------------------------------------------
export interface SettlementSummaryInput {
  /** Start of the settlement range (Pacific). */
  dateFrom: ReportDateInput;
  /** End of the settlement range (Pacific). */
  dateTo: ReportDateInput;
}

/** Money fields of a settlement-summary row (strings on the wire; parsed to numbers). */
export type SettlementSummaryAmountField =
  | "itemPrice"
  | "shipping"
  | "taxDuty"
  | "gstTotal"
  | "hstTotal"
  | "gstAndHst"
  | "pstTotal"
  | "pstAndQst"
  | "ehfTotal"
  | "other"
  | "recyclingFeeTotal"
  | "totalOrderAmount"
  | "refunds"
  | "chargeBack"
  | "miscellaneousAdjustment"
  | "courtesyRefund"
  | "totalRefunds"
  | "neweggCommissionFee"
  | "neweggTransactionFee"
  | "neweggRefundCommissionFee"
  | "neweggMonthlyFee"
  | "neweggStorageFee"
  | "neweggRmaBuyoutFee"
  | "neweggServiceFeeTax"
  | "neweggPremierFee"
  | "neweggShippingLabelFee"
  | "creditCardPayment"
  | "fulfillmentByNeweggFee"
  | "multiChannelFee"
  | "adjustmentFee"
  | "merchandisingFee"
  | "totalNeweggFee"
  | "totalSettlement"
  | "salesTaxFeeCollectedFromCustomer"
  | "salesTaxFeesLiabilityShiftToNewegg"
  | "reservedBalance"
  | "previousReservedBalance";

/**
 * One settlement. Which amount fields are present depends on platform and response version
 * (§17.2): absent means "not reported", never zero. Amounts are USD on Newegg.com and
 * Neweggbusiness.com and CAD on Newegg.ca.
 */
export type SettlementSummaryRow = {
  settlementDate?: { raw: string; iso?: string };
  settlementDateFrom?: { raw: string; iso?: string };
  settlementDateTo?: { raw: string; iso?: string };
  settlementId?: string;
  checkNumber?: string;
  memo?: string;
  /** Wire fields this SDK version does not map (scalar values only) - forward compatibility. */
  unmapped?: Record<string, string>;
} & { [K in SettlementSummaryAmountField]?: number };

export interface SettlementSummaryReportApi {
  /** Submit a Settlement Summary report for a settlement-date range (100 submissions/hour). */
  submit(input: SettlementSummaryInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** One result page (1-based, 100 rows) of a FINISHED report. */
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<SettlementSummaryRow>>;
  /** Poll an already-submitted report to FINISHED, then fetch every page. */
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(
    input: SettlementSummaryInput,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
}

// -- settlement transactions --------------------------------------------------
/** Settlement `TransactionType` filter (wire integer 0-32; §17.3). */
export type SettlementTransactionType =
  | "all"
  | "order"
  | "refund"
  | "creditRequest"
  | "chargeback"
  | "monthlyFee"
  | "fulfillByNeweggFee"
  | "multiChannelFee"
  | "rmaProcessingFee"
  | "taxAndDuty"
  | "storageFee"
  | "rmaBuyoutFee"
  | "adjustmentFee"
  | "monthlyFeeByCreditCard"
  | "sbnInboundFee"
  | "merchandisingFee"
  | "premierFee"
  | "shippingLabelFee"
  | "returnAndDisposalFee"
  | "relabelingFee"
  | "recyclingFeeOrEhf"
  | "returnShippingLabelFee"
  | "serviceFeeTax"
  | "printShippingLabelService"
  | "reservedBalance"
  | "previousReservedBalance"
  | "commissionIncentiveRefund"
  | "unsoldListingFee"
  | "orderProcessingFee"
  | "salesTaxAndFees"
  | "sbnInboundIncomplianceCharges"
  | "sponsoredAds"
  | "itemOverageFee";

/**
 * Criteria for a Settlement Transaction report. Newegg requires `settlementId`, `settlementDate`,
 * or both `settlementDateFrom` and `settlementDateTo` (error RP020); the SDK enforces this
 * before sending.
 */
export interface SettlementTransactionsInput {
  settlementDateFrom?: ReportDateInput;
  settlementDateTo?: ReportDateInput;
  settlementDate?: ReportDateInput;
  settlementId?: string | number;
  orderNumber?: string | number;
  /** Default `"all"`. */
  transactionType?: SettlementTransactionType;
}

export interface SettlementTransactionRow {
  transactionDate?: { raw: string; iso?: string };
  /** Newegg's transaction label, e.g. `Order`. */
  transactionType?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  itemDescription?: string;
  /** Newegg's condition label, e.g. `New`, `Used - Like New`. */
  itemCondition?: string;
  /** USD (Newegg.com / Neweggbusiness.com) or CAD (Newegg.ca). */
  amount?: number;
  shipping?: number;
  commissionFee?: number;
  settlementId?: string;
  memo?: string;
}

export interface SettlementTransactionReportApi {
  submit(input: SettlementTransactionsInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(
    requestId: string,
    page?: number,
    options?: RequestOptions,
  ): Promise<ReportResultPage<SettlementTransactionRow>>;
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions,
  ): Promise<CollectedReport<SettlementTransactionRow>>;
  waitForResult(
    input: SettlementTransactionsInput,
    options?: ReportWaitOptions,
  ): Promise<CollectedReport<SettlementTransactionRow>>;
}

// -- file-style reports (daily inventory / daily price) -------------------------
/** Output formats the SDK can parse. (Newegg also offers XLS; it is not parsed here.) */
export type ReportTextFileType = "csv" | "txt";

/**
 * Descriptor of a finished file report. The file's FTP URL embeds credentials, so it is NEVER
 * exposed: only the host and file name are. Use `download` / `waitFor*` to read the rows.
 */
export interface ReportFileInfo {
  marketplace: NeweggMarketplace;
  requestId: string;
  /** False when the result carried no `ReportFileURL` yet. */
  available: boolean;
  fileName?: string;
  host?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface DownloadedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  fileName?: string;
  /** Parsed rows, capped at `maxRows`. */
  rows: Row[];
  /** Every data row in the file (>= `rows.length`). */
  totalRows: number;
  truncated: boolean;
  /** Source files read (a zip package holds several when the account has > 40,000 items). */
  fileCount: number;
  correlationId: string;
}

export interface DailyInventoryInput {
  /** `"all"` (default), `"seller"` (Fulfill by Seller) or `"newegg"` (Fulfill by Newegg). */
  fulfillType?: "all" | "seller" | "newegg";
  /** US only: 3-letter ISO warehouse codes to include (omit for all). Rejected on B2B/CA. */
  warehouses?: string[];
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

/**
 * One inventory line. US reports carry `warehouseLocation`; B2B/CA reports carry the price and
 * activation columns of the default warehouse (§17.4). Unmapped columns land in `extra`.
 */
export interface DailyInventoryRow {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  /** US only (3-letter ISO). */
  warehouseLocation?: string;
  /** e.g. `Seller`, `Newegg`. */
  fulfillmentOption?: string;
  inventory?: number;
  /** B2B/CA only from here down. */
  currency?: string;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `default` or `free`. */
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}

export interface DailyPriceInput {
  /** 3-letter ISO destination countries (default: all). */
  countries?: string[];
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

export interface DailyPriceRow {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  countryCode?: string;
  currency?: string;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `default` or `free`. */
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}

export interface FileReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** The finished report's file descriptor (host + file name; the credential URL is withheld). */
  result(requestId: string, options?: RequestOptions): Promise<ReportFileInfo>;
  /** Fetch the finished report's file over FTP and parse it. */
  download(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  /** Poll an already-submitted report to FINISHED, then download + parse. */
  waitForRequest(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(input: Input, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
}

// -- item basic information (file; the only way to enumerate every listing) ---------
/** Item Basic Information `Status` filter: 0 all (default) / 1 active only / 2 inactive only. */
export type ItemBasicInfoStatus = "all" | "active" | "inactive";

export interface ItemBasicInfoInput {
  /** Which listings to include (default `"all"`). */
  status?: ItemBasicInfoStatus;
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

/** A custom-variety option of a listing (`Custom Variety N Name` / `Value`). */
export interface ItemVarietyOption {
  name: string;
  value: string;
}

/**
 * One listing from the Item Basic Information report (contracts §17.8, live-verified on CAN
 * 2026-10-10). The report carries NO price or inventory - join the Daily Inventory report
 * (`reports.dailyInventory`) on `sellerPartNumber` for those. Columns the SDK does not map land
 * in `extra` (keyed by the lower-cased, punctuation-free header).
 */
export interface ItemBasicInfoRow {
  /** `Seller Part #` - the SKU. */
  sellerPartNumber?: string;
  /** `NE Item #` - the Newegg item number. */
  neweggItemNumber?: string;
  /** `Manufacturer Part #`. */
  manufacturerPartNumber?: string;
  /** Absent for listings without a UPC. */
  upc?: string;
  /** The listing's `Status` column, verbatim (`Active` / `Inactive`). */
  status?: string;
  /** `true` when `status` is Active, `false` when Inactive; absent when the column is missing/unknown. */
  active?: boolean;
  /** Catalog title (the column header is misspelled `Wesite Short Title` by Newegg). */
  title?: string;
  industry?: string;
  subcategory?: string;
  /** Bullet-point description; may contain newlines. */
  bulletDescription?: string;
  /** Item dimensions / weight as reported (units are not documented). */
  itemLength?: number;
  itemWidth?: number;
  itemHeight?: number;
  itemWeight?: number;
  /** `Item Image`: the comma-separated image URL list, split. */
  imageUrls?: string[];
  /** `Date Created` as a calendar date `YYYY-MM-DD` (the file gives `MM/DD/YYYY`; month-first assumed). */
  dateCreated?: string;
  /** Marketplace platform code, e.g. `CAN`. */
  platform?: string;
  /** Variant group id, shared by every option of a variation family. */
  itemGroupId?: string;
  /** Up to three custom variety options. */
  varieties?: ItemVarietyOption[];
  extra?: Record<string, string>;
}

// -- order list / RMA list (paged inline) --------------------------------------
/** A paged (inline JSON) report: submit, status, page-by-page result and the wait helpers. */
export interface PagedReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** One result page (1-based, 100 rows) of a FINISHED report. */
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<Row>>;
  /** Poll an already-submitted report to FINISHED, then fetch every page (up to `maxPages`). */
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(
    input: Input,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
}

/** What the Order List report's `KeywordsValue` is matched against (`KeywordsType` 1-9). */
export type OrderListKeywordType =
  | "orderNumber"
  | "invoiceNumber"
  | "customerName"
  | "sellerPartNumber"
  | "neweggItemNumber"
  | "customerPhoneNumber"
  | "titleDescription"
  | "manufacturer"
  | "sellerOrderNumber";

/** Criteria for the Order List report. `status` is required by Newegg. */
export interface OrderListInput {
  /** Order status to list (`Status` 0-5; required). `"unknown"` is not a valid criterion. */
  status: Exclude<OrderStatus, "unknown">;
  /** Keyword search (`KeywordsType` + `KeywordsValue`). Omit for all. */
  keyword?: { type: OrderListKeywordType; value: string };
  /** Fulfillment/channel filter (`Type`: all / sbn / sbs / multiChannel). `"nws"` is not offered. */
  type?: Exclude<OrderTypeFilter, "nws">;
  /** Order-date range start (Pacific). `Date` is rendered as its Pacific wall clock. */
  dateFrom?: Date | string;
  /** Order-date range end (Pacific). */
  dateTo?: Date | string;
  /** Only orders that auto-void within this many hours (`VoidSoon`). */
  voidSoon?: 24 | 48;
  /** `false` excludes already-downloaded orders. Default includes all. */
  includeDownloaded?: boolean;
  /** Newegg.com only: ISO 3-letter ship-to country. Rejected on B2B/CA. */
  countryCode?: string;
  /** Newegg.com only (`PremierOrder`). Rejected on B2B/CA. */
  premierOrder?: PremierOrderFilter;
}

/** Criteria for the RMA List report. Every field is optional. */
export interface RmaListInput {
  keyword?: { type: RmaKeywordType; value: string };
  status?: Exclude<RmaStatus, "unknown">;
  type?: Exclude<RmaType, "unknown">;
  processedBy?: RmaProcessedBy;
  /** RMA-date range start (Pacific). */
  dateFrom?: Date | string;
  /** RMA-date range end (Pacific). */
  dateTo?: Date | string;
}

/**
 * Read-only Reports Management reports. Report submission is a POST that creates a report job
 * only - it mutates nothing on the seller account (contracts §12 / §17 classification).
 */
export interface ReportsApi {
  /**
   * Item Basic Information report (file via FTP): every listing of the seller (SKU, Newegg item
   * number, manufacturer part number, UPC, status). The only way to enumerate "all my listings".
   */
  readonly itemBasicInfo: FileReportApi<ItemBasicInfoInput, ItemBasicInfoRow>;
  /**
   * Order List report (paged inline): orders in the same shape as {@link OrdersApi.list}. Rows
   * carry the customer block (PII) exactly as `orders.list` does.
   */
  readonly orderList: PagedReportApi<OrderListInput, Order>;
  /** RMA List report (paged inline): RMAs in the same shape as {@link RmaApi.list} (customer block is PII). */
  readonly rmaList: PagedReportApi<RmaListInput, Rma>;
  /** Settlement Summary report: per-settlement payments, refunds and fees (all platforms). */
  readonly settlementSummary: SettlementSummaryReportApi;
  /** Settlement Transaction report: line-level transactions inside settlements (all platforms). */
  readonly settlementTransactions: SettlementTransactionReportApi;
  /**
   * Daily Inventory report (file via FTP): US per-warehouse quantities; B2B/CA the default
   * warehouse with price and activation status.
   */
  readonly dailyInventory: FileReportApi<DailyInventoryInput, DailyInventoryRow>;
  /** Daily Price report (file via FTP). Newegg.com only; B2B/CA throw {@link UnsupportedMarketplaceOperationError}. */
  readonly dailyPrice: FileReportApi<DailyPriceInput, DailyPriceRow>;
  /** Status of any submitted report by request id (the status endpoint is report-type independent). */
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
}
