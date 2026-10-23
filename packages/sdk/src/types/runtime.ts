// Rate limiting, retry / idempotency and logging types. Re-exported from `../types.ts`.

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

// ----------------------------------------------------------------------------
// retry / idempotency
// ----------------------------------------------------------------------------
export interface RetryOptions {
  /** Default 3 (initial + 2 retries). */
  maxAttempts?: number;
  /** Default 250, full-jitter exponential. */
  baseDelayMs?: number;
  /** Default 10_000. */
  maxDelayMs?: number;
}
export interface StoredOperation {
  state: "submitting" | "submitted" | "failed";
  payloadHash: string;
  requestIds?: string[];
  /** ISO timestamp. */
  updatedAt: string;
}
export interface OperationStore {
  get(key: string): Promise<StoredOperation | undefined>;
  put(key: string, op: StoredOperation): Promise<void>;
  /**
   * Optional compare-and-set. Writes `op` and resolves `true` only while the stored record for `key`
   * is still `expected` (`undefined` = no record); resolves `false` without writing when another
   * writer changed it. A store shared by several processes should implement it: the label-create
   * ledger (contracts §23.5) uses it so two processes cannot both claim the same order. Without it
   * the ledger reads the record just before writing, which narrows the race but cannot close it.
   */
  compareAndPut?(
    key: string,
    expected: StoredOperation | undefined,
    op: StoredOperation,
  ): Promise<boolean>;
}

// ----------------------------------------------------------------------------
// logging
// ----------------------------------------------------------------------------
export interface NeweggLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
