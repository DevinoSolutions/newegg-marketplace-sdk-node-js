/**
 * Helpers shared by the Service Management reads (RMA information and courtesy refunds;
 * contracts §18): paging validation, criteria-date rendering and tolerant response unwrapping.
 */
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { formatPacificWallClock, parsePacificTimestamp } from "../platform/dates.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";

/** Maximum `PageSize` for Get RMA Information and Get Courtesy Refund Information. */
const SERVICE_PAGE_SIZE_MAX = 100;

/** Paging envelope extracted from a Service Management response. */
export interface ServicePageInfo {
  totalCount: number;
  totalPageCount: number;
  pageIndex: number;
  pageSize: number;
}

/**
 * Validates paging (throws rather than silently clamping) and returns the resolved values.
 * Defaults to page 1 and the maximum page size.
 */
export function resolvePaging(
  page: number | undefined,
  pageSize: number | undefined,
  issues: NeweggValidationIssue[],
): { pageIndex: number; pageSize: number } {
  const size = pageSize ?? SERVICE_PAGE_SIZE_MAX;
  if (!Number.isInteger(size) || size < 1 || size > SERVICE_PAGE_SIZE_MAX) {
    issues.push({
      path: "pageSize",
      message: `must be an integer between 1 and ${SERVICE_PAGE_SIZE_MAX}`,
    });
  }
  const index = page ?? 1;
  if (!Number.isInteger(index) || index < 1) {
    issues.push({ path: "page", message: "must be an integer >= 1" });
  }
  return { pageIndex: index, pageSize: size };
}

/** Throws a {@link NeweggValidationError} when any issue was collected. */
export function throwIfInvalid(message: string, issues: NeweggValidationIssue[]): void {
  if (issues.length > 0) throw new NeweggValidationError(message, issues);
}

/** Renders a criteria date: a `Date` as Pacific `YYYY-MM-DD HH:mm:ss`, a string verbatim. */
export function renderCriteriaDate(value: Date | string): string {
  return typeof value === "string" ? value : formatPacificWallClock(value);
}

/**
 * Validates an optional criteria date: an invalid `Date`, or a string that
 * {@link parsePacificTimestamp} cannot read (blank or unparseable), is rejected before any request.
 * A string is still sent verbatim.
 */
export function checkCriteriaDate(
  value: Date | string | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): void {
  if (value === undefined) return;
  const valid =
    typeof value === "string"
      ? parsePacificTimestamp(value) !== undefined
      : !Number.isNaN(value.getTime());
  if (!valid) issues.push({ path, message: "must be a valid date" });
}

/**
 * Reads a Newegg list that may be a bare JSON array, an XML-style `{ Inner: [...] }` wrapper
 * (under any of `innerKeys`, since the docs vary the casing), a single wrapped object, or a
 * single bare object. Missing -> empty array. Only objects count as rows: VERIFIED live
 * 2026-10-10, an empty list arrives as `""` (e.g. `"CourtesyRefundInfoList": ""`), which must
 * not become a phantom row.
 */
export function listItems(container: unknown, ...innerKeys: string[]): unknown[] {
  if (Array.isArray(container)) return container.filter(isRecord);
  for (const key of innerKeys) {
    const inner = getField(container, key);
    if (inner !== undefined) return asArray(inner).filter(isRecord);
  }
  return asArray(container).filter(isRecord);
}

/** Strips the optional `NeweggAPIResponse` wrapper and returns `{ root, body }`. */
export function unwrapResponse(
  json: unknown,
  correlationId: string,
): { root: unknown; body: unknown } {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  if (asBoolean(getField(root, "IsSuccess")) === false) {
    throw new NeweggApiError("Newegg reported the request as unsuccessful (IsSuccess=false).", {
      correlationId,
      details: { memo: asString(getField(root, "Memo")) },
    });
  }
  return { root, body: getField(root, "ResponseBody") ?? root };
}

/** Reads `PageInfo`; missing fields default to 0 so callers can fall back to the requested paging. */
export function parsePageInfo(body: unknown): ServicePageInfo {
  const info = getField(body, "PageInfo");
  return {
    totalCount: asNumber(getField(info, "TotalCount")) ?? 0,
    totalPageCount: asNumber(getField(info, "TotalPageCount")) ?? 0,
    pageIndex: asNumber(getField(info, "PageIndex")) ?? 0,
    pageSize: asNumber(getField(info, "PageSize")) ?? 0,
  };
}
