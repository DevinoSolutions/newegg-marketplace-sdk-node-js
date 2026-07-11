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
}
