/**
 * Public storefront buy-box / offers reader — **UNOFFICIAL** (contracts §14).
 *
 * These endpoints are the unauthenticated JSON APIs behind the retail product page. They are
 * NOT part of the Newegg seller API: no SLA, no documentation, no versioning, and they may
 * change or vanish without notice. Everything here is read-only and never sends seller
 * credentials — the storefront is public and authenticating against it is neither possible
 * nor required.
 */
import type {
  GetOffersArgs,
  NeweggMarketplace,
  StorefrontApi,
  StorefrontOffersResult,
  StorefrontRequestOptions,
} from "../types.js";
import {
  NeweggApiError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
} from "../errors/index.js";
import {
  MORE_BUYING_OPTIONS_DEFAULT_QUERY,
  MORE_BUYING_OPTIONS_PATH,
  PRODUCT_PAGE_PATH,
  STOREFRONT_BASE_URLS,
  storefrontHeaders,
} from "./constants.js";
import {
  moreBuyingOptionsSchema,
  normalizeOffers,
  normalizeParentItemNumber,
  parentFromRedirectLocation,
  readTotal,
} from "./parse.js";

/** Configuration for {@link createStorefrontApi}. No credentials are involved. */
interface StorefrontApiConfig {
  marketplace: NeweggMarketplace;
  /** Injectable fetch (tests, proxies). Defaults to `globalThis.fetch`. */
  fetchFn?: typeof globalThis.fetch;
  /** Default per-request timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_SNIPPET_MAX = 300;

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > BODY_SNIPPET_MAX ? `${trimmed.slice(0, BODY_SNIPPET_MAX)}…` : trimmed;
}

function isOfferNumberArgs(args: GetOffersArgs): args is { offerNumber: string } {
  return "offerNumber" in args;
}

/**
 * Creates the storefront reader. Construction never throws and never touches the network;
 * unsupported marketplaces fail at call time so building a `b2b` client stays valid.
 */
export function createStorefrontApi(config: StorefrontApiConfig): StorefrontApi {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function requireBaseUrl(): string {
    const baseUrl = STOREFRONT_BASE_URLS[config.marketplace];
    if (baseUrl === undefined) {
      throw new UnsupportedMarketplaceOperationError(
        `The public storefront is not available for marketplace "${config.marketplace}" — ` +
          'storefront offers can only be read for "us" and "ca".',
      );
    }
    return baseUrl;
  }

  function signalFor(options: StorefrontRequestOptions | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? defaultTimeoutMs);
    return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  }

  /**
   * Resolves a seller offer number (`9SI…`) to its parent catalog identifier by reading the
   * 301 `Location` of the public product page. Manual redirect handling — the redirect target
   * IS the answer, so it must not be followed.
   */
  async function resolveParent(
    baseUrl: string,
    offerNumber: string,
    options: StorefrontRequestOptions | undefined,
  ): Promise<string> {
    const url = `${baseUrl}${PRODUCT_PAGE_PATH}/${encodeURIComponent(offerNumber)}`;
    const response = await fetchFn(url, {
      method: "GET",
      headers: storefrontHeaders(baseUrl),
      redirect: "manual",
      signal: signalFor(options),
    });
    const location = response.headers.get("location");
    if (location === null || location.trim() === "") {
      throw new NeweggApiError(
        `Storefront did not redirect offer number "${offerNumber}" to a product page ` +
          `(HTTP ${response.status}, no Location header) — cannot resolve its parent item number.`,
        { httpStatus: response.status, details: { url, status: response.status } },
      );
    }
    const parent = parentFromRedirectLocation(location, baseUrl);
    if (parent === undefined) {
      throw new NeweggApiError(
        `Storefront redirect for offer number "${offerNumber}" had no parsable parent item ` +
          "number in its Location header.",
        { httpStatus: response.status, details: { url, status: response.status, location } },
      );
    }
    return parent;
  }

  async function fetchOffers(
    baseUrl: string,
    parentItemNumber: string,
    options: StorefrontRequestOptions | undefined,
  ): Promise<StorefrontOffersResult> {
    const url = new URL(MORE_BUYING_OPTIONS_PATH, baseUrl);
    url.searchParams.set("ParentItem", parentItemNumber);
    for (const [key, value] of Object.entries(MORE_BUYING_OPTIONS_DEFAULT_QUERY)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchFn(url, {
      method: "GET",
      headers: storefrontHeaders(baseUrl),
      signal: signalFor(options),
    });
    const bodyText = await response.text();

    if (!response.ok) {
      throw new NeweggApiError(
        `Newegg storefront request failed (HTTP ${response.status}) for parent item ` +
          `"${parentItemNumber}".`,
        {
          httpStatus: response.status,
          retryable: response.status >= 500 || response.status === 429,
          details: { status: response.status, body: snippet(bodyText) },
        },
      );
    }

    // The storefront answers with `content-type: text/plain` but the body IS JSON — parse by
    // shape, never by content type.
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (cause) {
      throw new NeweggApiError(
        `Newegg storefront returned a non-JSON body for parent item "${parentItemNumber}".`,
        {
          httpStatus: response.status,
          details: { status: response.status, body: snippet(bodyText) },
          cause,
        },
      );
    }

    const parsed = moreBuyingOptionsSchema.safeParse(json);
    if (!parsed.success) {
      throw new NeweggApiError(
        `Newegg storefront returned an unexpected payload for parent item "${parentItemNumber}".`,
        {
          httpStatus: response.status,
          details: { status: response.status, body: snippet(bodyText) },
        },
      );
    }

    const offers = normalizeOffers(parsed.data);
    return {
      parentItemNumber,
      offers,
      // ASSUMPTION (contracts §14): the storefront's own ordering is its featured ranking, so
      // the first row is the buy-box winner. Verified only by observation.
      buyBox: offers[0],
      total: readTotal(parsed.data, offers.length),
    };
  }

  return {
    async getOffers(args, options) {
      const baseUrl = requireBaseUrl();
      if (isOfferNumberArgs(args)) {
        const offerNumber = typeof args.offerNumber === "string" ? args.offerNumber.trim() : "";
        if (offerNumber === "") {
          throw new NeweggValidationError("storefront.getOffers input validation failed.", [
            { path: "offerNumber", message: "offerNumber must be a non-empty string" },
          ]);
        }
        const parent = await resolveParent(baseUrl, offerNumber, options);
        return fetchOffers(baseUrl, parent, options);
      }
      const parent = normalizeParentItemNumber(
        typeof args.itemNumber === "string" ? args.itemNumber : "",
      );
      if (parent === undefined) {
        throw new NeweggValidationError("storefront.getOffers input validation failed.", [
          { path: "itemNumber", message: "itemNumber must be a non-empty string" },
        ]);
      }
      return fetchOffers(baseUrl, parent, options);
    },
  };
}
