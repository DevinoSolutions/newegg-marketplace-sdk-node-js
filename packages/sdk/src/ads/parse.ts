/**
 * Pure request builders and tolerant response parsers for the Sponsored Ads reads (contracts §25).
 * Free of transport concerns so they can be unit-tested against raw wire fixtures. Unlike the rest
 * of the API, Sponsored Ads speaks camelCase JSON and answers `{ header: [{ msg, bizCode }], rows,
 * totalRows }` instead of the `NeweggAPIResponse` envelope; the readers still tolerate numbers as
 * strings, single rows as objects, empty lists as `""` and the envelope, like every other module.
 */
import type {
  AdsActiveStatusFilter,
  AdsCampaign,
  AdsCategoryTargeting,
  AdsGroup,
  AdsGroupPerformance,
  AdsItemTargeting,
  AdsKeyword,
  AdsKeywordPerformance,
  AdsKeywordSuggestion,
  AdsMatchType,
  AdsMetrics,
  AdsNegativeKeyword,
  AdsPagingInput,
  AdsProduct,
  AdsProductPerformance,
  AdsSearchBy,
  AdsSuggestedBid,
  AdsTargetingProductType,
  GetAdsGroupPerformanceInput,
  GetAdsKeywordPerformanceInput,
  GetAdsProductPerformanceInput,
  ListAdsCampaignsInput,
  ListAdsGroupsInput,
  ListAdsKeywordsInput,
  ListAdsMatchTypesInput,
  ListAdsNegativeKeywordsInput,
  ListAdsProductsInput,
  SuggestAdsCategoryTargetingInput,
  SuggestAdsItemTargetingInput,
  SuggestAdsKeywordsInput,
} from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { formatPacificWallClock } from "../platform/dates.js";
import { asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import { listItems, throwIfInvalid, unwrapResponse } from "../servicemgmt/shared.js";
import {
  ADS_GROUP_PERFORMANCE_EXT_URL,
  ADS_KEYWORD_PERFORMANCE_EXT_URL,
  ADS_LIST_PAGE_SIZE_MAX,
  ADS_PAGE_SIZE_DEFAULT,
  ADS_PAGE_SIZE_MAX,
  ADS_PRODUCT_PERFORMANCE_EXT_URL,
} from "./constants.js";

// ---------------------------------------------------------------------------
// input validation + request builders
// ---------------------------------------------------------------------------
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MAX_KEYWORD_LENGTH = 200;
const MAX_LIST_ENTRIES = 50;
const COUNTRY_CODE = /^[A-Z]{3}$/;
const ITEM_NUMBER = /^[A-Za-z0-9-]{1,40}$/;
const CATEGORY_CODE = /^\d{1,10}$/;
const NUMBER_LIST = /^\d+(?:\s*,\s*\d+)*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SORT_FIELD = /^[A-Za-z]{1,40}$/;

const PRODUCT_TYPE_CODES: Readonly<Record<AdsTargetingProductType, number>> = {
  productTargeting: 1,
  displayOnSite: 2,
  displayOffSite: 3,
};

/** Wire values of a name/number filter, per list. */
interface SearchTypes {
  name: string;
  number: string;
}
const CAMPAIGN_SEARCH: SearchTypes = { name: "CAMPAIGN_NAME", number: "CAMPAIGN_NUM" };
const GROUP_SEARCH: SearchTypes = { name: "GROUP_NAME", number: "GROUP_NUM" };
const NEGATIVE_SEARCH: SearchTypes = { name: "NEGATIVE_NAME", number: "NEGATIVE_NUM" };

function checkId(value: unknown, path: string, issues: NeweggValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    issues.push({ path, message: "must be a positive integer identifier" });
    return undefined;
  }
  return value;
}

function checkOptionalInt(
  value: number | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push({ path, message: "must be a non-negative integer" });
    return undefined;
  }
  return value;
}

function checkCountry(
  value: string | undefined,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!COUNTRY_CODE.test(value)) {
    issues.push({ path: "countryCode", message: "must be a 3-letter ISO country code, e.g. USA" });
    return undefined;
  }
  return value;
}

function checkText(
  value: string | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_KEYWORD_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    issues.push({
      path,
      message: `must be 1-${MAX_KEYWORD_LENGTH} characters without control characters`,
    });
    return undefined;
  }
  return trimmed;
}

/** Renders a date-only criterion (`YYYY-MM-DD`); a `Date` is read as Pacific time. */
function checkDay(
  value: Date | string | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (DATE_ONLY.test(value)) return value;
  } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatPacificWallClock(value).slice(0, 10);
  }
  issues.push({ path, message: "must be a YYYY-MM-DD date" });
  return undefined;
}

function checkRequiredDay(
  value: Date | string | undefined,
  path: string,
  issues: NeweggValidationIssue[],
): string | undefined {
  if (value === undefined) {
    issues.push({ path, message: "is required (YYYY-MM-DD)" });
    return undefined;
  }
  return checkDay(value, path, issues);
}

function activeStatusWire(
  value: AdsActiveStatusFilter | undefined,
  issues: NeweggValidationIssue[],
): string | null {
  if (value === undefined) return null;
  if (value === "active") return "Active";
  if (value === "inactive") return "Inactive";
  issues.push({ path: "activeStatus", message: 'must be "active" or "inactive"' });
  return null;
}

/** Resolves a name/number filter into the `searchKeywordType` + `keyword` wire pair. */
function searchFilter(
  keyword: string | undefined,
  searchBy: AdsSearchBy | undefined,
  types: SearchTypes,
  issues: NeweggValidationIssue[],
): { searchKeywordType: string | null; keyword: string | null } {
  if (searchBy !== undefined && searchBy !== "name" && searchBy !== "number") {
    issues.push({ path: "searchBy", message: 'must be "name" or "number"' });
  }
  if (keyword === undefined) {
    if (searchBy !== undefined) issues.push({ path: "keyword", message: "is required with searchBy" });
    return { searchKeywordType: null, keyword: null };
  }
  const text = checkText(keyword, "keyword", issues);
  if (text === undefined) return { searchKeywordType: null, keyword: null };
  if (searchBy === "number") {
    if (!NUMBER_LIST.test(text)) {
      issues.push({ path: "keyword", message: "must be identifier number(s) with searchBy=number" });
    }
    return { searchKeywordType: types.number, keyword: text.replace(/\s+/g, "") };
  }
  return { searchKeywordType: types.name, keyword: text };
}

interface BuiltPaging {
  pageInfo: Record<string, unknown>;
  page: number;
  pageSize: number;
}

function buildPaging(
  input: AdsPagingInput,
  maxPageSize: number,
  issues: NeweggValidationIssue[],
): BuiltPaging {
  const size = input.pageSize ?? Math.min(ADS_PAGE_SIZE_DEFAULT, maxPageSize);
  if (!Number.isInteger(size) || size < 1 || size > maxPageSize) {
    issues.push({ path: "pageSize", message: `must be an integer between 1 and ${maxPageSize}` });
  }
  const page = input.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    issues.push({ path: "page", message: "must be an integer >= 1" });
  }
  const { sortField, sortOrder } = input;
  if (sortField !== undefined && !SORT_FIELD.test(sortField)) {
    issues.push({ path: "sortField", message: "must be 1-40 letters" });
  }
  if (sortOrder !== undefined && sortOrder !== "asc" && sortOrder !== "desc") {
    issues.push({ path: "sortOrder", message: 'must be "asc" or "desc"' });
  }
  return {
    pageInfo: {
      pageIndex: page,
      pageSize: size,
      sortField: sortField ?? null,
      sortType: sortOrder === undefined ? null : sortOrder === "asc" ? "Asc" : "Desc",
    },
    page,
    pageSize: size,
  };
}

function checkList(
  values: readonly string[] | undefined,
  path: string,
  pattern: RegExp,
  what: string,
  issues: NeweggValidationIssue[],
  required: boolean,
): string[] {
  if (values === undefined) {
    if (required) issues.push({ path, message: "is required" });
    return [];
  }
  if (!Array.isArray(values) || (required && values.length < 1) || values.length > MAX_LIST_ENTRIES) {
    issues.push({
      path,
      message: `must be an array of ${required ? "1" : "0"}-${MAX_LIST_ENTRIES} ${what}`,
    });
    return [];
  }
  const out: string[] = [];
  values.forEach((value, i) => {
    if (typeof value !== "string" || !pattern.test(value)) {
      issues.push({ path: `${path}.${i}`, message: `is not a valid ${what.replace(/s$/, "")}` });
    } else {
      out.push(value);
    }
  });
  return out;
}

export interface BuiltAdsRequest {
  body: unknown;
  /** Echo of the requested paging; absent for the unpaged suggestion reads. */
  page?: number;
  pageSize?: number;
}

export function buildCampaignListRequest(
  sellerId: string,
  input: ListAdsCampaignsInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_LIST_PAGE_SIZE_MAX, issues);
  const filter = searchFilter(input.keyword, input.searchBy, CAMPAIGN_SEARCH, issues);
  const countryCode = checkCountry(input.countryCode, issues);
  const type = checkOptionalInt(input.type, "type", issues);
  const sponsorType = checkOptionalInt(input.sponsorType, "sponsorType", issues);
  const displayType = checkOptionalInt(input.displayType, "displayType", issues);
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  const fromDate = checkDay(input.fromDate, "fromDate", issues);
  const toDate = checkDay(input.toDate, "toDate", issues);
  throwIfInvalid("Invalid Sponsored Ads campaign list request.", issues);
  return {
    body: {
      sellerId,
      countryCode: countryCode ?? null,
      searchKeywordType: filter.searchKeywordType,
      keyword: filter.keyword,
      type: type ?? null,
      sponsorType: sponsorType ?? null,
      displayType: displayType ?? null,
      activeStatus,
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildGroupListRequest(sellerId: string, input: ListAdsGroupsInput): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_LIST_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const filter = searchFilter(input.keyword, input.searchBy, GROUP_SEARCH, issues);
  const countryCode = checkCountry(input.countryCode, issues);
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  const fromDate = checkDay(input.fromDate, "fromDate", issues);
  const toDate = checkDay(input.toDate, "toDate", issues);
  throwIfInvalid("Invalid Sponsored Ads group list request.", issues);
  return {
    body: {
      sellerId,
      countryCode: countryCode ?? null,
      campaignNumber,
      searchKeywordType: filter.searchKeywordType,
      keyword: filter.keyword,
      activeStatus,
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildProductListRequest(
  sellerId: string,
  input: ListAdsProductsInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_LIST_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber = checkId(input.groupNumber, "groupNumber", issues);
  const filter = searchFilter(input.keyword, input.searchBy, GROUP_SEARCH, issues);
  const countryCode = checkCountry(input.countryCode, issues) ?? "USA";
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  throwIfInvalid("Invalid Sponsored Ads product list request.", issues);
  return {
    body: {
      sellerId,
      countryCode,
      campaignNumber,
      groupNumber,
      searchKeywordType: filter.searchKeywordType,
      keyword: filter.keyword,
      activeStatus,
      countries: [countryCode],
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildKeywordListRequest(
  sellerId: string,
  input: ListAdsKeywordsInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber =
    input.groupNumber === undefined ? undefined : checkId(input.groupNumber, "groupNumber", issues);
  const keyword = checkText(input.keyword, "keyword", issues);
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  throwIfInvalid("Invalid Sponsored Ads keyword list request.", issues);
  return {
    body: {
      sellerId,
      campaignNumber,
      groupNumber: groupNumber ?? null,
      searchKeywordType: keyword === undefined ? null : "KEYWORD",
      keyword: keyword ?? null,
      activeStatus,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildNegativeKeywordListRequest(
  sellerId: string,
  input: ListAdsNegativeKeywordsInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber = checkId(input.groupNumber, "groupNumber", issues);
  const filter = searchFilter(input.keyword, input.searchBy, NEGATIVE_SEARCH, issues);
  if (input.active !== undefined && typeof input.active !== "boolean") {
    issues.push({ path: "active", message: "must be a boolean" });
  }
  throwIfInvalid("Invalid Sponsored Ads negative keyword list request.", issues);
  return {
    body: {
      sellerId,
      campaignNumber,
      groupNumber,
      keyword: filter.keyword,
      searchKeywordType: filter.searchKeywordType,
      status: input.active === undefined ? null : input.active ? 1 : 0,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildMatchTypeRequest(
  sellerId: string,
  input: ListAdsMatchTypesInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber = checkId(input.groupNumber, "groupNumber", issues);
  throwIfInvalid("Invalid Sponsored Ads match type request.", issues);
  // This page spells the seller field `sellerID` (capital D), unlike every other operation.
  return { body: { sellerID: sellerId, campaignNumber, groupNumber } };
}

export function buildKeywordSuggestRequest(
  sellerId: string,
  input: SuggestAdsKeywordsInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const itemList = checkList(input.itemNumbers, "itemNumbers", ITEM_NUMBER, "item numbers", issues, true);
  const keywordList: string[] = [];
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords) || input.keywords.length > MAX_LIST_ENTRIES) {
      issues.push({ path: "keywords", message: `must be an array of 0-${MAX_LIST_ENTRIES} keywords` });
    } else {
      input.keywords.forEach((value, i) => {
        const text = checkText(value, `keywords.${i}`, issues);
        if (text !== undefined) keywordList.push(text);
      });
    }
  }
  const sponsorType = checkOptionalInt(input.sponsorType, "sponsorType", issues);
  if (input.targeting !== undefined && input.targeting !== "manual" && input.targeting !== "auto") {
    issues.push({ path: "targeting", message: 'must be "manual" or "auto"' });
  }
  if (input.costModel !== undefined && input.costModel !== "cpm" && input.costModel !== "cpc") {
    issues.push({ path: "costModel", message: 'must be "cpm" or "cpc"' });
  }
  throwIfInvalid("Invalid Sponsored Ads keyword suggestion request.", issues);
  return {
    body: {
      sellerId,
      itemList,
      keywordList,
      sponsorType: sponsorType ?? 0,
      type: input.targeting === "auto" ? 1 : 0,
      costModel: input.costModel === undefined ? null : input.costModel === "cpm" ? 0 : 1,
    },
  };
}

function targetingMode(
  mode: "recommend" | "search" | undefined,
  issues: NeweggValidationIssue[],
): number {
  if (mode !== undefined && mode !== "recommend" && mode !== "search") {
    issues.push({ path: "mode", message: 'must be "recommend" or "search"' });
  }
  return mode === "search" ? 1 : 0;
}

function targetingProductType(
  value: AdsTargetingProductType,
  issues: NeweggValidationIssue[],
): number | undefined {
  const code = PRODUCT_TYPE_CODES[value];
  if (code === undefined) {
    issues.push({
      path: "productType",
      message: 'must be "productTargeting", "displayOnSite" or "displayOffSite"',
    });
  }
  return code;
}

export function buildCategoryTargetingRequest(
  input: SuggestAdsCategoryTargetingInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const categoryList = checkList(
    input.categoryCodes,
    "categoryCodes",
    CATEGORY_CODE,
    "category numbers",
    issues,
    true,
  );
  const productType = targetingProductType(input.productType, issues);
  const type = targetingMode(input.mode, issues);
  const countryCode = checkCountry(input.countryCode, issues);
  throwIfInvalid("Invalid Sponsored Ads category targeting request.", issues);
  return {
    body: { type, productType, categoryList, countryCode: countryCode ?? null },
  };
}

export function buildItemTargetingRequest(input: SuggestAdsItemTargetingInput): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const itemNumberList = checkList(
    input.itemNumbers,
    "itemNumbers",
    ITEM_NUMBER,
    "item numbers",
    issues,
    true,
  );
  const productType = targetingProductType(input.productType, issues);
  const type = targetingMode(input.mode, issues);
  const countryCode = checkCountry(input.countryCode, issues);
  throwIfInvalid("Invalid Sponsored Ads item targeting request.", issues);
  return {
    body: { type, productType, itemNumberList, countryCode: countryCode ?? null },
  };
}

export function buildGroupPerformanceRequest(
  sellerId: string,
  input: GetAdsGroupPerformanceInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_LIST_PAGE_SIZE_MAX, issues);
  const campaignNumber =
    input.campaignNumber === undefined
      ? undefined
      : checkId(input.campaignNumber, "campaignNumber", issues);
  const type = checkOptionalInt(input.type, "type", issues);
  const sponsorType = checkOptionalInt(input.sponsorType, "sponsorType", issues);
  const filter = searchFilter(input.keyword, input.searchBy, GROUP_SEARCH, issues);
  const countryCode = checkCountry(input.countryCode, issues);
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  const fromDate = checkRequiredDay(input.fromDate, "fromDate", issues);
  const toDate = checkRequiredDay(input.toDate, "toDate", issues);
  throwIfInvalid("Invalid Sponsored Ads group performance request.", issues);
  // The performance pages send identifiers as strings in their samples; mirror them.
  return {
    body: {
      sellerId,
      countryCode: countryCode ?? null,
      extUrl: ADS_GROUP_PERFORMANCE_EXT_URL,
      campaignNumber: campaignNumber === undefined ? null : String(campaignNumber),
      type: type ?? null,
      sponsorType: sponsorType ?? null,
      searchKeywordType: filter.searchKeywordType,
      keyword: filter.keyword,
      activeStatus,
      fromDate,
      toDate,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildProductPerformanceRequest(
  sellerId: string,
  input: GetAdsProductPerformanceInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber = checkId(input.groupNumber, "groupNumber", issues);
  const filter = searchFilter(input.keyword, input.searchBy, GROUP_SEARCH, issues);
  const countryCode = checkCountry(input.countryCode, issues) ?? "USA";
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  const fromDate = checkRequiredDay(input.fromDate, "fromDate", issues);
  const toDate = checkRequiredDay(input.toDate, "toDate", issues);
  throwIfInvalid("Invalid Sponsored Ads product performance request.", issues);
  return {
    body: {
      sellerId,
      extUrl: ADS_PRODUCT_PERFORMANCE_EXT_URL,
      countryCode,
      campaignNumber: String(campaignNumber),
      groupNumber: String(groupNumber),
      searchKeywordType: filter.searchKeywordType,
      keyword: filter.keyword,
      activeStatus,
      fromDate,
      toDate,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function buildKeywordPerformanceRequest(
  sellerId: string,
  input: GetAdsKeywordPerformanceInput,
): BuiltAdsRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = buildPaging(input, ADS_PAGE_SIZE_MAX, issues);
  const campaignNumber = checkId(input.campaignNumber, "campaignNumber", issues);
  const groupNumber = checkId(input.groupNumber, "groupNumber", issues);
  const keyword = checkText(input.keyword, "keyword", issues);
  const countryCode = checkCountry(input.countryCode, issues);
  const activeStatus = activeStatusWire(input.activeStatus, issues);
  const fromDate = checkRequiredDay(input.fromDate, "fromDate", issues);
  const toDate = checkRequiredDay(input.toDate, "toDate", issues);
  throwIfInvalid("Invalid Sponsored Ads keyword performance request.", issues);
  return {
    body: {
      sellerId,
      extUrl: ADS_KEYWORD_PERFORMANCE_EXT_URL,
      countryCode: countryCode ?? null,
      campaignNumber: String(campaignNumber),
      groupNumber: String(groupNumber),
      searchKeywordType: keyword === undefined ? null : "KEYWORD",
      keyword: keyword ?? null,
      activeStatus,
      fromDate,
      toDate,
      pageInfo: paging.pageInfo,
    },
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------
function text(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s === undefined || s === "" ? undefined : s;
}

function clip(value: string | undefined, max = 300): string | undefined {
  return value === undefined || value.length <= max ? value : `${value.slice(0, max)}...`;
}

export interface AdsEnvelope {
  rows: unknown[];
  body: unknown;
  totalRows: number;
  message?: string;
  bizCode?: string;
}

/**
 * Unwraps `{ header: [{ msg, bizCode }], rows, totalRows }`. A 200 that carries no `rows` member
 * (an error `header`, or a bare `[{ Code, Message }]` list) becomes a {@link NeweggApiError}, so a
 * failure can never read as an empty result. ASSUMPTION (§25.2): the failure shape is unprobed.
 */
export function unwrapAds(json: unknown, correlationId: string): AdsEnvelope {
  if (Array.isArray(json)) {
    const first = json.find(isRecord);
    const code = asString(getField(first, "Code"));
    if (code !== undefined) {
      throw new NeweggApiError(`Newegg returned an error list (${code}).`, {
        correlationId,
        neweggErrorCode: code,
        details: { message: clip(asString(getField(first, "Message"))) },
      });
    }
  }
  const { body } = unwrapResponse(json, correlationId);
  const header = listItems(getField(body, "header"))[0];
  const message = text(getField(header, "msg"));
  const bizCode = text(getField(header, "bizCode"));
  const rawRows = getField(body, "rows");
  if (rawRows === undefined) {
    throw new NeweggApiError(
      `Newegg returned no rows${message !== undefined ? `: ${clip(message)}` : ""}.`,
      {
        correlationId,
        ...(bizCode !== undefined ? { neweggErrorCode: bizCode } : {}),
        details: { message: clip(message) },
      },
    );
  }
  const rows = listItems(rawRows);
  return {
    rows,
    body,
    totalRows: asNumber(getField(body, "totalRows")) ?? rows.length,
    message,
    bizCode,
  };
}

function bids(row: unknown): AdsSuggestedBid {
  return {
    suggBid: asNumber(getField(row, "suggBid")),
    suggBidLowest: asNumber(getField(row, "suggBidLowest")),
    suggBidMost: asNumber(getField(row, "suggBidMost")),
  };
}

function metrics(row: unknown): AdsMetrics {
  // The tables spell it `ACoS`; every sample spells it `acos`.
  return {
    spend: asNumber(getField(row, "spend")),
    sales: asNumber(getField(row, "sales")),
    acos: asNumber(getField(row, "acos") ?? getField(row, "ACoS")),
    impressions: asNumber(getField(row, "impressions")),
    clicks: asNumber(getField(row, "clicks")),
    ctr: asNumber(getField(row, "ctr")),
    orders: asNumber(getField(row, "orders")),
    cr: asNumber(getField(row, "cr")),
    cpc: asNumber(getField(row, "cpc")),
  };
}

// ---------------------------------------------------------------------------
// row parsers (rows lacking their identifier are dropped)
// ---------------------------------------------------------------------------
export function parseCampaign(row: unknown): AdsCampaign | undefined {
  const campaignNumber = asNumber(getField(row, "campaignNumber"));
  if (campaignNumber === undefined) return undefined;
  return {
    campaignNumber,
    name: text(getField(row, "campaignName")),
    countryCode: text(getField(row, "countryCode")),
    type: asNumber(getField(row, "type")),
    activeStatus: text(getField(row, "activeStatus")),
    status: text(getField(row, "status")),
    startDate: text(getField(row, "startDate")),
    endDate: text(getField(row, "endDate")),
    budget: asNumber(getField(row, "budget")),
    dailyBudget: asNumber(getField(row, "dailyBudget")),
    groupCount: asNumber(getField(row, "groupCount")),
    createdAt: text(getField(row, "inDate")),
    lastEditedAt: text(getField(row, "lastEditDate") ?? getField(row, "LastEditDate")),
    displayType: text(getField(row, "displayType")),
    declineReason: text(getField(row, "declineReason")),
    costModel: asNumber(getField(row, "costModel")),
  };
}

export function parseGroup(row: unknown): AdsGroup | undefined {
  const groupNumber = asNumber(getField(row, "groupNumber"));
  if (groupNumber === undefined) return undefined;
  const products = getField(row, "productList");
  return {
    campaignNumber: asNumber(getField(row, "campaignNumber")),
    campaignName: text(getField(row, "campaignName")),
    groupNumber,
    groupName: text(getField(row, "groupName")),
    countryCode: text(getField(row, "countryCode")),
    defaultBid: asNumber(getField(row, "defaultBid")),
    offSiteBid: asNumber(getField(row, "offSiteBid")),
    type: asNumber(getField(row, "type")),
    ...bids(row),
    keywordCount: asNumber(getField(row, "keywordSize")),
    productCount: asNumber(getField(row, "productSize")),
    productItemNumbers: (Array.isArray(products) ? products : []).flatMap((p) => {
      const v = text(p);
      return v === undefined ? [] : [v];
    }),
    activeStatus: text(getField(row, "activeStatus")),
    status: text(getField(row, "status")),
    createdAt: text(getField(row, "inDate")),
    landingPageType: asNumber(getField(row, "landingPageType")),
    landingPageUrl: text(getField(row, "landingPageUrl")),
    declineReason: text(getField(row, "declineReason")),
    costModel: asNumber(getField(row, "costModel")),
  };
}

export function parseGroupPerformance(row: unknown): AdsGroupPerformance | undefined {
  const group = parseGroup(row);
  return group === undefined ? undefined : { ...group, ...metrics(row) };
}

export function parseProduct(row: unknown): AdsProduct | undefined {
  const itemNumber = text(getField(row, "itemNumber"));
  if (itemNumber === undefined) return undefined;
  return {
    campaignNumber: asNumber(getField(row, "campaignNumber")),
    campaignName: text(getField(row, "campaignName")),
    groupNumber: asNumber(getField(row, "groupNumber")),
    groupName: text(getField(row, "groupName")),
    itemNumber,
    itemTitle: text(getField(row, "itemTitle")),
    countryCode: text(getField(row, "countryCode")),
    sellingPrice: asNumber(getField(row, "sellingPrice")),
    sellerPartNumber: text(getField(row, "sellerPartNumber")),
    itemStatus: text(getField(row, "itemStatus")),
    activeStatus: text(getField(row, "activeStatus")),
    status: text(getField(row, "status")),
    declineReason: text(getField(row, "declineReason")),
  };
}

export function parseProductPerformance(row: unknown): AdsProductPerformance | undefined {
  const product = parseProduct(row);
  return product === undefined
    ? undefined
    : { ...product, ...metrics(row), createdAt: text(getField(row, "inDate")) };
}

export function parseKeyword(row: unknown): AdsKeyword | undefined {
  const keyword = text(getField(row, "keyword"));
  if (keyword === undefined) return undefined;
  return {
    // The Keywords List sample returns 0 for campaign/group numbers when the group was not named.
    campaignNumber: asNumber(getField(row, "campaignNumber")),
    campaignName: text(getField(row, "campaignName")),
    groupNumber: asNumber(getField(row, "groupNumber")),
    groupName: text(getField(row, "groupName")),
    keyword,
    matchType: asNumber(getField(row, "matchType")),
    normalizedKeyword: text(getField(row, "normalizedKeyword")),
    keywordUrl: text(getField(row, "keywordUrl")),
    ...bids(row),
    searchVolume: text(getField(row, "searchVolume")),
    competition: text(getField(row, "competition")),
    bid: asNumber(getField(row, "bid")),
    activeStatus: text(getField(row, "activeStatus")),
    status: text(getField(row, "status")),
    declineReason: text(getField(row, "declineReason")),
  };
}

export function parseKeywordPerformance(row: unknown): AdsKeywordPerformance | undefined {
  const keyword = parseKeyword(row);
  return keyword === undefined
    ? undefined
    : { ...keyword, ...metrics(row), createdAt: text(getField(row, "inDate")) };
}

export function parseNegativeKeyword(row: unknown): AdsNegativeKeyword | undefined {
  const keyword = text(getField(row, "keyword"));
  if (keyword === undefined) return undefined;
  return {
    transactionNumber: asNumber(getField(row, "transactionNumber")),
    keyword,
    formatKeyword: text(getField(row, "formatKeyword")),
    keywordType: asNumber(getField(row, "keywordType")),
    status: asNumber(getField(row, "status")),
  };
}

export function parseMatchType(row: unknown): AdsMatchType | undefined {
  const matchType = asNumber(getField(row, "matchType"));
  if (matchType === undefined) return undefined;
  return {
    matchType,
    matchTypeName: text(getField(row, "matchTypeName")),
    ...bids(row),
    bid: asNumber(getField(row, "bid")),
    activeStatus: text(getField(row, "activeStatus")),
    status: text(getField(row, "status")),
    declineReason: text(getField(row, "declineReason")),
  };
}

export function parseKeywordSuggestion(row: unknown): AdsKeywordSuggestion | undefined {
  const keyword = text(getField(row, "keyword"));
  if (keyword === undefined) return undefined;
  const items = getField(row, "items");
  return {
    keyword,
    normalizedKeyword: text(getField(row, "normalizedKeyword")),
    itemNumbers: (Array.isArray(items) ? items : items === undefined ? [] : [items]).flatMap((i) => {
      const v = text(i);
      return v === undefined ? [] : [v];
    }),
    keywordUrl: text(getField(row, "keywordUrl")),
    ...bids(row),
    matchType: asNumber(getField(row, "matchType")),
    searchVolume: text(getField(row, "searchVolume")),
    competition: text(getField(row, "competition")),
    bid: asNumber(getField(row, "bid")),
  };
}

/** The group-level bid triple and match-type bids that ride next to `rows` on Keywords Suggest. */
export function parseSuggestionExtras(body: unknown): {
  suggestedBid: AdsSuggestedBid;
  matchTypes: AdsMatchType[];
} {
  return {
    suggestedBid: bids(body),
    matchTypes: listItems(getField(body, "matchTypes"))
      .map(parseMatchType)
      .filter((m): m is AdsMatchType => m !== undefined),
  };
}

export function parseCategoryTargeting(row: unknown): AdsCategoryTargeting | undefined {
  const categoryCode = text(getField(row, "relatedSubCode"));
  if (categoryCode === undefined) return undefined;
  return {
    categoryCode,
    priceSuggestBid: asNumber(getField(row, "priceSuggestBid")),
    priceLowerBound: asNumber(getField(row, "priceLowerBound")),
    priceHigherBound: asNumber(getField(row, "priceHigherBound")),
    lastEditedAt: text(getField(row, "lastEditDate")),
  };
}

export function parseItemTargeting(row: unknown): AdsItemTargeting | undefined {
  const itemNumber = text(getField(row, "itemNumber"));
  if (itemNumber === undefined) return undefined;
  return {
    itemNumber,
    relatedPrimaryItem: text(getField(row, "relatedPrimaryItem")),
    priceSuggestBid: asNumber(getField(row, "priceSuggestBid")),
    priceLowerBound: asNumber(getField(row, "priceLowerBound")),
    priceHigherBound: asNumber(getField(row, "priceHigherBound")),
  };
}
