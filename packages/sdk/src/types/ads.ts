/** Sponsored Ads types (contracts §25). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// Sponsored Ads reads (contracts §25)
// ----------------------------------------------------------------------------
/** Paging and sorting shared by every Sponsored Ads list/report input. */
export interface AdsPagingInput {
  /** 1-based page (default 1, at most 10,000: an SDK sanity bound, not a documented Newegg limit). */
  page?: number;
  /** Rows per page (default 100; the maximum is 100 for campaigns/groups, 9,999,999 elsewhere). */
  pageSize?: number;
  /** Field to sort by (Newegg's default is `InDate`). */
  sortField?: string;
  /** Sort direction (Newegg's default is descending). */
  sortOrder?: "asc" | "desc";
}

/** `Active` = Processing, Delivering or Out of budget; `Inactive` = Inactive or Ended. */
export type AdsActiveStatusFilter = "active" | "inactive";

/** Whether a name filter matches by text (fuzzy) or by identifier number (exact). */
export type AdsSearchBy = "name" | "number";

export interface ListAdsCampaignsInput extends AdsPagingInput {
  /** Value matched against `searchBy` (a campaign name, or a campaign number). */
  keyword?: string;
  /** What `keyword` matches (default `"name"`). */
  searchBy?: AdsSearchBy;
  /** Campaign type: 0 manual targeting, 1 auto targeting. */
  type?: number;
  /** 0 Sponsored Products, 1 Sponsored Headlines, 2 Sponsored Video, 3 Sponsored Display, 4 Offsite Ads. */
  sponsorType?: number;
  /** With `sponsorType` 3: 2 on-site, 3 off-site product targeting. */
  displayType?: number;
  activeStatus?: AdsActiveStatusFilter;
  /** ISO 3-letter country code, e.g. `"USA"`. */
  countryCode?: string;
  /** Campaign start filter, `YYYY-MM-DD` (a `Date` is rendered in Pacific time). */
  fromDate?: Date | string;
  /** Campaign end filter, `YYYY-MM-DD`. */
  toDate?: Date | string;
}

export interface ListAdsGroupsInput extends AdsPagingInput {
  campaignNumber: number;
  /** Value matched against `searchBy` (a group name, or comma-separated group numbers). */
  keyword?: string;
  /** What `keyword` matches (default `"name"`). */
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
  fromDate?: Date | string;
  toDate?: Date | string;
}

export interface ListAdsProductsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  /** ISO 3-letter country code (default `"USA"`). */
  countryCode?: string;
}

export interface ListAdsKeywordsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber?: number;
  /** Fuzzy-matched keyword text. */
  keyword?: string;
  activeStatus?: AdsActiveStatusFilter;
}

export interface ListAdsNegativeKeywordsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber: number;
  /** Value matched against `searchBy` (keyword text, or a negative keyword number). */
  keyword?: string;
  searchBy?: AdsSearchBy;
  /** Only active (`true`) or only deactivated (`false`) negative keywords. */
  active?: boolean;
}

export interface SuggestAdsKeywordsInput {
  /** Newegg item numbers (1-50) to get keyword and bid recommendations for. */
  itemNumbers: string[];
  /** Optional keyword texts to price as well. */
  keywords?: string[];
  /** 0 Sponsored Products (default), 1 Sponsored Headlines, 2 Sponsored Video. */
  sponsorType?: number;
  /** `"manual"` (default) or `"auto"` targeting. */
  targeting?: "manual" | "auto";
  /** `"cpm"` or `"cpc"`. */
  costModel?: "cpm" | "cpc";
}

export interface ListAdsMatchTypesInput {
  campaignNumber: number;
  groupNumber: number;
}

/** Which surface a product-targeting suggestion is for (`productType` 1-3). */
export type AdsTargetingProductType = "productTargeting" | "displayOnSite" | "displayOffSite";

export interface SuggestAdsCategoryTargetingInput {
  /** Newegg category numbers (1-50). */
  categoryCodes: string[];
  productType: AdsTargetingProductType;
  /** `"recommend"` (0) or `"search"` (1); default `"recommend"`. */
  mode?: "recommend" | "search";
  countryCode?: string;
}

export interface SuggestAdsItemTargetingInput {
  /** Newegg item numbers (1-50). */
  itemNumbers: string[];
  productType: AdsTargetingProductType;
  mode?: "recommend" | "search";
  countryCode?: string;
}

/** Performance report over a date range. `fromDate` and `toDate` are required (`YYYY-MM-DD`). */
export interface AdsPerformanceRange {
  fromDate: Date | string;
  toDate: Date | string;
}

export interface GetAdsGroupPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  /** Restrict to one campaign. */
  campaignNumber?: number;
  /** Campaign type: 0 manual, 1 auto. */
  type?: number;
  sponsorType?: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

export interface GetAdsProductPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

export interface GetAdsKeywordPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

/** Bid recommendation triple Newegg attaches to keywords, groups and match types. */
export interface AdsSuggestedBid {
  suggBid?: number;
  suggBidLowest?: number;
  suggBidMost?: number;
}

/** Advertising metrics of a performance row. `acos` = spend / sales. */
export interface AdsMetrics {
  spend?: number;
  sales?: number;
  acos?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  orders?: number;
  /** Conversion rate. */
  cr?: number;
  cpc?: number;
}

export interface AdsCampaign {
  campaignNumber: number;
  name?: string;
  countryCode?: string;
  /** 0 manual, 1 auto, 2/3 headlines manual/auto, 4/5 video manual/auto, 6 sponsored display. */
  type?: number;
  /** `Active` or `Inactive`. */
  activeStatus?: string;
  /** Pending, Delivering, Processing, Out of budget, Inactive or Ended. */
  status?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  dailyBudget?: number;
  groupCount?: number;
  /** Pacific-time text as Newegg sent it, e.g. `Wed May 04 03:57:04 PDT 2022`. */
  createdAt?: string;
  lastEditedAt?: string;
  displayType?: string;
  declineReason?: string;
  /** 0 CPM, 1 CPC. */
  costModel?: number;
}

export interface AdsGroup extends AdsSuggestedBid {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber: number;
  groupName?: string;
  countryCode?: string;
  defaultBid?: number;
  offSiteBid?: number;
  /** 0 keyword, 1 product targeting, 2 on-site product, 3 off-site product targeting. */
  type?: number;
  keywordCount?: number;
  productCount?: number;
  /** Newegg item numbers in the group. */
  productItemNumbers: string[];
  activeStatus?: string;
  status?: string;
  createdAt?: string;
  landingPageType?: number;
  landingPageUrl?: string;
  declineReason?: string;
  /** 0 CPM, 1 CPC. */
  costModel?: number;
}

export interface AdsGroupPerformance extends AdsGroup, AdsMetrics {}

export interface AdsProduct {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber?: number;
  groupName?: string;
  itemNumber: string;
  itemTitle?: string;
  countryCode?: string;
  sellingPrice?: number;
  sellerPartNumber?: string;
  itemStatus?: string;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsProductPerformance extends AdsProduct, AdsMetrics {
  createdAt?: string;
}

export interface AdsKeyword extends AdsSuggestedBid {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber?: number;
  groupName?: string;
  keyword: string;
  /** 0 exact, 1 broad, 6 phrase. */
  matchType?: number;
  normalizedKeyword?: string;
  keywordUrl?: string;
  searchVolume?: string;
  /** Low, Medium or High. */
  competition?: string;
  bid?: number;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsKeywordPerformance extends AdsKeyword, AdsMetrics {
  createdAt?: string;
}

export interface AdsNegativeKeyword {
  /** Identifier of the negative keyword. */
  transactionNumber?: number;
  keyword: string;
  formatKeyword?: string;
  /** 0 exact match, 6 phrase match. */
  keywordType?: number;
  /** 0 deactivated, 1 active. */
  status?: number;
}

/** Bid of an auto-targeting match type (2 close, 3 loose, 4 substitutes, 5 complements). */
export interface AdsMatchType extends AdsSuggestedBid {
  matchType: number;
  matchTypeName?: string;
  bid?: number;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsKeywordSuggestion extends AdsSuggestedBid {
  keyword: string;
  normalizedKeyword?: string;
  /** The seller's item numbers the keyword was suggested for. */
  itemNumbers: string[];
  keywordUrl?: string;
  /** 0 exact, 1 broad, 6 phrase. */
  matchType?: number;
  searchVolume?: string;
  competition?: string;
  bid?: number;
}

export interface AdsCategoryTargeting {
  categoryCode: string;
  priceSuggestBid?: number;
  priceLowerBound?: number;
  priceHigherBound?: number;
  lastEditedAt?: string;
}

export interface AdsItemTargeting {
  itemNumber: string;
  relatedPrimaryItem?: string;
  priceSuggestBid?: number;
  priceLowerBound?: number;
  priceHigherBound?: number;
}

/** A page of Sponsored Ads rows. Every Sponsored Ads read returns this shape. */
export interface AdsPage<T> {
  marketplace: NeweggMarketplace;
  rows: T[];
  /** `totalRows` as sent (the count across all pages), else the rows on this page. */
  totalRows: number;
  /** Echo of the requested paging (absent for the unpaged suggestion reads). */
  page?: number;
  pageSize?: number;
  /** Newegg's `header[0].msg`, e.g. `search campaigns success`. */
  message?: string;
  /** Newegg's `header[0].bizCode`, e.g. `025`. */
  bizCode?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Result of {@link AdsApi.suggestKeywords}: the page plus the group-level suggestions. */
export interface AdsKeywordSuggestionsResult extends AdsPage<AdsKeywordSuggestion> {
  suggestedBid: AdsSuggestedBid;
  /** Suggested bids of the auto-targeting match types (2 close ... 5 complements). */
  matchTypes: AdsMatchType[];
}

/**
 * Sponsored Ads reads (contracts §25). Newegg.com and Newegg.ca: on Newegg Business every method
 * throws {@link UnsupportedMarketplaceOperationError} before sending. Every method is a READ (each
 * endpoint is a `POST` search or synchronous report). Creating, changing and activating campaigns,
 * ad groups, products, keywords, negative keywords and targeting spends money and is intentionally
 * not implemented.
 */
export interface AdsApi {
  /** Campaign List / Campaign Performance Report (1,000 req/hr). */
  listCampaigns(
    input?: ListAdsCampaignsInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsCampaign>>;
  /** Group List. */
  listGroups(input: ListAdsGroupsInput, options?: RequestOptions): Promise<AdsPage<AdsGroup>>;
  /** Product List: the items in one ad group. */
  listProducts(input: ListAdsProductsInput, options?: RequestOptions): Promise<AdsPage<AdsProduct>>;
  /** Keywords List. */
  listKeywords(input: ListAdsKeywordsInput, options?: RequestOptions): Promise<AdsPage<AdsKeyword>>;
  /** Negative Keyword List. */
  listNegativeKeywords(
    input: ListAdsNegativeKeywordsInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsNegativeKeyword>>;
  /** Auto Targeting Match Type List: the bid of each match type of an auto-targeting group. */
  listMatchTypes(
    input: ListAdsMatchTypesInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsMatchType>>;
  /** Keywords Suggest: recommended keywords and bids for items. Creates nothing. */
  suggestKeywords(
    input: SuggestAdsKeywordsInput,
    options?: RequestOptions,
  ): Promise<AdsKeywordSuggestionsResult>;
  /** Product Targeting Categories: recommended bids per category. Creates nothing. */
  suggestCategoryTargeting(
    input: SuggestAdsCategoryTargetingInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsCategoryTargeting>>;
  /** Product Targeting Individual: recommended bids per item. Creates nothing. */
  suggestItemTargeting(
    input: SuggestAdsItemTargetingInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsItemTargeting>>;
  /** Group Performance Report (synchronous; spend, sales, ACoS, clicks per ad group). */
  getGroupPerformance(
    input: GetAdsGroupPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsGroupPerformance>>;
  /** Product Performance Report (synchronous). */
  getProductPerformance(
    input: GetAdsProductPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsProductPerformance>>;
  /** Keywords Performance Report (synchronous). */
  getKeywordPerformance(
    input: GetAdsKeywordPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsKeywordPerformance>>;
}
