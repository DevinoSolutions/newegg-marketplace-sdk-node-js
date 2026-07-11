# SDK Public API Contract (binding for implementation)

This file is the binding contract between `@devino/newegg-marketplace-sdk` (implements it
exactly) and `@devino/newegg-marketplace-mcp` (consumes only this surface). Wire shapes
live in `newegg-api-contracts.md`. All declarations below are exported from the SDK root
entry point unless noted.

```ts
// ----------------------------------------------------------------------------
// factory
// ----------------------------------------------------------------------------
export function createNeweggClient(config: NeweggClientConfig): NeweggClient;

export type NeweggMarketplace = "us" | "b2b" | "ca";
export type NeweggServiceDomain =
  | "contentmgmt" | "ordermgmt" | "datafeedmgmt" | "servicemgmt"
  | "reportmgmt" | "sellermgmt" | "sbnmgmt" | "shippingservice";

export interface NeweggClientConfig {
  sellerId: string;
  apiKey: string;
  secretKey: string;
  marketplace: NeweggMarketplace;
  /** Trusted-config-only override (tests, proxies). Never exposed via MCP. */
  baseUrl?: string;
  timeoutMs?: number;           // default 30_000
  userAgent?: string;           // default "newegg-marketplace-sdk/<version> node/<version>"
  retry?: RetryOptions;
  logger?: NeweggLogger;
  fetch?: typeof globalThis.fetch;
  rateLimitStore?: RateLimitStore;
  operationStore?: OperationStore;
  strategy?: {
    /** updateMany "auto" switches to feeds at > this many post-dedup items. Default 8. SDK policy, not a Newegg rule. */
    autoFeedThreshold?: number;
  };
  /** Optional app-level quantity ceiling; SDK never clamps silently — violation => NeweggValidationError. */
  maxQuantity?: number;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  // Read-only, fail-fast credential preflight (single service-status GET). Throws
  // NeweggAuthenticationError (401) / NeweggAuthorizationError (403) immediately on
  // bad or unauthorized credentials; resolves on success. Never mutates.
  verifyCredentials(options?: RequestOptions): Promise<CredentialCheck>;
}

export interface CredentialCheck {
  readonly ok: true;
  readonly marketplace: NeweggMarketplace;
  readonly domain: NeweggServiceDomain; // always "contentmgmt"
  readonly serviceAvailable: boolean;
  readonly timestamp?: { raw: string; iso?: string };
  readonly correlationId: string;
}

// ----------------------------------------------------------------------------
// shared request options
// ----------------------------------------------------------------------------
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  correlationId?: string;   // auto-generated UUID when omitted
  includeRaw?: boolean;     // attach sanitized raw response payload to results (never via MCP)
}

// ----------------------------------------------------------------------------
// identifiers & updates (normalized domain types)
// ----------------------------------------------------------------------------
export type ItemCondition =
  | "new" | "refurbished" | "usedLikeNew" | "usedVeryGood" | "usedGood" | "usedAcceptable";

export type ItemIdentifier =
  | { type: "sellerPartNumber"; value: string }
  | { type: "neweggItemNumber"; value: string }
  | { type: "upc"; value: string; condition?: ItemCondition };

export interface InventoryUpdate {
  identifier: ItemIdentifier;
  quantity: number;                    // non-negative safe integer; 0 is valid and meaningful
  warehouseLocation?: string;          // ISO 3166-1 alpha-3, uppercase; required for US ops
  fulfillmentOption?: "Seller";
  metadata?: Record<string, string>;   // caller bookkeeping, never sent to Newegg
}

// ----------------------------------------------------------------------------
// inventory reads
// ----------------------------------------------------------------------------
export interface GetItemInput { identifier: ItemIdentifier; warehouses?: string[] /* US only */ }
export interface GetManyInput { identifiers: ItemIdentifier[]; warehouses?: string[] /* US only */ }

export interface WarehouseInventory {
  /** ISO alpha-3 country (US) or Newegg warehouse/SBS code (B2B/CAN breakdown). */
  location: string;
  quantity: number;
  fulfillment: "seller" | "newegg";
}
export interface InventoryItemSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  condition?: ItemCondition;
  active?: boolean;                 // B2B/CAN only
  totalAvailableQuantity: number;
  warehouses: WarehouseInventory[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;                    // only when includeRaw
}
export interface InventoryBatchSnapshot {
  marketplace: NeweggMarketplace;
  items: InventoryItemSnapshot[];
  missingIdentifiers: ItemIdentifier[];  // requested but not returned by Newegg
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// inventory writes
// ----------------------------------------------------------------------------
export type InventoryUpdateStrategy = "direct" | "feed" | "auto";

export interface UpdateOptions extends RequestOptions {}
export interface UpdateManyOptions extends RequestOptions {
  strategy?: InventoryUpdateStrategy;   // default "auto"
  waitForFeedCompletion?: boolean;      // default false
  wait?: WaitForResultOptions;          // polling knobs when waiting
  concurrency?: number;                 // direct-update concurrency, default 4
}
export interface PreviewOptions extends RequestOptions {
  strategy?: InventoryUpdateStrategy;
  includeCurrentInventory?: boolean;    // performs reads; still zero writes
}

export interface NormalizedInventoryUpdate extends InventoryUpdate {
  inputIndex: number;                   // index in the caller's original array
}
export interface InventoryUpdatePreview {
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  normalizedUpdates: NormalizedInventoryUpdate[];  // post-validation, post-dedup (last-write-wins)
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  plannedFeedCount: number;             // 0 when direct
  zeroQuantityCount: number;
  warnings: string[];
  currentInventory?: InventoryItemSnapshot[];      // when includeCurrentInventory
  correlationId: string;
}

export type ItemOutcomeStatus =
  | "planned" | "submitted" | "succeeded" | "warning" | "failed" | "unknown";
export interface ItemOutcome {
  inputIndex: number;
  sellerPartNumber?: string;
  warehouseLocation?: string;
  quantity: number;
  status: ItemOutcomeStatus;
  errorCode?: string;
  message?: string;
}
export interface FeedJobSummary {
  requestId: string;
  status: FeedRequestStatus;
  itemCount: number;
}
export interface InventoryUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  submittedItemCount: number;
  acceptedItemCount: number;
  failedItemCount: number;
  deduplicatedItemCount: number;
  feedJobs?: FeedJobSummary[];
  items: ItemOutcome[];
  warnings: string[];
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface InventoryApi {
  getItem(input: GetItemInput, options?: RequestOptions): Promise<InventoryItemSnapshot>;
  getMany(input: GetManyInput, options?: RequestOptions): Promise<InventoryBatchSnapshot>;
  previewUpdate(updates: InventoryUpdate | InventoryUpdate[], options?: PreviewOptions): Promise<InventoryUpdatePreview>;
  updateItem(update: InventoryUpdate, options?: UpdateOptions): Promise<InventoryUpdateResult>;
  updateMany(updates: InventoryUpdate[], options?: UpdateManyOptions): Promise<InventoryUpdateResult>;
}

// ----------------------------------------------------------------------------
// feeds
// ----------------------------------------------------------------------------
export type FeedRequestStatus = "SUBMITTED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED" | "UNKNOWN";

export interface SubmitInventoryFeedInput {
  items: InventoryUpdate[];
}
export interface FeedJob {
  requestId: string;
  requestType: string;               // INVENTORY_DATA | INVENTORY_AND_PRICE_DATA
  marketplace: NeweggMarketplace;
  status: FeedRequestStatus;
  itemCount: number;
  chunkIndex: number;
  submittedAt?: { raw: string; iso?: string };
  correlationId: string;
}
export interface FeedSubmission {
  feeds: FeedJob[];
  deduplicatedItemCount: number;
  /** Maps every accepted input item to its feed. */
  itemAssignments: Array<{ inputIndex: number; requestId: string; chunkIndex: number }>;
  warnings: string[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
}

export interface FeedStatusReport {
  requestId: string;
  status: FeedRequestStatus;
  requestType?: string;
  submittedAt?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export type FeedRecordStatus = "succeeded" | "warning" | "failed" | "unknown";
export interface FeedResultRecord {
  sellerPartNumber?: string;
  additionalInfo: Record<string, string>;
  status: FeedRecordStatus;
  messages: string[];
}
export interface FeedResult {
  requestId: string;
  status: Extract<FeedRequestStatus, "FINISHED">;
  summary: { processed: number; succeeded: number; failed: number };
  records: FeedResultRecord[];      // detailed records (Newegg details failures/warnings)
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface WaitForResultOptions extends RequestOptions {
  pollingIntervalMs?: number;       // default 5_000
  maxPollingIntervalMs?: number;    // default 60_000 (bounded exponential)
  timeoutMs?: number;               // default 900_000; polling never runs unbounded
}
export type FeedWaitOutcome =
  | { outcome: "finished"; result: FeedResult }
  | { outcome: "cancelled"; requestId: string; status: "CANCELLED" }
  | { outcome: "timeout"; requestId: string; lastStatus: FeedRequestStatus; elapsedMs: number };

export interface FeedsApi {
  submitInventoryFeed(input: SubmitInventoryFeedInput, options?: RequestOptions): Promise<FeedSubmission>;
  getStatus(requestId: string, options?: RequestOptions): Promise<FeedStatusReport>;
  getResult(requestId: string, options?: RequestOptions): Promise<FeedResult>;
  waitForResult(requestId: string, options?: WaitForResultOptions): Promise<FeedWaitOutcome>;
}

// ----------------------------------------------------------------------------
// service
// ----------------------------------------------------------------------------
export interface ServiceStatus {
  marketplace: NeweggMarketplace;
  domain: NeweggServiceDomain;
  available: boolean;
  timestamp?: { raw: string; iso?: string };
  message?: string;
  correlationId: string;
  raw?: unknown;
}
export interface ServiceApi {
  getStatus(domain?: NeweggServiceDomain, options?: RequestOptions): Promise<ServiceStatus>; // default "contentmgmt"
}

// ----------------------------------------------------------------------------
// rate limiting
// ----------------------------------------------------------------------------
export interface RateLimitInfo {
  requestLimit?: number;
  requestRemaining?: number;
  requestResetAt?: Date;
  recordLimit?: number;
  recordRemaining?: number;
  recordResetAt?: Date;
}
/** Keyed by `${marketplace}:${sellerId}:${operation}`. */
export interface RateLimitStore {
  /** Resolves when the caller may proceed; enforces local budgets (e.g. 10 feeds/min, 100k records/hour). */
  acquire(key: string, req: { recordCost?: number; signal?: AbortSignal }): Promise<void>;
  /** Feed observed server-side headers back into the limiter. */
  observe(key: string, info: RateLimitInfo): void;
  /** Local budget configuration (set once per operation kind by the SDK). */
  configure(key: string, budget: { maxPerMinute?: number; maxRecordsPerHour?: number }): void;
}
export class InMemoryRateLimitStore implements RateLimitStore { /* provided */ }

// ----------------------------------------------------------------------------
// retry / idempotency
// ----------------------------------------------------------------------------
export interface RetryOptions {
  maxAttempts?: number;   // default 3 (initial + 2 retries)
  baseDelayMs?: number;   // default 250, full-jitter exponential
  maxDelayMs?: number;    // default 10_000
}
export interface StoredOperation {
  state: "submitting" | "submitted" | "failed";
  payloadHash: string;
  requestIds?: string[];
  updatedAt: string; // ISO
}
export interface OperationStore {
  get(key: string): Promise<StoredOperation | undefined>;
  put(key: string, op: StoredOperation): Promise<void>;
}
export class InMemoryOperationStore implements OperationStore { /* provided */ }

// ----------------------------------------------------------------------------
// logging
// ----------------------------------------------------------------------------
export interface NeweggLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
/** Structured events: request_started, request_completed, retry_scheduled, rate_limit_wait,
 * feed_submitted, feed_status_changed, feed_processing_completed, partial_failure,
 * indeterminate_submission. Fields always include correlationId, operation, marketplace,
 * sellerIdHash (sha256 prefix, never the raw seller ID), durationMs where relevant.
 * Authorization/SecretKey/api key/secret values are never logged. */

// ----------------------------------------------------------------------------
// errors (all extend NeweggError; every one carries the fields below)
// ----------------------------------------------------------------------------
export type NeweggErrorCode =
  | "configuration" | "validation" | "authentication" | "authorization"
  | "rate_limit" | "api" | "feed_submission" | "feed_submission_indeterminate"
  | "feed_processing" | "feed_cancelled" | "timeout" | "unsupported_operation";

export class NeweggError extends Error {
  readonly code: NeweggErrorCode;
  readonly httpStatus?: number;
  readonly neweggErrorCode?: string;   // e.g. CT002, DF012, InvalidToken
  readonly neweggRequestId?: string;   // feed request id when relevant
  readonly correlationId?: string;
  readonly retryable: boolean;
  readonly details?: unknown;          // sanitized, JSON-safe
}
export class NeweggConfigurationError extends NeweggError {}
export class NeweggValidationError extends NeweggError { readonly issues: Array<{ path: string; message: string; inputIndex?: number }>; }
export class NeweggAuthenticationError extends NeweggError {}
export class NeweggAuthorizationError extends NeweggError {}
export class NeweggRateLimitError extends NeweggError { readonly rateLimit?: RateLimitInfo; readonly retryAfterMs?: number; }
export class NeweggApiError extends NeweggError {}
export class NeweggFeedSubmissionError extends NeweggError {}
export class IndeterminateFeedSubmissionError extends NeweggError {
  readonly payloadHash: string;
  readonly marketplace: NeweggMarketplace;
  readonly submittedAtIso: string;
  readonly guidance: string; // "check recent feed status before resubmitting…"
}
export class NeweggFeedProcessingError extends NeweggError {}
export class NeweggFeedCancelledError extends NeweggError {}
export class NeweggTimeoutError extends NeweggError {}
export class UnsupportedMarketplaceOperationError extends NeweggError {}

// ----------------------------------------------------------------------------
// testing utilities (exported from "@devino/newegg-marketplace-sdk/testing")
// ----------------------------------------------------------------------------
export function createMockFetch(routes: MockRoute[]): { fetch: typeof globalThis.fetch; calls: RecordedCall[] };
export interface MockRoute {
  method: string;
  pathPattern: RegExp | string;
  reply: (req: RecordedCall) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<...>;
}
export interface RecordedCall { method: string; url: URL; headers: Headers; bodyText?: string; bodyJson?: unknown }
```

## Behavioural requirements bound to this surface

1. **Validation**: all public inputs validated with Zod v4 `.strict()` schemas — unknown
   keys rejected; quantity: non-negative safe integer (0 valid); US ops require
   `warehouseLocation` matching `/^[A-Z]{3}$/`; seller part number: non-empty, ≤ 40 chars;
   `upc.condition` serialized only for UPC identifiers.
2. **Strategy "auto"**: post-dedup count ≤ `autoFeedThreshold` (default 8) → direct;
   otherwise feed. Feed requires `sellerPartNumber` identifiers: with strategy `auto`,
   items lacking one fall back to direct; with explicit `feed`, throw
   `NeweggValidationError` listing offending `inputIndex`es. Nothing is silently dropped.
3. **Dedup**: last-write-wins on `(marketplace, identifier type+value, warehouseLocation ?? "")`,
   reported via `deduplicated` / `deduplicatedItemCount`.
4. **Feed lifecycle**: submission acceptance ≠ item success. `waitForResult` uses bounded
   exponential polling, honors `signal`, returns (not throws) `timeout` outcome.
5. **Retry**: direct reads/writes retry on network errors, 408, 429, 502/503/504 with
   full-jitter backoff honoring `X-RateLimit-ResetTime`/`retryAfterMs`. Feed submission
   NEVER auto-retries after the body may have reached Newegg — throw
   `IndeterminateFeedSubmissionError`; retry only on pre-send failures (DNS/connect refused)
   or definitive rejection (4xx).
6. **Rate limiting**: feed submissions locally budgeted at 10/min + 100,000 records/hour per
   `${marketplace}:${sellerId}`; 429/DF012 surface as `NeweggRateLimitError` with reset info.
7. **Secrets**: `Authorization`/`SecretKey` header values, apiKey, secretKey never appear in
   errors, logs, `raw` payloads, or serialized output. `raw` is sanitized (headers stripped).
8. **No network / credentials at import time.** Config validated in `createNeweggClient`
   (throws `NeweggConfigurationError`).
9. **ESM**, Node ≥ 22, relative imports carry `.js` extensions, no `any` in src.

```

```
