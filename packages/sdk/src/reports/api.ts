import { randomUUID } from "node:crypto";
import type {
  CollectedReport,
  DailyInventoryInput,
  DailyInventoryRow,
  DailyPriceInput,
  DailyPriceRow,
  DownloadedReport,
  FileReportApi,
  ItemBasicInfoInput,
  ItemBasicInfoRow,
  Order,
  OrderListInput,
  PagedReportApi as PagedReportApiShape,
  ReportFileInfo,
  ReportResultOptions,
  ReportResultPage,
  ReportsApi,
  ReportStatus,
  ReportSubmission,
  ReportWaitOptions,
  RequestOptions,
  Rma,
  RmaListInput,
  SettlementSummaryInput,
  SettlementSummaryReportApi,
  SettlementSummaryRow,
  SettlementTransactionReportApi,
  SettlementTransactionRow,
  SettlementTransactionsInput,
} from "../types.js";
import type { NeweggHttpClient } from "../client/http.js";
import {
  NeweggApiError,
  NeweggError,
  NeweggValidationError,
  ReportTimeoutError,
  UnsupportedMarketplaceOperationError,
} from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { REPORT_LIST_TIMEOUT_MS, REPORT_SETTLEMENT_TIMEOUT_MS } from "../reportmgmt/constants.js";
import { toTimestamp } from "../platform/dates.js";
import {
  getReportsPlatform,
  resolveVersion,
  type FileReportRequest,
  type VersionedPagedRequest,
} from "../platform/reports.js";
import { parseDelimited } from "../reportmgmt/csv.js";
import { downloadViaFtp } from "../reportmgmt/ftp.js";
import {
  ReportLifecycle,
  waitUntilFinished,
  type ResultOutcome,
  type StatusOutcome,
  type SubmitOutcome,
} from "../reportmgmt/lifecycle.js";
import {
  describeReportFile,
  findReportFileUrl,
  redactUrlCredentials,
} from "../reportmgmt/redact.js";
import { extractZip, looksLikeZip } from "../reportmgmt/zip.js";
import { isAbortError } from "../util.js";
import {
  REPORT_DEFAULT_MAX_PAGES,
  REPORT_FILE_DEFAULT_MAX_ROWS,
  REPORT_FILE_DOWNLOAD_TIMEOUT_MS,
  REPORT_FILE_MAX_BYTES,
  REPORT_FILE_MAX_UNZIPPED_BYTES,
  SETTLEMENT_SUMMARY_DEFAULT_VERSION,
  SETTLEMENT_SUMMARY_OPERATION_TYPE,
  SETTLEMENT_TRANSACTION_OPERATION_TYPE,
} from "./constants.js";
import {
  buildFileResultRequest,
  buildPagedResultRequest,
  buildSettlementSummarySubmit,
  buildSettlementTransactionsSubmit,
  inventoryRowFromRecord,
  itemBasicInfoRowFromRecord,
  parseOrderListPage,
  parseRmaListPage,
  parseSettlementSummaryPage,
  parseSettlementTransactionsPage,
  priceRowFromRecord,
  recordsFromRows,
  type ParsedPage,
} from "./parse.js";
import { validateSettlementSummaryInput, validateSettlementTransactionsInput } from "./validate.js";

function toSubmission(outcome: SubmitOutcome): ReportSubmission {
  const requestDate = toTimestamp(outcome.requestDate);
  return {
    marketplace: outcome.marketplace,
    requestId: outcome.requestId,
    ...(outcome.requestType !== undefined ? { requestType: outcome.requestType } : {}),
    ...(requestDate !== undefined ? { requestDate } : {}),
    correlationId: outcome.correlationId,
    rateLimit: outcome.rateLimit,
    raw: outcome.raw,
  };
}

function toStatus(outcome: StatusOutcome): ReportStatus {
  return {
    marketplace: outcome.marketplace,
    requestId: outcome.requestId,
    status: outcome.status,
    ...(outcome.statusRaw !== undefined ? { statusRaw: outcome.statusRaw } : {}),
    ...(outcome.requestType !== undefined ? { requestType: outcome.requestType } : {}),
    ...(outcome.totalCount !== undefined ? { totalCount: outcome.totalCount } : {}),
    correlationId: outcome.correlationId,
    rateLimit: outcome.rateLimit,
    raw: outcome.raw,
  };
}

function pageOf<Row>(
  outcome: ResultOutcome,
  requestId: string,
  parsed: ParsedPage<Row>,
): ReportResultPage<Row> {
  return {
    marketplace: outcome.marketplace,
    requestId,
    rows: parsed.rows,
    page: parsed.page,
    pageSize: parsed.pageSize,
    totalCount: parsed.totalCount,
    totalPageCount: parsed.totalPageCount,
    ...(parsed.requestDate !== undefined ? { requestDate: parsed.requestDate } : {}),
    correlationId: outcome.correlationId,
    rateLimit: outcome.rateLimit,
    raw: outcome.raw,
  };
}

function validatePage(page: number): void {
  if (!Number.isInteger(page) || page < 1) {
    throw new NeweggValidationError("Report validation failed.", [
      { path: "page", message: "page must be a positive integer (1-based)" },
    ]);
  }
}

function requireRequestId(requestId: string): void {
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new NeweggValidationError("Report validation failed.", [
      { path: "requestId", message: "requestId must be a non-empty string" },
    ]);
  }
}

/** Shared by every report type: submit/status plumbing and the wait loop. */
class ReportsCore {
  readonly lifecycle: ReportLifecycle;

  constructor(readonly http: NeweggHttpClient) {
    this.lifecycle = new ReportLifecycle(
      http,
      {
        submit: Operation.ReportSubmit,
        status: Operation.ReportStatus,
        result: Operation.ReportResult,
      },
      "report",
    );
  }

  async submit(
    body: unknown,
    options: RequestOptions,
    query?: Record<string, string>,
  ): Promise<ReportSubmission> {
    return toSubmission(
      await this.lifecycle.submit(body, { ...options, ...(query ? { query } : {}) }),
    );
  }

  async status(requestId: string, options: RequestOptions = {}): Promise<ReportStatus> {
    requireRequestId(requestId);
    return toStatus(await this.lifecycle.status(requestId, options));
  }

  async waitFinished(
    requestId: string,
    options: ReportWaitOptions,
    defaultTimeoutMs?: number,
  ): Promise<void> {
    requireRequestId(requestId);
    const correlationId = options.correlationId ?? randomUUID();
    await waitUntilFinished(
      requestId,
      async () =>
        (await this.lifecycle.status(requestId, { correlationId, signal: options.signal })).status,
      {
        cancelled: (id) =>
          new ReportTimeoutError("Newegg cancelled the report; resubmit to retry.", {
            requestId: id,
            correlationId,
            retryable: false,
          }),
        timedOut: (id) =>
          new ReportTimeoutError(
            "The report did not finish within the time budget; continue with " +
              "status/waitForRequest using requestId instead of resubmitting.",
            { requestId: id, correlationId },
          ),
      },
      defaultTimeoutMs !== undefined && options.timeoutMs === undefined
        ? { ...options, timeoutMs: defaultTimeoutMs }
        : options,
    );
  }
}

// ---------------------------------------------------------------------------
// paged (inline) reports
// ---------------------------------------------------------------------------
interface PagedSpec<Input, Row> {
  readonly resultOperationType: string;
  buildSubmit(input: Input): { body: unknown; query?: Record<string, string> };
  parsePage(json: unknown): ParsedPage<Row>;
  defaultResultQuery?: Record<string, string>;
  /** Resolves the result `version` (validated per platform); wins over `defaultResultQuery`. */
  resolveResultVersion?(requested: string | undefined): string;
  /** Per-type default wait budget (ms) used when the caller passes no `timeoutMs`. */
  defaultWaitTimeoutMs?: number;
}

class PagedReportApi<Input, Row> {
  constructor(
    private readonly core: ReportsCore,
    private readonly spec: PagedSpec<Input, Row>,
  ) {}

  async submit(input: Input, options: RequestOptions = {}): Promise<ReportSubmission> {
    const { body, query } = this.spec.buildSubmit(input);
    return this.core.submit(body, options, query);
  }

  status(requestId: string, options: RequestOptions = {}): Promise<ReportStatus> {
    return this.core.status(requestId, options);
  }

  async result(
    requestId: string,
    page = 1,
    options: ReportResultOptions = {},
  ): Promise<ReportResultPage<Row>> {
    requireRequestId(requestId);
    validatePage(page);
    const query = this.spec.resolveResultVersion
      ? { version: this.spec.resolveResultVersion(options.version) }
      : options.version !== undefined
        ? { version: options.version }
        : this.spec.defaultResultQuery;
    const outcome = await this.core.lifecycle.result(
      buildPagedResultRequest(this.spec.resultOperationType, requestId, page),
      { ...options, ...(query ? { query } : {}) },
    );
    return pageOf(outcome, requestId, this.spec.parsePage(outcome.json));
  }

  async waitForRequest(
    requestId: string,
    options: ReportWaitOptions & { version?: string } = {},
  ): Promise<CollectedReport<Row>> {
    const correlationId = options.correlationId ?? randomUUID();
    const shared = { ...options, correlationId };
    await this.core.waitFinished(requestId, shared, this.spec.defaultWaitTimeoutMs);
    const maxPages = Math.max(1, options.maxPages ?? REPORT_DEFAULT_MAX_PAGES);
    const rows: Row[] = [];
    let totalCount = 0;
    let pagesFetched = 0;
    let truncated = false;
    for (let page = 1; ; page += 1) {
      const result = await this.result(requestId, page, {
        correlationId,
        signal: options.signal,
        includeRaw: false,
        ...(options.version !== undefined ? { version: options.version } : {}),
      });
      rows.push(...result.rows);
      totalCount = result.totalCount;
      pagesFetched += 1;
      if (page >= result.totalPageCount) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }
    }
    return {
      marketplace: this.core.http.config.marketplace,
      requestId,
      rows,
      totalCount: Math.max(totalCount, rows.length),
      pagesFetched,
      truncated,
      correlationId,
    };
  }

  async waitForResult(
    input: Input,
    options: ReportWaitOptions & { version?: string } = {},
  ): Promise<CollectedReport<Row>> {
    const correlationId = options.correlationId ?? randomUUID();
    const submission = await this.submit(input, { correlationId, signal: options.signal });
    return this.waitForRequest(submission.requestId, { ...options, correlationId });
  }
}

// ---------------------------------------------------------------------------
// file (FTP) reports
// ---------------------------------------------------------------------------
interface FileSpec<Input, Row> {
  /** Throws UnsupportedMarketplaceOperationError when the platform lacks the report. */
  resolve(): {
    resultOperationType: string;
    buildRequest(input: Input): FileReportRequest;
  };
  rowFromRecord(record: Record<string, string>): Row;
  /** Per-type default wait budget (ms) used when the caller passes no `timeoutMs`. */
  defaultWaitTimeoutMs?: number;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function isOle(bytes: Uint8Array): boolean {
  return OLE_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Keeps Newegg-supplied secrets out of errors thrown by (possibly user-supplied) downloaders. */
function safeDownloadError(error: unknown, correlationId: string): Error {
  if (isAbortError(error)) return error as Error;
  if (error instanceof NeweggError) return error;
  const detail =
    error instanceof Error ? redactUrlCredentials(error.message).slice(0, 200) : undefined;
  return new NeweggApiError("Report file download failed.", {
    correlationId,
    retryable: false,
    details: detail !== undefined ? { cause: detail } : undefined,
  });
}

class FileReportApiImpl<Input, Row> implements FileReportApi<Input, Row> {
  constructor(
    private readonly core: ReportsCore,
    private readonly spec: FileSpec<Input, Row>,
  ) {}

  async submit(input: Input, options: RequestOptions = {}): Promise<ReportSubmission> {
    const { body, query } = this.spec.resolve().buildRequest(input);
    return this.core.submit(body, options, query);
  }

  async status(requestId: string, options: RequestOptions = {}): Promise<ReportStatus> {
    this.spec.resolve();
    return this.core.status(requestId, options);
  }

  /** Fetches the result envelope; returns the (SECRET) URL alongside the public descriptor. */
  async #fetch(
    requestId: string,
    options: RequestOptions,
  ): Promise<{ info: ReportFileInfo; url: string | undefined }> {
    requireRequestId(requestId);
    const platform = this.spec.resolve();
    const outcome = await this.core.lifecycle.result(
      buildFileResultRequest(platform.resultOperationType, requestId),
      options,
    );
    const url = findReportFileUrl(outcome.json);
    const location = url !== undefined ? describeReportFile(url) : undefined;
    return {
      url,
      info: {
        marketplace: outcome.marketplace,
        requestId,
        available: url !== undefined,
        ...(location?.fileName !== undefined ? { fileName: location.fileName } : {}),
        ...(location !== undefined ? { host: location.host } : {}),
        correlationId: outcome.correlationId,
        rateLimit: outcome.rateLimit,
        raw: outcome.raw,
      },
    };
  }

  async result(requestId: string, options: RequestOptions = {}): Promise<ReportFileInfo> {
    return (await this.#fetch(requestId, options)).info;
  }

  async download(
    requestId: string,
    options: ReportWaitOptions = {},
  ): Promise<DownloadedReport<Row>> {
    const correlationId = options.correlationId ?? randomUUID();
    const { info, url } = await this.#fetch(requestId, {
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (url === undefined) {
      throw new NeweggApiError(
        "Newegg returned no report file for this request; check status() reports FINISHED first.",
        { correlationId, retryable: true, details: { requestId } },
      );
    }
    const config = this.core.http.config;
    const ftp = config.reportFileFtp;
    const downloader =
      config.reportFileDownloader ??
      ((target, opts) =>
        downloadViaFtp(target, {
          ...opts,
          ...(ftp?.allowPlaintext === undefined ? {} : { allowPlaintext: ftp.allowPlaintext }),
          ...(ftp?.allowedPorts === undefined ? {} : { allowedPorts: ftp.allowedPorts }),
          ...(ftp?.tlsCa === undefined ? {} : { tlsCa: ftp.tlsCa }),
        }));
    let bytes: Uint8Array;
    try {
      bytes = await downloader(url, {
        signal: options.signal,
        maxBytes: REPORT_FILE_MAX_BYTES,
        timeoutMs: REPORT_FILE_DOWNLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      throw safeDownloadError(error, correlationId);
    }
    const parsed = this.#parse(bytes, options.maxRows ?? REPORT_FILE_DEFAULT_MAX_ROWS);
    return {
      marketplace: info.marketplace,
      requestId,
      ...(info.fileName !== undefined ? { fileName: info.fileName } : {}),
      rows: parsed.rows,
      totalRows: parsed.totalRows,
      truncated: parsed.totalRows > parsed.rows.length,
      fileCount: parsed.fileCount,
      correlationId,
    };
  }

  #parse(
    bytes: Uint8Array,
    maxRows: number,
  ): { rows: Row[]; totalRows: number; fileCount: number } {
    const files = looksLikeZip(bytes)
      ? extractZip(bytes, REPORT_FILE_MAX_UNZIPPED_BYTES).map((entry) => entry.data)
      : [bytes];
    const decoder = new TextDecoder("utf-8");
    const rows: Row[] = [];
    let totalRows = 0;
    let fileCount = 0;
    for (const data of files) {
      if (isOle(data)) {
        throw new NeweggApiError(
          "The report file is a binary XLS workbook, which the SDK cannot parse; request " +
            'fileType "csv" or "txt".',
          { retryable: false },
        );
      }
      const records = recordsFromRows(parseDelimited(decoder.decode(data)));
      fileCount += 1;
      for (const record of records) {
        totalRows += 1;
        if (rows.length < maxRows) rows.push(this.spec.rowFromRecord(record));
      }
    }
    return { rows, totalRows, fileCount };
  }

  async waitForRequest(
    requestId: string,
    options: ReportWaitOptions = {},
  ): Promise<DownloadedReport<Row>> {
    this.spec.resolve();
    const correlationId = options.correlationId ?? randomUUID();
    await this.core.waitFinished(
      requestId,
      { ...options, correlationId },
      this.spec.defaultWaitTimeoutMs,
    );
    return this.download(requestId, { ...options, correlationId });
  }

  async waitForResult(
    input: Input,
    options: ReportWaitOptions = {},
  ): Promise<DownloadedReport<Row>> {
    const correlationId = options.correlationId ?? randomUUID();
    const submission = await this.submit(input, { correlationId, signal: options.signal });
    return this.waitForRequest(submission.requestId, { ...options, correlationId });
  }
}

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------
/**
 * Settlement / inventory / price reports over Reports Management (contracts §17). All READ-shaped:
 * report submission creates a report job and mutates nothing on the seller account.
 */
/** Spec for a versioned paged report (Order List, RMA List) built from its platform data. */
function versionedPagedSpec<Input, Row>(
  request: VersionedPagedRequest<Input>,
  parsePage: PagedSpec<Input, Row>["parsePage"],
): PagedSpec<Input, Row> {
  return {
    resultOperationType: request.operationType,
    buildSubmit: (input) => ({ body: request.buildSubmit(input) }),
    parsePage,
    resolveResultVersion: (requested) => resolveVersion(request, requested),
    defaultWaitTimeoutMs: REPORT_LIST_TIMEOUT_MS,
  };
}

export class ReportsApiImpl implements ReportsApi {
  readonly settlementSummary: SettlementSummaryReportApi;
  readonly settlementTransactions: SettlementTransactionReportApi;
  readonly dailyInventory: FileReportApi<DailyInventoryInput, DailyInventoryRow>;
  readonly dailyPrice: FileReportApi<DailyPriceInput, DailyPriceRow>;
  readonly itemBasicInfo: FileReportApi<ItemBasicInfoInput, ItemBasicInfoRow>;
  readonly orderList: PagedReportApiShape<OrderListInput, Order>;
  readonly rmaList: PagedReportApiShape<RmaListInput, Rma>;
  readonly #core: ReportsCore;

  constructor(http: NeweggHttpClient) {
    const core = new ReportsCore(http);
    this.#core = core;
    const platform = getReportsPlatform(http.config.marketplace);

    this.settlementSummary = new PagedReportApi<SettlementSummaryInput, SettlementSummaryRow>(
      core,
      {
        resultOperationType: SETTLEMENT_SUMMARY_OPERATION_TYPE,
        buildSubmit: (input) => ({
          body: buildSettlementSummarySubmit(validateSettlementSummaryInput(input)),
        }),
        parsePage: parseSettlementSummaryPage,
        defaultResultQuery: { version: SETTLEMENT_SUMMARY_DEFAULT_VERSION },
        defaultWaitTimeoutMs: REPORT_SETTLEMENT_TIMEOUT_MS,
      },
    );
    this.settlementTransactions = new PagedReportApi<
      SettlementTransactionsInput,
      SettlementTransactionRow
    >(core, {
      resultOperationType: SETTLEMENT_TRANSACTION_OPERATION_TYPE,
      buildSubmit: (input) => ({
        body: buildSettlementTransactionsSubmit(validateSettlementTransactionsInput(input)),
      }),
      parsePage: parseSettlementTransactionsPage,
      defaultWaitTimeoutMs: REPORT_SETTLEMENT_TIMEOUT_MS,
    });
    this.itemBasicInfo = new FileReportApiImpl<ItemBasicInfoInput, ItemBasicInfoRow>(core, {
      resolve: () => platform.itemBasicInfo,
      rowFromRecord: itemBasicInfoRowFromRecord,
      defaultWaitTimeoutMs: REPORT_LIST_TIMEOUT_MS,
    });
    this.orderList = new PagedReportApi<OrderListInput, Order>(
      core,
      versionedPagedSpec(platform.orderList, parseOrderListPage),
    );
    this.rmaList = new PagedReportApi<RmaListInput, Rma>(
      core,
      versionedPagedSpec(platform.rmaList, parseRmaListPage),
    );
    this.dailyInventory = new FileReportApiImpl<DailyInventoryInput, DailyInventoryRow>(core, {
      resolve: () => platform.dailyInventory,
      rowFromRecord: inventoryRowFromRecord,
    });
    this.dailyPrice = new FileReportApiImpl<DailyPriceInput, DailyPriceRow>(core, {
      resolve: () => {
        if (platform.dailyPrice === undefined) {
          throw new UnsupportedMarketplaceOperationError(
            `The Daily Price report is Newegg.com only; it is not available on the ${http.config.marketplace} marketplace.`,
          );
        }
        return platform.dailyPrice;
      },
      rowFromRecord: priceRowFromRecord,
    });
  }

  status(requestId: string, options: RequestOptions = {}): Promise<ReportStatus> {
    return this.#core.status(requestId, options);
  }
}
