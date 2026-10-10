/**
 * Request builders + tolerant response parsers for the Item Lookup Report (contracts §12).
 * Parsers use the `schemas/wire.ts` readers — Newegg sends numbers as strings, single
 * objects where arrays are documented (`ResponseList`, `ItemList`), XML-era wrapper nodes
 * (`ResponseInfo`, `Item`), and inconsistent key casing (`RequestId` vs `RequestID`).
 */
import type { CatalogLookupInput, CatalogMatch } from "../types.js";
import { codeToCondition, conditionToCode } from "../schemas/condition.js";
import { asArray, asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import {
  buildStatusRequest,
  parseStatusResponse,
  parseSubmitResponse as parseSubmit,
} from "../reportmgmt/lifecycle.js";
import { ITEM_LOOKUP_OPERATION_TYPE, ITEM_LOOKUP_PAGE_SIZE } from "./constants.js";

// The status request/response shapes are report-type independent (§12.2) and live in the shared
// reportmgmt lifecycle; re-exported so the catalog's parse surface is unchanged.
export { buildStatusRequest, parseStatusResponse };

/** Extracts the request id from an Item Lookup submit response (§12.1). */
export function parseSubmitResponse(json: unknown): { requestId: string } {
  const { requestId } = parseSubmit(json, "item lookup", "catalog.lookupSubmit");
  return { requestId };
}

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
