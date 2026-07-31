/**
 * Constants for the **UNOFFICIAL** public Newegg storefront endpoints (contracts §14).
 *
 * These are the same unauthenticated JSON endpoints the retail product page calls. They are
 * NOT part of the Newegg seller API: no SLA, no versioning, no documentation, and they may
 * change or disappear without notice. Read-only — nothing here mutates a seller account.
 */
import type { NeweggMarketplace } from "../types.js";

/** Public storefront origins by marketplace. `b2b` has no public storefront. */
export const STOREFRONT_BASE_URLS: Readonly<Partial<Record<NeweggMarketplace, string>>> = {
  ca: "https://www.newegg.ca",
  us: "https://www.newegg.com",
};

/** Buy-box / "More Buying Options" endpoint path (returns JSON as `text/plain`). */
export const MORE_BUYING_OPTIONS_PATH = "/product/api/MoreBuyingOptions";

/** Product-page path used to resolve a seller offer number to its parent catalog number. */
export const PRODUCT_PAGE_PATH = "/p";

/**
 * Query parameters sent with every MoreBuyingOptions request (the values the retail page
 * uses on first load). `ParentItem` is added per call.
 */
export const MORE_BUYING_OPTIONS_DEFAULT_QUERY: Readonly<Record<string, string>> = {
  TabType: "0",
  SortBy: "0",
  FilterBy: "",
  FirstCall: "true",
  PageNum: "1",
  PageSize: "10",
};

/**
 * Browser-like User-Agent. The storefront CDN blocks obviously scripted clients, so this is a
 * fixed, realistic desktop UA rather than the SDK's own `userAgent` config value.
 */
export const STOREFRONT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

/**
 * Builds the request headers the storefront expects. Omitting these (particularly the
 * User-Agent and Referer) can get the request blocked by the CDN.
 */
export function storefrontHeaders(baseUrl: string): Record<string, string> {
  return {
    "User-Agent": STOREFRONT_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${baseUrl}/`,
  };
}
