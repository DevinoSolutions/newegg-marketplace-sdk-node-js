/**
 * Wire constants of the Sponsored Ads reads (contracts §25). Paths are relative to the platform
 * prefix (`""` on Newegg.com, the only marketplace that offers ads). Every operation is a `POST`
 * with a JSON body; the read endpoints end in `search`, `getsuggest`, `performance`,
 * `individualsearch`, `categoriessearch` or `matchtypesearch`. The write endpoints (`create`,
 * `update`, `add`, `changestatus`, `matchtypeupdate`, `matchtypechangestatus`) are deliberately
 * absent from the SDK.
 */
const BASE = "sponsoredmgmt/campaign";

/** Campaign List (and Campaign Performance Report, which documents the same URL). */
export const ADS_CAMPAIGN_SEARCH_PATH = `${BASE}/search`;
/** Group List. */
export const ADS_GROUP_SEARCH_PATH = `${BASE}/group/search`;
/** Product List. */
export const ADS_PRODUCT_SEARCH_PATH = `${BASE}/product/search`;
/** Keywords List. */
export const ADS_KEYWORD_SEARCH_PATH = `${BASE}/keyword/search`;
/** Keywords Suggest. */
export const ADS_KEYWORD_SUGGEST_PATH = `${BASE}/keyword/getsuggest`;
/** Negative Keyword List. */
export const ADS_NEGATIVE_KEYWORD_SEARCH_PATH = `${BASE}/negativekeyword/search`;
/** Auto Targeting Match Type List. */
export const ADS_MATCH_TYPE_SEARCH_PATH = `${BASE}/autotargeting/matchtypesearch`;
/** Product Targeting Categories. */
export const ADS_TARGETING_CATEGORIES_PATH = `${BASE}/producttargeting/categoriessearch`;
/** Product Targeting Individual. */
export const ADS_TARGETING_INDIVIDUAL_PATH = `${BASE}/producttargeting/individualsearch`;
/** Group Performance Report. */
export const ADS_GROUP_PERFORMANCE_PATH = `${BASE}/group/performance`;
/** Product Performance Report. */
export const ADS_PRODUCT_PERFORMANCE_PATH = `${BASE}/product/performance`;
/** Keywords Performance Report. */
export const ADS_KEYWORD_PERFORMANCE_PATH = `${BASE}/keyword/performance`;

/** Fixed `extUrl` of each synchronous performance report (the pages call it "Performance exact link"). */
export const ADS_GROUP_PERFORMANCE_EXT_URL = "group/searchGroupByCampaign";
export const ADS_PRODUCT_PERFORMANCE_EXT_URL = "product/searchItems";
export const ADS_KEYWORD_PERFORMANCE_EXT_URL = "keyword/searchKeywordList";

/** Documented "Max 100 per page" for the campaign, group and product lists. */
export const ADS_PAGE_SIZE_DEFAULT = 100;
/** Documented ceiling of the keyword and product performance lists ("Max is 9999999 per page"). */
export const ADS_PAGE_SIZE_MAX = 9_999_999;
/** Documented ceiling of the campaign / group lists. */
export const ADS_LIST_PAGE_SIZE_MAX = 100;
/** Highest `page` the SDK will send; the pages document no ceiling, so this is a sanity bound. */
export const ADS_PAGE_MAX = 10_000;
