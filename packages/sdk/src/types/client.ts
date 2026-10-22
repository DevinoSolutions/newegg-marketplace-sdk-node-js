/** Client configuration and the top-level `NeweggClient` surface. Re-exported from `../types.ts`. */

import type { AdsApi } from "./ads.js";
import type { CatalogApi } from "./catalog.js";
import type { NeweggMarketplace, NeweggServiceDomain, RequestOptions } from "./common.js";
import type { FeedsApi } from "./feeds.js";
import type { InventoryApi } from "./inventory.js";
import type { ListingsApi } from "./listings.js";
import type { OrdersApi } from "./orders.js";
import type { PricingApi } from "./pricing.js";
import type { ReferenceApi } from "./reference.js";
import type { ReportFileDownloader, ReportFileFtpOptions, ReportsApi } from "./reports.js";
import type { RefundsApi, RmaApi } from "./rma.js";
import type { NeweggLogger, OperationStore, RateLimitStore, RetryOptions } from "./runtime.js";
import type { SbnApi } from "./sbn.js";
import type { ServiceApi } from "./service.js";
import type { ShippingLabelsApi } from "./shipping-labels.js";
import type { StorefrontApi } from "./storefront.js";
import type { VolumeDiscountsApi } from "./volume-discounts.js";

// ----------------------------------------------------------------------------
// client configuration
// ----------------------------------------------------------------------------
export interface NeweggClientConfig {
  sellerId: string;
  apiKey: string;
  secretKey: string;
  marketplace: NeweggMarketplace;
  /**
   * The marketplace the key pair was issued under (the Seller Portal API Settings of that
   * marketplace's seller account). Strongly recommended: Newegg authenticates on `sellerId` +
   * `apiKey` + `secretKey` only and never checks the URL prefix, so a key from one seller
   * account used with another marketplace silently reads and writes THAT key's own account
   * (`contracts §2`). When set and different from {@link NeweggClientConfig.marketplace},
   * `createNeweggClient` throws {@link NeweggMarketplaceMismatchError} before any request is
   * made. When absent the check is skipped and behaviour is unchanged (unsafe if the key and
   * marketplace can disagree); the MCP server always sets it.
   */
  credentialMarketplace?: NeweggMarketplace;
  /** Trusted-config-only override (tests, proxies). Never exposed via MCP. Must end in `/`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default `30_000`. */
  timeoutMs?: number;
  /** Default `newegg-marketplace-sdk/<version> node/<version>`. */
  userAgent?: string;
  retry?: RetryOptions;
  logger?: NeweggLogger;
  fetch?: typeof globalThis.fetch;
  rateLimitStore?: RateLimitStore;
  operationStore?: OperationStore;
  strategy?: {
    /**
     * `updateMany` "auto" switches to feeds at more than this many post-dedup items.
     * Default 8. SDK policy, not a Newegg rule.
     */
    autoFeedThreshold?: number;
  };
  /** Optional app-level quantity ceiling; the SDK never clamps silently — a violation throws {@link NeweggValidationError}. */
  maxQuantity?: number;
  /**
   * Replaces the built-in FTP downloader used by the file-style reports
   * (`client.reports.dailyInventory` / `dailyPrice`; contracts §17.5). Newegg answers those
   * reports with an `ftp://user:password@host/file` URL; the default downloader only connects to
   * `*.newegg.com`. A custom downloader receives that URL, which embeds credentials: treat it as
   * a secret and never log it. Mainly for tests and for environments that must proxy FTP.
   */
  reportFileDownloader?: ReportFileDownloader;
  /**
   * Transport settings of the built-in FTP downloader. It speaks explicit FTPS by default and
   * refuses a server that does not; set `allowPlaintext: true` only for an FTP endpoint that
   * cannot do TLS. Ignored when {@link NeweggClientConfig.reportFileDownloader} is set.
   */
  reportFileFtp?: ReportFileFtpOptions;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  /**
   * Item pricing: Get Item Price reads (contracts §15) and, WRITE, gated selling-price updates
   * (`update`, §16). `previewUpdate` and the reads never mutate.
   */
  readonly pricing: PricingApi;
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  /** Read-only order lookups (list / get / status). Never mutates. */
  readonly orders: OrdersApi;
  /** Read-only RMA lookups (Get RMA Information; contracts §18). Never mutates. */
  readonly rma: RmaApi;
  /**
   * Read-only courtesy refund lookups (information and request status; contracts §18). Never
   * mutates; issuing a courtesy refund is intentionally not implemented.
   */
  readonly refunds: RefundsApi;
  /**
   * Read-only seller / category reference lookups (seller status, industries, subcategory
   * status and properties; contracts §19). Never mutates.
   */
  readonly reference: ReferenceApi;
  /**
   * Read-only Shipped-by-Newegg inbound-shipment lookups (shipment list, request status and
   * result, warehouse list; contracts §21). Newegg.com and Newegg Business only. Never mutates.
   */
  readonly sbn: SbnApi;
  /**
   * Newegg Shipping Label Service (contracts §23). WRITE: `create` BUYS a UPS label, bills the
   * seller's account and ships the order; `reprint` is treated as billable. `estimate` is the
   * only read; the `preview*` twins only read the order. Nothing here was verified live.
   */
  readonly shippingLabels: ShippingLabelsApi;
  /**
   * Read-only Sponsored Ads lookups and performance reports (campaigns, ad groups, products,
   * keywords, negative keywords, targeting suggestions; contracts §25). Newegg.com and Newegg.ca. Never
   * mutates; creating or changing ads (which spends money) is intentionally not implemented.
   */
  readonly ads: AdsApi;
  /** Read-only catalog resolution via the Item Lookup Report (contracts §12). Never mutates. */
  readonly catalog: CatalogApi;
  /**
   * Read-only async reports (Settlement Summary, Settlement Transaction, Daily Inventory,
   * Daily Price; contracts §17). Report submission creates a report job and mutates nothing.
   */
  readonly reports: ReportsApi;
  /**
   * Existing-item listing creation (contracts §13). WRITE: `create` submits an
   * `ITEM_DATA&v2` data feed that adds seller offers to the account. `previewCreate` is offline.
   */
  readonly listings: ListingsApi;
  /**
   * Volume discounts (contracts §22). Reads are Get Volume Discount; WRITE: `update` submits a
   * `VOLUME_DISCOUNT_DATA` data feed. `previewUpdate` is offline.
   */
  readonly volumeDiscounts: VolumeDiscountsApi;
  /**
   * UNOFFICIAL, read-only reader for the PUBLIC storefront's buy box and competing seller
   * offers (contracts §14). Not part of the seller API — unauthenticated, no SLA, may change
   * without notice. `us`/`ca` only; `b2b` throws {@link UnsupportedMarketplaceOperationError}.
   */
  readonly storefront: StorefrontApi;
  /**
   * Read-only, fail-fast credential preflight. Issues a single service-status GET and
   * throws immediately when the credentials are wrong or unauthorized
   * ({@link NeweggAuthenticationError} on 401, {@link NeweggAuthorizationError} on 403).
   * Resolves on success, so callers verify once at startup and then treat every later call
   * as authenticated. Never mutates anything.
   */
  verifyCredentials(options?: RequestOptions): Promise<CredentialCheck>;
}

/** Result of a successful {@link NeweggClient.verifyCredentials} preflight. */
export interface CredentialCheck {
  readonly ok: true;
  readonly marketplace: NeweggMarketplace;
  /** The service domain that was probed (always `"contentmgmt"`). */
  readonly domain: NeweggServiceDomain;
  /** Whether that domain reported itself available (informational only). */
  readonly serviceAvailable: boolean;
  readonly timestamp?: { raw: string; iso?: string };
  readonly correlationId: string;
}
