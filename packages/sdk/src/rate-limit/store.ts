import type { RateLimitInfo, RateLimitStore } from "../types.js";
import { abortReason } from "../util.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OBSERVED_WAIT_CAP_MS = 5 * MINUTE_MS;

interface Waiter {
  recordCost: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
  settled: boolean;
}

interface Bucket {
  maxPerMinute?: number;
  maxRecordsPerHour?: number;
  requestTimes: number[];
  recordEvents: Array<{ time: number; cost: number }>;
  observed?: RateLimitInfo;
  queue: Waiter[];
  timer?: ReturnType<typeof setTimeout>;
  processing: boolean;
}

/**
 * In-process {@link RateLimitStore}. Enforces two sliding windows per key — a per-minute
 * request count and a per-hour record-cost sum — plus backpressure from observed server
 * headers (waits until `X-RateLimit-ResetTime`/`X-RecordCount-ResetTime` when the server
 * reports zero remaining). Waiters are served FIFO and support cancellation via `AbortSignal`.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();

  configure(key: string, budget: { maxPerMinute?: number; maxRecordsPerHour?: number }): void {
    const bucket = this.#bucketFor(key);
    if (budget.maxPerMinute !== undefined) bucket.maxPerMinute = budget.maxPerMinute;
    if (budget.maxRecordsPerHour !== undefined) bucket.maxRecordsPerHour = budget.maxRecordsPerHour;
  }

  observe(key: string, info: RateLimitInfo): void {
    const bucket = this.#bucketFor(key);
    bucket.observed = { ...bucket.observed, ...info };
    this.#process(key);
  }

  acquire(key: string, req: { recordCost?: number; signal?: AbortSignal }): Promise<void> {
    const signal = req.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const bucket = this.#bucketFor(key);
    const recordCost = req.recordCost ?? 1;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { recordCost, signal, resolve, reject, settled: false };
      if (signal) {
        const onAbort = (): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = bucket.queue.indexOf(waiter);
          if (index >= 0) bucket.queue.splice(index, 1);
          reject(abortReason(signal));
          this.#process(key);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      bucket.queue.push(waiter);
      this.#process(key);
    });
  }

  #bucketFor(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { requestTimes: [], recordEvents: [], queue: [], processing: false };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  #prune(bucket: Bucket, now: number): void {
    const minuteFloor = now - MINUTE_MS;
    while (bucket.requestTimes.length > 0 && (bucket.requestTimes[0] ?? 0) < minuteFloor) {
      bucket.requestTimes.shift();
    }
    const hourFloor = now - HOUR_MS;
    while (bucket.recordEvents.length > 0 && (bucket.recordEvents[0]?.time ?? 0) < hourFloor) {
      bucket.recordEvents.shift();
    }
  }

  /** Milliseconds until the head waiter may proceed; 0 means "ready now". */
  #readyInMs(bucket: Bucket, waiter: Waiter, now: number): number {
    let wait = 0;

    if (bucket.maxPerMinute !== undefined) {
      const count = bucket.requestTimes.length;
      if (count >= bucket.maxPerMinute) {
        const oldest = bucket.requestTimes[count - bucket.maxPerMinute] ?? now;
        wait = Math.max(wait, oldest + MINUTE_MS - now);
      }
    }

    if (bucket.maxRecordsPerHour !== undefined) {
      let sum = 0;
      for (const event of bucket.recordEvents) sum += event.cost;
      if (sum + waiter.recordCost > bucket.maxRecordsPerHour) {
        let running = sum;
        let recordWait = 0;
        for (const event of bucket.recordEvents) {
          running -= event.cost;
          if (running + waiter.recordCost <= bucket.maxRecordsPerHour) {
            recordWait = event.time + HOUR_MS - now;
            break;
          }
        }
        // recordWait stays 0 only when a single cost exceeds the hourly budget (misconfig):
        // grant rather than deadlock forever.
        wait = Math.max(wait, recordWait);
      }
    }

    const observed = bucket.observed;
    if (observed?.requestRemaining === 0 && observed.requestResetAt) {
      const ms = observed.requestResetAt.getTime() - now;
      if (ms > 0) wait = Math.max(wait, Math.min(ms, OBSERVED_WAIT_CAP_MS));
    }
    if (observed?.recordRemaining === 0 && observed.recordResetAt) {
      const ms = observed.recordResetAt.getTime() - now;
      if (ms > 0) wait = Math.max(wait, Math.min(ms, OBSERVED_WAIT_CAP_MS));
    }

    return wait;
  }

  #record(bucket: Bucket, waiter: Waiter, now: number): void {
    if (bucket.maxPerMinute !== undefined) bucket.requestTimes.push(now);
    if (bucket.maxRecordsPerHour !== undefined) {
      bucket.recordEvents.push({ time: now, cost: waiter.recordCost });
    }
  }

  #scheduleTimer(key: string, waitMs: number): void {
    const bucket = this.#bucketFor(key);
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(
      () => {
        bucket.timer = undefined;
        this.#process(key);
      },
      Math.max(1, Math.ceil(waitMs)),
    );
  }

  #process(key: string): void {
    const bucket = this.#bucketFor(key);
    if (bucket.processing) return;
    bucket.processing = true;
    try {
      for (;;) {
        const head = bucket.queue[0];
        if (!head) return;
        if (head.settled) {
          bucket.queue.shift();
          continue;
        }
        const now = Date.now();
        this.#prune(bucket, now);
        const waitMs = this.#readyInMs(bucket, head, now);
        if (waitMs <= 0) {
          this.#record(bucket, head, now);
          head.settled = true;
          if (head.signal && head.onAbort) head.signal.removeEventListener("abort", head.onAbort);
          bucket.queue.shift();
          head.resolve();
          continue;
        }
        this.#scheduleTimer(key, waitMs);
        return;
      }
    } finally {
      bucket.processing = false;
    }
  }
}
