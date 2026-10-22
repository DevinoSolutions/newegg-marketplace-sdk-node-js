/** Schemas and helpers shared by every Reports Management tool. */
import { z } from "zod";
import { ReportTimeoutError } from "@devino/newegg-marketplace-sdk";
import type {
  CollectedReport,
  DownloadedReport,
  NeweggClient,
  ReportWaitOptions,
} from "@devino/newegg-marketplace-sdk";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  type ToolContext,
  type ToolResult,
} from "../shared.js";

/** Default bounded wait before returning pending (seconds). */
export const DEFAULT_WAIT_SECONDS = 55;
/** Rows returned per call unless the caller asks for fewer/more (hard cap {@link MAX_LIMIT}). */
export const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// shared schemas + helpers
// ---------------------------------------------------------------------------
export const waitSecondsSchema = z
  .number()
  .int()
  .min(5)
  .max(115)
  .optional()
  .describe("How long to wait for the async report before returning pending (default 55).");

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);

export const reportDateSchema = z
  .string()
  .min(8)
  .max(32)
  .describe("Pacific Time date: YYYY-MM-DD (e.g. 2026-09-30) or M/D/YYYY H:mm:ss.");

export const rowSchema = z.record(z.string(), z.unknown());

export const reportOutputSchema = z.object({
  marketplace: marketplaceSchema,
  pending: z.boolean(),
  requestId: z.string().optional(),
  rows: z.array(rowSchema).optional(),
  totalRows: z.number().optional().describe("Rows Newegg reports for the whole report."),
  returnedRows: z.number().optional(),
  truncated: z.boolean().optional().describe("true when more rows exist than were returned."),
  fileName: z.string().optional(),
  message: z.string().optional(),
});

const PENDING_MESSAGE =
  "The report is still processing at Newegg. Call newegg_reports_status with this requestId " +
  "and the same reportType (do NOT resubmit - submissions are limited to 100/hour).";

function pendingResult(marketplace: string, error: ReportTimeoutError): ToolResult {
  return okResult({
    marketplace,
    pending: true,
    requestId: error.requestId,
    message: PENDING_MESSAGE,
  });
}

function identityRow(row: object): Record<string, unknown> {
  return { ...row };
}

/** `map` turns an SDK row into the explicit, PII-free tool row (identity for the money reports). */
export function pagedOutput<Row extends object>(
  collected: CollectedReport<Row>,
  limit: number,
  map: (row: Row) => Record<string, unknown> = identityRow,
): Record<string, unknown> {
  const rows = collected.rows.slice(0, limit).map(map);
  return {
    marketplace: collected.marketplace,
    pending: false,
    requestId: collected.requestId,
    rows,
    totalRows: collected.totalCount,
    returnedRows: rows.length,
    truncated: rows.length < collected.totalCount,
  };
}

export function fileOutput<Row extends object>(
  downloaded: DownloadedReport<Row>,
  limit: number,
  map: (row: Row) => Record<string, unknown> = identityRow,
): Record<string, unknown> {
  const rows = downloaded.rows.slice(0, limit).map(map);
  return {
    marketplace: downloaded.marketplace,
    pending: false,
    requestId: downloaded.requestId,
    ...(downloaded.fileName !== undefined ? { fileName: downloaded.fileName } : {}),
    rows,
    totalRows: downloaded.totalRows,
    returnedRows: rows.length,
    truncated: rows.length < downloaded.totalRows,
  };
}

export function waitOptions(waitSeconds: number | undefined, limit: number): ReportWaitOptions {
  return {
    timeoutMs: (waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
    // Only fetch the pages the caller can actually receive.
    maxPages: Math.max(1, Math.ceil(limit / PAGE_SIZE)),
    maxRows: limit,
  };
}

/** Runs a report; turns a retryable wait timeout into a pending result. */
export async function runReport(
  ctx: ToolContext,
  run: () => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  try {
    return okResult(await run());
  } catch (error) {
    if (error instanceof ReportTimeoutError && error.retryable) {
      return pendingResult(ctx.client.marketplace, error);
    }
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

/** USD on Newegg.com / Neweggbusiness.com, CAD on Newegg.ca. */
export function currencyOf(client: NeweggClient): "USD" | "CAD" {
  return client.marketplace === "ca" ? "CAD" : "USD";
}

export const orderListOutputSchema = reportOutputSchema.extend({
  currency: z.enum(["USD", "CAD"]).optional().describe("Currency of every amount."),
});
