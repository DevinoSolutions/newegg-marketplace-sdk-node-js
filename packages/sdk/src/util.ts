/** Internal utilities shared across modules. Not part of the public API surface. */

/** Promise-based delay that rejects with the signal's reason if the signal aborts first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extracts a DOMException-style abort reason, synthesising one when the platform omits it. */
export function abortReason(signal?: AbortSignal): unknown {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/** True when a thrown value represents an abort (caller cancellation). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** True when the value is a plain (non-null, non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits an array into fixed-size chunks, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Runs async tasks with bounded concurrency, preserving result order by index. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners: Promise<void>[] = [];
  for (let w = 0; w < limit; w++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          results[index] = await worker(items[index] as T, index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}
