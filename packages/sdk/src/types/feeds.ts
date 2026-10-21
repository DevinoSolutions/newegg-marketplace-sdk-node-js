/** Data feed types. Re-exported from `../types.ts`. */

import type { InventoryUpdate, NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// feeds
// ----------------------------------------------------------------------------
export type FeedRequestStatus = "SUBMITTED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED" | "UNKNOWN";

export interface SubmitInventoryFeedInput {
  items: InventoryUpdate[];
}
export interface FeedJob {
  requestId: string;
  /** INVENTORY_DATA | INVENTORY_AND_PRICE_DATA */
  requestType: string;
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
  /** Detailed records (Newegg details failures/warnings). */
  records: FeedResultRecord[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface WaitForResultOptions extends RequestOptions {
  /** Default 5_000. */
  pollingIntervalMs?: number;
  /** Default 60_000 (bounded exponential). */
  maxPollingIntervalMs?: number;
  /** Default 900_000; polling never runs unbounded. */
  timeoutMs?: number;
}
export type FeedWaitOutcome =
  | { outcome: "finished"; result: FeedResult }
  | { outcome: "cancelled"; requestId: string; status: "CANCELLED" }
  | { outcome: "timeout"; requestId: string; lastStatus: FeedRequestStatus; elapsedMs: number };

export interface FeedsApi {
  submitInventoryFeed(
    input: SubmitInventoryFeedInput,
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
  getStatus(requestId: string, options?: RequestOptions): Promise<FeedStatusReport>;
  getResult(requestId: string, options?: RequestOptions): Promise<FeedResult>;
  waitForResult(requestId: string, options?: WaitForResultOptions): Promise<FeedWaitOutcome>;
}
