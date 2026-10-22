/** Helpers shared by the order request builders and response parsers. */
import type { OrderStatus } from "../../types.js";
import type { NeweggValidationIssue } from "../../errors/index.js";
import { formatPacificWallClock, isPacificWallClockString } from "../../platform/dates.js";
import { asArray, getField } from "../../schemas/wire.js";
import { orderStatusToCode } from "../constants.js";

/** Paging envelope extracted from a Get Order Information response. */
export interface OrdersPageInfo {
  totalCount: number;
  totalPageCount: number;
  pageIndex: number;
  pageSize: number;
}

/**
 * Reads a Newegg list that may be a bare JSON array, an XML-style `{ Inner: [...] }` wrapper,
 * a single wrapped object, or a single bare object. Missing → empty array. Blank entries are
 * dropped: Newegg sends an empty list as `""` (seen live on servicemgmt, 2026-10-10), which
 * must not become a phantom order. Scalars stay, since some lists hold bare order numbers.
 */
export function listItems(container: unknown, innerKey: string): unknown[] {
  const rows = (value: unknown): unknown[] => asArray(value).filter(isPresent);
  if (Array.isArray(container)) return container.filter(isPresent);
  const inner = getField(container, innerKey);
  if (inner !== undefined) return rows(inner);
  return rows(container);
}

function isPresent(value: unknown): boolean {
  return (
    value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "")
  );
}

/** True when `value` is exactly one of the own keys of `known` (rejects "toString", numbers, etc.). */
export function isKnownKey(known: Record<string, true>, value: unknown): boolean {
  return typeof value === "string" && Object.hasOwn(known, value);
}

// Wire formats: the two Newegg accepted for `LastUpdatedAfter` in the 2026-10-21 probe (contracts
// §10.1), checked by isPacificWallClockString; the same check guards `OrderDateFrom` / `OrderDateTo` (§10).

/**
 * Records an issue unless `value` is a valid `Date` or a Pacific wall-clock string in one of the
 * two wire formats naming a real calendar date and time. A string is sent verbatim, so anything
 * else would reach Newegg unvalidated.
 */
export function checkPacificDateInput(
  path: string,
  value: unknown,
  issues: NeweggValidationIssue[],
): void {
  const valid =
    value instanceof Date
      ? !Number.isNaN(value.getTime())
      : typeof value === "string" && isPacificWallClockString(value);
  if (!valid) {
    issues.push({
      path,
      message:
        'must be a valid Date or a Pacific string "MM/DD/YYYY HH:mm:ss" or "YYYY-MM-DD HH:mm:ss"',
    });
  }
}

/**
 * Records an issue when a defined `countryCode` is not a non-blank string without surrounding
 * whitespace. It is rejected rather than trimmed: the SDK never rewrites a caller's value.
 */
export function checkCountryCodeInput(value: unknown, issues: NeweggValidationIssue[]): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value === "" || value !== value.trim())
  ) {
    issues.push({
      path: "countryCode",
      message: "must be a non-empty string without leading or trailing whitespace, e.g. USA",
    });
  }
}

/** Wire code of a status already validated as a concrete filter (never `"unknown"`). */
export function statusCode(status: OrderStatus): number {
  const code = orderStatusToCode(status);
  if (code === undefined) throw new Error(`Unmapped order status "${status}".`);
  return code;
}

export function renderOrderDate(value: Date | string): string {
  return typeof value === "string" ? value : formatPacificWallClock(value);
}
