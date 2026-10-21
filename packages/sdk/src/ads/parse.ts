/**
 * Pure request builders and tolerant response parsers for the Sponsored Ads reads (contracts §25).
 * Free of transport concerns so they can be unit-tested against raw wire fixtures. Unlike the rest
 * of the API, Sponsored Ads speaks camelCase JSON and answers `{ header: [{ msg, bizCode }], rows,
 * totalRows }` instead of the `NeweggAPIResponse` envelope; the readers still tolerate numbers as
 * strings, single rows as objects, empty lists as `""` and the envelope, like every other module.
 *
 * This module is a barrel: request building lives in `./parse-request.ts`, response parsing in
 * `./parse-response.ts`.
 */

export {
  buildCampaignListRequest,
  buildGroupListRequest,
  buildProductListRequest,
  buildKeywordListRequest,
  buildNegativeKeywordListRequest,
  buildMatchTypeRequest,
  buildKeywordSuggestRequest,
  buildCategoryTargetingRequest,
  buildItemTargetingRequest,
  buildGroupPerformanceRequest,
  buildProductPerformanceRequest,
  buildKeywordPerformanceRequest,
  type BuiltAdsRequest,
} from "./parse-request.js";
export {
  unwrapAds,
  parseCampaign,
  parseGroup,
  parseGroupPerformance,
  parseProduct,
  parseProductPerformance,
  parseKeyword,
  parseKeywordPerformance,
  parseNegativeKeyword,
  parseMatchType,
  parseKeywordSuggestion,
  parseSuggestionExtras,
  parseCategoryTargeting,
  parseItemTargeting,
} from "./parse-response.js";
