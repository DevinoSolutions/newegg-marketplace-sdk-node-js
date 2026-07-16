/**
 * Request builders + tolerant response parsers for the Item Lookup Report (contracts §12).
 * Parsers use the `schemas/wire.ts` readers — Newegg sends numbers as strings, single
 * objects where arrays are documented (`ResponseList`, `ItemList`), XML-era wrapper nodes
 * (`ResponseInfo`, `Item`), and inconsistent key casing (`RequestId` vs `RequestID`).
 */
import type { CatalogLookupInput, CatalogLookupState, CatalogMatch } from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import { codeToCondition, conditionToCode } from "../schemas/condition.js";
import { asArray, asNumber, asString, getField, getPath, isRecord } from "../schemas/wire.js";
import {
  ITEM_LOOKUP_OPERATION_TYPE,
  ITEM_LOOKUP_PAGE_SIZE,
  REPORT_STATUS_OPERATION_TYPE,
} from "./constants.js";

/** A lookup input that actually goes on the wire (neweggItemNumber never does). */
export type WireLookupInput = Exclude<CatalogLookupInput, { neweggItemNumber: string }>;

/** Builds the Item Lookup submit body (§12.1). Callers pre-filter passthrough inputs. */
export function buildLookupSubmitRequest(
  inputs: ReadonlyArray<WireLookupInput>,
): Record<string, unknown> {
  const items = inputs.map((input) => {
    const item: Record<string, unknown> = {};
    if ("upc" in input) {
      item.UPC = input.upc;
    } else {
      item.ManufacturerName = input.manufacturer;
      item.ManufacturerPartNumber = input.manufacturerPartNumber;
    }
    if (input.condition !== undefined) {
      item.Condition = conditionToCode(input.condition);
    }
    if (input.packsOrSets !== undefined) {
      item.PacksOrSets = input.packsOrSets;
    }
    return item;
  });
  return {
    OperationType: ITEM_LOOKUP_OPERATION_TYPE,
    RequestBody: { RequestCriteria: { Item: items } },
  };
}

/** Builds the report-status body (§12.2 — note the `GetRequestStatus` wrapper). */
export function buildStatusRequest(requestId: string): Record<string, unknown> {
  return {
    OperationType: REPORT_STATUS_OPERATION_TYPE,
    RequestBody: {
      GetRequestStatus: { RequestIDList: { RequestID: requestId }, MaxCount: 100 },
    },
  };
}

/** Builds the paged result body (§12.3). */
export function buildLookupResultRequest(
  requestId: string,
  pageIndex: number,
): Record<string, unknown> {
  return {
    OperationType: ITEM_LOOKUP_OPERATION_TYPE,
    RequestBody: {
      RequestID: requestId,
      PageInfo: { PageIndex: pageIndex, PageSize: ITEM_LOOKUP_PAGE_SIZE },
    },
  };
}

function requestIdOf(entry: unknown): string | undefined {
  return asString(getField(entry, "RequestId")) ?? asString(getField(entry, "RequestID"));
}

/** Unwraps `ResponseBody.ResponseList` into entries, tolerating the XML-shaped
 * `ResponseList: { ResponseInfo: {...} }` nesting alongside the JSON array form. */
function responseListEntries(json: unknown): unknown[] {
  const list = getPath(json, ["ResponseBody", "ResponseList"]);
  const inner = getField(list, "ResponseInfo");
  return asArray(inner !== undefined ? inner : list);
}

/** Extracts the request id from a submit response (§12.1: nested in `ResponseList`). */
export function parseSubmitResponse(json: unknown): { requestId: string } {
  for (const entry of responseListEntries(json)) {
    const requestId = requestIdOf(entry);
    if (requestId !== undefined && requestId !== "") return { requestId };
  }
  throw new NeweggApiError("Newegg returned no request id for the item lookup submission.", {
    details: { operation: "catalog.lookupSubmit" },
  });
}

const STATUS_MAP: Record<string, CatalogLookupState> = {
  SUBMITTED: "submitted",
  IN_PROGRESS: "inProgress",
  FINISHED: "finished",
  CANCELLED: "cancelled",
};

/** Maps a status response (§12.2) to the state union for the given request id. */
export function parseStatusResponse(
  json: unknown,
  requestId: string,
): { status: CatalogLookupState; statusRaw?: string } {
  const entries = responseListEntries(json);
  // Prefer the entry matching our request id; fall back to the first (we ask for one id).
  const entry = entries.find((e) => requestIdOf(e) === requestId) ?? entries[0];
  const raw = asString(getField(entry, "RequestStatus"));
  if (raw === undefined) return { status: "unknown" };
  const mapped = STATUS_MAP[raw.trim().toUpperCase()];
  return mapped !== undefined ? { status: mapped } : { status: "unknown", statusRaw: raw };
}

/** Parses one result page (§12.3). Rows without a `NeweggItemNumber` are miss echoes
 * (`Note: "No match found."`) and are skipped — misses surface as `found: false`. */
export function parseLookupResultResponse(json: unknown): {
  matches: CatalogMatch[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
} {
  const body = getField(json, "ResponseBody");
  const pageInfo = getField(body, "PageInfo");
  const list = getField(body, "ItemList");
  // XML shape nests rows as ItemList > Item; JSON is a plain array.
  const inner = getField(list, "Item");
  const rows = asArray(inner !== undefined ? inner : list);
  const matches: CatalogMatch[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const neweggItemNumber = asString(row.NeweggItemNumber);
    if (neweggItemNumber === undefined || neweggItemNumber === "") continue;
    const match: CatalogMatch = { neweggItemNumber };
    const upc = asString(row.UPC);
    if (upc !== undefined) match.upc = upc;
    const condition = codeToCondition(asString(row.Condition));
    if (condition !== undefined) match.condition = condition;
    const packsOrSets = asNumber(row.PacksOrSets);
    if (packsOrSets !== undefined) match.packsOrSets = packsOrSets;
    const manufacturer = asString(row.ManufacturerName);
    if (manufacturer !== undefined) match.manufacturer = manufacturer;
    const mpn = asString(row.ManufacturerPartNumber);
    if (mpn !== undefined) match.manufacturerPartNumber = mpn;
    const title = asString(row.WebsiteShortTitle);
    if (title !== undefined && title !== "") match.websiteShortTitle = title;
    matches.push(match);
  }
  return {
    matches,
    page: asNumber(getField(pageInfo, "PageIndex")) ?? 1,
    pageSize: asNumber(getField(pageInfo, "PageSize")) ?? matches.length,
    totalCount: asNumber(getField(pageInfo, "TotalCount")) ?? matches.length,
    totalPageCount: asNumber(getField(pageInfo, "TotalPageCount")) ?? 1,
  };
}
