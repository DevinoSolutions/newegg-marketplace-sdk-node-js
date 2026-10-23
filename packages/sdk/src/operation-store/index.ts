import type { OperationStore, StoredOperation } from "../types.js";

/**
 * In-process {@link OperationStore} backing feed-submission dedup ledgers. Distributed
 * callers can supply a Redis/DB-backed implementation of the same interface.
 */
export class InMemoryOperationStore implements OperationStore {
  readonly #operations = new Map<string, StoredOperation>();

  get(key: string): Promise<StoredOperation | undefined> {
    return Promise.resolve(this.#operations.get(key));
  }

  put(key: string, op: StoredOperation): Promise<void> {
    this.#operations.set(key, op);
    return Promise.resolve();
  }

  compareAndPut(
    key: string,
    expected: StoredOperation | undefined,
    op: StoredOperation,
  ): Promise<boolean> {
    if (!sameOperation(this.#operations.get(key), expected)) return Promise.resolve(false);
    this.#operations.set(key, op);
    return Promise.resolve(true);
  }
}

function sameOperation(a: StoredOperation | undefined, b: StoredOperation | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.state === b.state &&
    a.payloadHash === b.payloadHash &&
    a.updatedAt === b.updatedAt &&
    (a.requestIds ?? []).join("\n") === (b.requestIds ?? []).join("\n")
  );
}
