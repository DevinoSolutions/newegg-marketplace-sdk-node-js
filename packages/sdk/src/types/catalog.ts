/** Catalog item lookup / resolution types (contracts §12). Re-exported from `../types.ts`. */

import type { ItemCondition, NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// catalog (item lookup / resolution; contracts §12)
// ----------------------------------------------------------------------------
/** One product to resolve against Newegg's catalog. Exactly one identifier family per entry. */
export type CatalogLookupInput =
  /** Already a Newegg item number — echoed back as resolved without any API call. */
  | { neweggItemNumber: string }
  | { upc: string; condition?: ItemCondition; packsOrSets?: number }
  | {
      manufacturer: string;
      manufacturerPartNumber: string;
      condition?: ItemCondition;
      packsOrSets?: number;
    };

/** A catalog item Newegg reported as matching a lookup criterion. */
export interface CatalogMatch {
  neweggItemNumber: string;
  upc?: string;
  condition?: ItemCondition;
  packsOrSets?: number;
  manufacturer?: string;
  manufacturerPartNumber?: string;
  /** Newegg's catalog title — use it to confirm the match is the intended product. */
  websiteShortTitle?: string;
}

/** Resolution outcome for one input: the input echoed back plus its catalog matches. */
export interface CatalogResolution {
  input: CatalogLookupInput;
  found: boolean;
  /** Ranked best-first: rows with a known `condition` precede condition-less pseudo-rows
   * (the lookup report emits refurb echoes like `…R` without a Condition field, and the
   * item-creation feed rejects those numbers). `matches[0]` is the listing-safe pick. */
  matches: CatalogMatch[];
}

export interface ResolveCatalogOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  /** Overall budget for submit + poll + result, ms. Default 120_000. */
  timeoutMs?: number;
  /** First poll delay, ms. Default 2_000. Grows 1.5x per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Poll delay ceiling, ms. Default 15_000. */
  maxPollIntervalMs?: number;
}

export interface ResolveCatalogResult {
  marketplace: NeweggMarketplace;
  /** Report request id, when a lookup report was actually submitted (absent when every input
   * was a `neweggItemNumber` passthrough). */
  requestId?: string;
  resolutions: CatalogResolution[];
  correlationId: string;
  raw?: unknown;
}

export interface CatalogLookupSubmission {
  marketplace: NeweggMarketplace;
  requestId: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Processing state of any reportmgmt report (the status endpoint is report-type independent). */
export type ReportState = "submitted" | "inProgress" | "finished" | "cancelled" | "unknown";

export type CatalogLookupState = ReportState;

export interface CatalogLookupStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: CatalogLookupState;
  /** Newegg's literal status string, for diagnostics when `status` is `"unknown"`. */
  statusRaw?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface CatalogLookupResultPage {
  marketplace: NeweggMarketplace;
  requestId: string;
  matches: CatalogMatch[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Catalog resolution over the async Item Lookup Report (`reportmgmt`, contracts §12).
 * Read-only: report submission creates a report job and mutates nothing on the account.
 */
export interface CatalogApi {
  /**
   * One-call facade: submit → poll → fetch every result page → per-input resolutions.
   * Throws {@link CatalogLookupTimeoutError} (carrying the `requestId`) when the report is
   * not finished within `timeoutMs` — continue with {@link CatalogApi.lookupStatus} /
   * {@link CatalogApi.lookupResult} instead of resubmitting.
   */
  resolve(
    input: CatalogLookupInput | CatalogLookupInput[],
    options?: ResolveCatalogOptions,
  ): Promise<ResolveCatalogResult>;
  /**
   * Submit an Item Lookup Report (max 1000 items). Rejects `neweggItemNumber` inputs
   * (nothing to look up) with {@link NeweggValidationError}.
   */
  submitLookup(
    inputs: CatalogLookupInput[],
    options?: RequestOptions,
  ): Promise<CatalogLookupSubmission>;
  /** Check a submitted lookup's processing state. */
  lookupStatus(requestId: string, options?: RequestOptions): Promise<CatalogLookupStatus>;
  /** Fetch one page (1-based, 100 rows) of a FINISHED lookup's results. */
  lookupResult(
    requestId: string,
    page?: number,
    options?: RequestOptions,
  ): Promise<CatalogLookupResultPage>;
}
