/**
 * Per-order ledger of label CREATE attempts (T-6212). A label purchase spends money, ships the order
 * and cannot be undone, yet the only duplicate guard in the read path is "the order reads
 * unshipped", and Newegg's order status can lag a purchase that did land (the order keeps reading
 * unshipped). The ledger therefore remembers every create per (marketplace, order number) and
 * `create` refuses a second one until the caller has verified the order and acknowledged the prior
 * attempt explicitly.
 *
 * It is built on the injectable {@link OperationStore} of ADR 0004, with the same three states a
 * feed submission records: `submitting` is written BEFORE the request is dispatched and stays that
 * way when the outcome is unknown (timeout, 5xx, caller abort after dispatch: the attempt is
 * indeterminate), `submitted` is a confirmed purchase, and `failed` means the request provably never
 * bought a label (never dispatched, or Newegg rejected it with an HTTP 4xx or by refusing every
 * package), which is the only state that lets a new create through without an acknowledgement.
 *
 * A synchronous in-process cache sits in front of the store so that two creates racing inside one
 * process cannot both pass: the check and the `submitting` write happen with nothing awaited
 * between them. The store itself has no compare-and-set, so two processes sharing one store can
 * still race; the store is read at preview time and just before the claim.
 */
import type { LabelCreateAttempt, OperationStore, StoredOperation } from "../types.js";

/** How long an attempt blocks a new create. Past it the record is ignored (24 h). */
const LABEL_CREATE_GUARD_TTL_MS = 24 * 3_600_000;

/** Attempt ids kept per order (the newest is the one an acknowledgement must name). */
const MAX_ATTEMPT_IDS = 20;

/**
 * Errors that prove no label was bought: thrown before the request was dispatched. Kept by identity
 * so the classification cannot leak into messages or JSON.
 */
const notBought = new WeakSet<object>();

/** Marks a thrown error as proof that the label request never reached Newegg. */
export function markNotBought<E>(error: E): E {
  if (typeof error === "object" && error !== null) notBought.add(error);
  return error;
}

export function isMarkedNotBought(error: unknown): boolean {
  return typeof error === "object" && error !== null && notBought.has(error);
}

type LabelCreateClaim =
  { refused: LabelCreateAttempt } | { op: StoredOperation; previous: StoredOperation | undefined };

export class LabelCreateLedger {
  readonly #cache = new Map<string, StoredOperation>();
  readonly #store: OperationStore;
  readonly #ttlMs: number;

  constructor(store: OperationStore, ttlMs: number = LABEL_CREATE_GUARD_TTL_MS) {
    this.#store = store;
    this.#ttlMs = ttlMs;
  }

  /** The store key of an order's attempts. Holds no credential. */
  static key(marketplace: string, orderNumber: string): string {
    return `label-create:${marketplace}:${orderNumber}`;
  }

  /** The attempt that currently blocks a create, reading the store (newest of cache and store). */
  async read(key: string): Promise<LabelCreateAttempt | undefined> {
    const stored = await this.#store.get(key);
    const cached = this.#cache.get(key);
    const newest =
      stored !== undefined && cached !== undefined
        ? cached.updatedAt >= stored.updatedAt
          ? cached
          : stored
        : (cached ?? stored);
    if (newest !== undefined) this.#cache.set(key, newest);
    return this.#active(newest);
  }

  /**
   * Check-and-record in one synchronous step: refuses while an attempt blocks (unless `acknowledged`
   * names exactly that attempt), otherwise records `submitting`. Call {@link persist} next.
   */
  claim(
    key: string,
    attemptId: string,
    payloadHash: string,
    acknowledged: string | undefined,
  ): LabelCreateClaim {
    const previous = this.#cache.get(key);
    const blocking = this.#active(previous);
    if (blocking !== undefined && blocking.attemptId !== acknowledged) {
      return { refused: blocking };
    }
    const op: StoredOperation = {
      state: "submitting",
      payloadHash,
      requestIds: [...(previous?.requestIds ?? []), attemptId].slice(-MAX_ATTEMPT_IDS),
      updatedAt: new Date().toISOString(),
    };
    this.#cache.set(key, op);
    return { op, previous };
  }

  /** Writes the `submitting` record BEFORE the request is dispatched. Rejects if the store does. */
  async persist(key: string, op: StoredOperation): Promise<void> {
    await this.#store.put(key, op);
  }

  /** Undoes a claim whose record could not be persisted (nothing was sent). */
  rollback(key: string, claim: { op: StoredOperation; previous: StoredOperation | undefined }) {
    if (this.#cache.get(key) !== claim.op) return;
    if (claim.previous === undefined) this.#cache.delete(key);
    else this.#cache.set(key, claim.previous);
  }

  /**
   * Records the outcome of `attemptId`. The cache is updated synchronously; a store failure here is
   * swallowed because the record already says `submitting`, which is the safe state.
   */
  async settle(key: string, attemptId: string, state: "submitted" | "failed"): Promise<void> {
    const current = this.#cache.get(key);
    if (current === undefined || latestAttemptId(current) !== attemptId) return;
    const op: StoredOperation = { ...current, state, updatedAt: new Date().toISOString() };
    this.#cache.set(key, op);
    try {
      await this.#store.put(key, op);
    } catch {
      // The persisted record stays `submitting`: a later create is refused rather than risked.
    }
  }

  #active(op: StoredOperation | undefined): LabelCreateAttempt | undefined {
    if (op === undefined || op.state === "failed") return undefined;
    const at = Date.parse(op.updatedAt);
    if (Number.isFinite(at) && Date.now() - at > this.#ttlMs) return undefined;
    return { state: op.state, attemptId: latestAttemptId(op), atIso: op.updatedAt };
  }
}

function latestAttemptId(op: StoredOperation): string {
  return op.requestIds?.[op.requestIds.length - 1] ?? "unknown";
}
