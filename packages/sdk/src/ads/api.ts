import { randomUUID } from "node:crypto";
import type {
  AdsApi,
  AdsCampaign,
  AdsCategoryTargeting,
  AdsGroup,
  AdsGroupPerformance,
  AdsItemTargeting,
  AdsKeyword,
  AdsKeywordPerformance,
  AdsKeywordSuggestionsResult,
  AdsMatchType,
  AdsNegativeKeyword,
  AdsPage,
  AdsProduct,
  AdsProductPerformance,
  GetAdsGroupPerformanceInput,
  GetAdsKeywordPerformanceInput,
  GetAdsProductPerformanceInput,
  ListAdsCampaignsInput,
  ListAdsGroupsInput,
  ListAdsKeywordsInput,
  ListAdsMatchTypesInput,
  ListAdsNegativeKeywordsInput,
  ListAdsProductsInput,
  RequestOptions,
  SuggestAdsCategoryTargetingInput,
  SuggestAdsItemTargetingInput,
  SuggestAdsKeywordsInput,
} from "../types.js";
import type { HttpResult, NeweggHttpClient } from "../client/http.js";
import { Operation } from "../client/operations.js";
import { assertAdsSupported, getAdsPlatform } from "../platform/ads.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { sanitizeRaw } from "../reportmgmt/redact.js";
import {
  ADS_CAMPAIGN_SEARCH_PATH,
  ADS_GROUP_PERFORMANCE_PATH,
  ADS_GROUP_SEARCH_PATH,
  ADS_KEYWORD_PERFORMANCE_PATH,
  ADS_KEYWORD_SEARCH_PATH,
  ADS_KEYWORD_SUGGEST_PATH,
  ADS_MATCH_TYPE_SEARCH_PATH,
  ADS_NEGATIVE_KEYWORD_SEARCH_PATH,
  ADS_PRODUCT_PERFORMANCE_PATH,
  ADS_PRODUCT_SEARCH_PATH,
  ADS_TARGETING_CATEGORIES_PATH,
  ADS_TARGETING_INDIVIDUAL_PATH,
} from "./constants.js";
import {
  type BuiltAdsRequest,
  buildCampaignListRequest,
  buildCategoryTargetingRequest,
  buildGroupListRequest,
  buildGroupPerformanceRequest,
  buildItemTargetingRequest,
  buildKeywordListRequest,
  buildKeywordPerformanceRequest,
  buildKeywordSuggestRequest,
  buildMatchTypeRequest,
  buildNegativeKeywordListRequest,
  buildProductListRequest,
  buildProductPerformanceRequest,
  parseCampaign,
  parseCategoryTargeting,
  parseGroup,
  parseGroupPerformance,
  parseItemTargeting,
  parseKeyword,
  parseKeywordPerformance,
  parseKeywordSuggestion,
  parseMatchType,
  parseNegativeKeyword,
  parseProduct,
  parseProductPerformance,
  parseSuggestionExtras,
  unwrapAds,
} from "./parse.js";

/**
 * Sponsored Ads reads (contracts §25): campaign / ad group / product / keyword / negative keyword
 * lists, match-type bids, keyword and targeting suggestions, and the synchronous group, product and
 * keyword performance reports. Every operation is a READ although all are `POST` with a body.
 * Create / update / add / change-status operations spend money and are deliberately not implemented
 * (§25.1). Newegg.com and Newegg.ca; Business fails before sending (ADR 0002).
 */
export class AdsApiImpl implements AdsApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  listCampaigns(
    input: ListAdsCampaignsInput = {},
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsCampaign>> {
    return this.#page(
      Operation.AdsCampaigns,
      ADS_CAMPAIGN_SEARCH_PATH,
      (sellerId) => buildCampaignListRequest(sellerId, input),
      parseCampaign,
      options,
    );
  }

  listGroups(input: ListAdsGroupsInput, options: RequestOptions = {}): Promise<AdsPage<AdsGroup>> {
    return this.#page(
      Operation.AdsGroups,
      ADS_GROUP_SEARCH_PATH,
      (sellerId) => buildGroupListRequest(sellerId, input),
      parseGroup,
      options,
    );
  }

  listProducts(
    input: ListAdsProductsInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsProduct>> {
    return this.#page(
      Operation.AdsProducts,
      ADS_PRODUCT_SEARCH_PATH,
      (sellerId) => buildProductListRequest(sellerId, input),
      parseProduct,
      options,
    );
  }

  listKeywords(
    input: ListAdsKeywordsInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsKeyword>> {
    return this.#page(
      Operation.AdsKeywords,
      ADS_KEYWORD_SEARCH_PATH,
      (sellerId) => buildKeywordListRequest(sellerId, input),
      parseKeyword,
      options,
    );
  }

  listNegativeKeywords(
    input: ListAdsNegativeKeywordsInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsNegativeKeyword>> {
    return this.#page(
      Operation.AdsNegativeKeywords,
      ADS_NEGATIVE_KEYWORD_SEARCH_PATH,
      (sellerId) => buildNegativeKeywordListRequest(sellerId, input),
      parseNegativeKeyword,
      options,
    );
  }

  listMatchTypes(
    input: ListAdsMatchTypesInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsMatchType>> {
    return this.#page(
      Operation.AdsMatchTypes,
      ADS_MATCH_TYPE_SEARCH_PATH,
      (sellerId) => buildMatchTypeRequest(sellerId, input),
      parseMatchType,
      options,
    );
  }

  async suggestKeywords(
    input: SuggestAdsKeywordsInput,
    options: RequestOptions = {},
  ): Promise<AdsKeywordSuggestionsResult> {
    const sent = await this.#send(
      Operation.AdsKeywordSuggest,
      ADS_KEYWORD_SUGGEST_PATH,
      (sellerId) => buildKeywordSuggestRequest(sellerId, input),
      options,
    );
    const envelope = unwrapAds(sent.result.json, sent.correlationId);
    return {
      ...this.#toPage(sent, envelope, parseKeywordSuggestion, options),
      ...parseSuggestionExtras(envelope.body),
    };
  }

  suggestCategoryTargeting(
    input: SuggestAdsCategoryTargetingInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsCategoryTargeting>> {
    return this.#page(
      Operation.AdsTargetingCategories,
      ADS_TARGETING_CATEGORIES_PATH,
      () => buildCategoryTargetingRequest(input),
      parseCategoryTargeting,
      options,
    );
  }

  suggestItemTargeting(
    input: SuggestAdsItemTargetingInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsItemTargeting>> {
    return this.#page(
      Operation.AdsTargetingItems,
      ADS_TARGETING_INDIVIDUAL_PATH,
      () => buildItemTargetingRequest(input),
      parseItemTargeting,
      options,
    );
  }

  getGroupPerformance(
    input: GetAdsGroupPerformanceInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsGroupPerformance>> {
    return this.#page(
      Operation.AdsGroupPerformance,
      ADS_GROUP_PERFORMANCE_PATH,
      (sellerId) => buildGroupPerformanceRequest(sellerId, input),
      parseGroupPerformance,
      options,
    );
  }

  getProductPerformance(
    input: GetAdsProductPerformanceInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsProductPerformance>> {
    return this.#page(
      Operation.AdsProductPerformance,
      ADS_PRODUCT_PERFORMANCE_PATH,
      (sellerId) => buildProductPerformanceRequest(sellerId, input),
      parseProductPerformance,
      options,
    );
  }

  getKeywordPerformance(
    input: GetAdsKeywordPerformanceInput,
    options: RequestOptions = {},
  ): Promise<AdsPage<AdsKeywordPerformance>> {
    return this.#page(
      Operation.AdsKeywordPerformance,
      ADS_KEYWORD_PERFORMANCE_PATH,
      (sellerId) => buildKeywordPerformanceRequest(sellerId, input),
      parseKeywordPerformance,
      options,
    );
  }

  async #page<T>(
    operation: string,
    path: string,
    build: (sellerId: string) => BuiltAdsRequest,
    parseRow: (row: unknown) => T | undefined,
    options: RequestOptions,
  ): Promise<AdsPage<T>> {
    const sent = await this.#send(operation, path, build, options);
    return this.#toPage(sent, unwrapAds(sent.result.json, sent.correlationId), parseRow, options);
  }

  #toPage<T>(
    sent: Sent,
    envelope: ReturnType<typeof unwrapAds>,
    parseRow: (row: unknown) => T | undefined,
    options: RequestOptions,
  ): AdsPage<T> {
    return {
      marketplace: this.#http.config.marketplace,
      rows: envelope.rows.map(parseRow).filter((row): row is T => row !== undefined),
      totalRows: envelope.totalRows,
      page: sent.built.page,
      pageSize: sent.built.pageSize,
      message: envelope.message,
      bizCode: envelope.bizCode,
      correlationId: sent.correlationId,
      rateLimit: sent.result.rateLimit,
      raw: options.includeRaw ? sanitizeRaw(sent.result.json) : undefined,
    };
  }

  async #send(
    operation: string,
    path: string,
    build: (sellerId: string) => BuiltAdsRequest,
    options: RequestOptions,
  ): Promise<Sent> {
    const { marketplace, sellerId } = this.#http.config;
    assertAdsSupported(getAdsPlatform(marketplace));
    const built = build(sellerId);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#http.request(
      { method: "POST", path: `${this.#http.adapter.prefix}${path}`, body: built.body },
      {
        operation,
        correlationId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        rateLimitKey: rateLimitKey(marketplace, sellerId, operation),
      },
    );
    return { built, correlationId, result };
  }
}

interface Sent {
  built: BuiltAdsRequest;
  correlationId: string;
  result: HttpResult;
}
