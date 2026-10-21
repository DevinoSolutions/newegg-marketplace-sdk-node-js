/** Sponsored Ads response envelope unwrapping and row parsers (contracts §25). Re-exported from `./parse.ts`. */
import type {
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
  AdsProduct,
  AdsProductPerformance,
  AdsSuggestedBid,
} from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import { asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import { listItems, unwrapResponse } from "../servicemgmt/shared.js";

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
    itemNumbers: (Array.isArray(items) ? items : items === undefined ? [] : [items]).flatMap(
      (i) => {
        const v = text(i);
        return v === undefined ? [] : [v];
      },
    ),
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
