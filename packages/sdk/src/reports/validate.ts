/** Input validation + normalization for report criteria (contracts §17). */
import type {
  ReportDateInput,
  SettlementSummaryInput,
  SettlementTransactionsInput,
} from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import { formatPacificWallClock, parsePacificTimestamp } from "../platform/dates.js";
import { SETTLEMENT_TRANSACTION_TYPE_CODES } from "./constants.js";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar-validity check for `YYYY-MM-DD` (rejects 2026-02-31). */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Normalizes one date criterion; pushes an issue and returns undefined when invalid. */
function normalizeDate(
  value: ReportDateInput,
  path: string,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      issues.push({ path, message: "is an invalid Date" });
      return undefined;
    }
    // Newegg reads report dates as Pacific calendar dates.
    return formatPacificWallClock(value).slice(0, 10);
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    if (isRealDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))) return trimmed;
    issues.push({ path, message: `"${trimmed}" is not a real calendar date` });
    return undefined;
  }
  if (trimmed !== "" && parsePacificTimestamp(trimmed) !== undefined) return trimmed;
  issues.push({
    path,
    message: "must be YYYY-MM-DD, M/D/YYYY H:mm[:ss], YYYY-MM-DD HH:mm[:ss] or a Date",
  });
  return undefined;
}

function orderedRange(from: string, to: string, path: string, issues: NeweggValidationIssue[]) {
  const start = parsePacificTimestamp(from) ?? new Date(`${from}T00:00:00Z`);
  const end = parsePacificTimestamp(to) ?? new Date(`${to}T00:00:00Z`);
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start > end) {
    issues.push({ path, message: "range start must not be after the range end" });
  }
}

/**
 * Normalizes an optional `from`/`to` report date pair (each a `YYYY-MM-DD` or Pacific date-time
 * string, or a `Date`), checking calendar validity and that the range is not inverted. Throws
 * {@link NeweggValidationError} before any submission budget is spent.
 */
export function normalizeDateRange(
  range: { from?: ReportDateInput; to?: ReportDateInput },
  paths: { from: string; to: string },
): { from?: string; to?: string } {
  const issues: NeweggValidationIssue[] = [];
  const out: { from?: string; to?: string } = {};
  if (range.from !== undefined) out.from = normalizeDate(range.from, paths.from, issues);
  if (range.to !== undefined) out.to = normalizeDate(range.to, paths.to, issues);
  if (out.from !== undefined && out.to !== undefined) {
    orderedRange(out.from, out.to, paths.from, issues);
  }
  throwIfIssues(issues);
  return out;
}

/** Throws a {@link NeweggValidationError} listing `issues` when there are any. */
export function throwIfInvalid(issues: NeweggValidationIssue[]): void {
  throwIfIssues(issues);
}

function throwIfIssues(issues: NeweggValidationIssue[]): void {
  if (issues.length > 0) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new NeweggValidationError(`Report validation failed: ${summary}`, issues);
  }
}

export function validateSettlementSummaryInput(input: SettlementSummaryInput): {
  dateFrom: string;
  dateTo: string;
} {
  const issues: NeweggValidationIssue[] = [];
  const dateFrom = normalizeDate(input.dateFrom, "dateFrom", issues);
  const dateTo = normalizeDate(input.dateTo, "dateTo", issues);
  if (dateFrom !== undefined && dateTo !== undefined)
    orderedRange(dateFrom, dateTo, "dateFrom", issues);
  throwIfIssues(issues);
  return { dateFrom: dateFrom as string, dateTo: dateTo as string };
}

export interface NormalizedTransactionsCriteria {
  transactionTypeCode: number;
  settlementDateFrom?: string;
  settlementDateTo?: string;
  settlementDate?: string;
  settlementId?: string;
  orderNumber?: string;
}

function digits(
  value: string | number | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d{1,20}$/.test(text)) {
    issues.push({ path, message: "must be a positive integer (digits only)" });
    return undefined;
  }
  return text;
}

/**
 * Settlement Transaction criteria. Newegg answers RP020 unless one of SettlementID,
 * SettlementDate, or SettlementDateFrom+SettlementDateTo is present - checked here so the
 * caller gets the rule before spending one of the 100 submissions per hour.
 */
export function validateSettlementTransactionsInput(
  input: SettlementTransactionsInput,
): NormalizedTransactionsCriteria {
  const issues: NeweggValidationIssue[] = [];
  const out: NormalizedTransactionsCriteria = {
    transactionTypeCode: SETTLEMENT_TRANSACTION_TYPE_CODES[input.transactionType ?? "all"],
  };
  if (
    input.transactionType !== undefined &&
    !(input.transactionType in SETTLEMENT_TRANSACTION_TYPE_CODES)
  ) {
    issues.push({
      path: "transactionType",
      message: `unknown transaction type "${input.transactionType}"`,
    });
  }
  if (input.settlementDateFrom !== undefined) {
    out.settlementDateFrom = normalizeDate(input.settlementDateFrom, "settlementDateFrom", issues);
  }
  if (input.settlementDateTo !== undefined) {
    out.settlementDateTo = normalizeDate(input.settlementDateTo, "settlementDateTo", issues);
  }
  if (input.settlementDate !== undefined) {
    out.settlementDate = normalizeDate(input.settlementDate, "settlementDate", issues);
  }
  const settlementId = digits(input.settlementId, "settlementId", issues);
  if (settlementId !== undefined) out.settlementId = settlementId;
  const orderNumber = digits(input.orderNumber, "orderNumber", issues);
  if (orderNumber !== undefined) out.orderNumber = orderNumber;

  const hasFrom = input.settlementDateFrom !== undefined;
  const hasTo = input.settlementDateTo !== undefined;
  if (hasFrom !== hasTo) {
    issues.push({
      path: hasFrom ? "settlementDateTo" : "settlementDateFrom",
      message: "settlementDateFrom and settlementDateTo must be given together",
    });
  }
  if (
    input.settlementId === undefined &&
    input.settlementDate === undefined &&
    !(hasFrom && hasTo)
  ) {
    issues.push({
      path: "settlementDate",
      message:
        "Newegg requires settlementId, settlementDate, or both settlementDateFrom and settlementDateTo (RP020)",
    });
  }
  if (out.settlementDateFrom !== undefined && out.settlementDateTo !== undefined) {
    orderedRange(out.settlementDateFrom, out.settlementDateTo, "settlementDateFrom", issues);
  }
  throwIfIssues(issues);
  return out;
}
