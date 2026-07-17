/**
 * Preview store for the two-step write flow (ADR 0005). `newegg_inventory_preview_update`
 * stores a normalized, hashed operation under a cryptographically random `previewId`;
 * `newegg_inventory_apply_update` atomically consumes it. The store is an interface so a
 * Redis/DB implementation can back multi-instance deployments; the in-memory implementation
 * ships for stdio/dev and single-process HTTP.
 *
 * This module never imports the MCP SDK (ADR 0001).
 */
import type {
  NeweggMarketplace,
  NormalizedInventoryUpdate,
  InventoryUpdateStrategy,
  NormalizedCreateListing,
} from "@devino/newegg-marketplace-sdk";

/** Fields common to every stored, ready-to-apply operation. */
interface PreviewRecordBase {
  readonly previewId: string;
  /** sha-256 (hex) of the canonical payload for this operation kind. */
  readonly hash: string;
  readonly marketplace: NeweggMarketplace;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** A stored inventory update. Quantities here are authoritative at apply time. */
export interface InventoryPreviewRecord extends PreviewRecordBase {
  readonly kind: "inventoryUpdate";
  /** Strategy to replay through `updateMany` — one of "direct" | "feed" | "auto". */
  readonly strategy: InventoryUpdateStrategy;
  readonly normalizedUpdates: NormalizedInventoryUpdate[];
}

/** A stored existing-item listing creation. Items here are authoritative at apply time. */
export interface ListingPreviewRecord extends PreviewRecordBase {
  readonly kind: "listingCreate";
  readonly items: NormalizedCreateListing[];
}

/** A stored, ready-to-apply operation, discriminated by `kind`. */
export type PreviewRecord = InventoryPreviewRecord | ListingPreviewRecord;

/** Result of an atomic consume — distinguishes the three failure modes ADR 0005 requires. */
export type ConsumeResult =
  | { readonly status: "ok"; readonly record: PreviewRecord }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "already_used" };

export interface PreviewStore {
  /** Persists a preview record (overwrites any record with the same id). */
  put(record: PreviewRecord): Promise<void>;
  /** Returns a live (unconsumed, unexpired) record, or undefined otherwise. Never consumes. */
  get(previewId: string): Promise<PreviewRecord | undefined>;
  /** Atomically marks the preview used and returns it, or reports why it could not be consumed. */
  consume(previewId: string): Promise<ConsumeResult>;
}

interface StoredEntry {
  record: PreviewRecord;
  consumed: boolean;
}

/**
 * In-memory `PreviewStore`. Entries are retained after consumption/expiry (as small
 * tombstones) so `consume` can report `already_used` and `expired` distinctly rather than
 * collapsing both into `not_found`. The clock is injectable for deterministic tests.
 */
export class InMemoryPreviewStore implements PreviewStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  put(record: PreviewRecord): Promise<void> {
    this.entries.set(record.previewId, { record, consumed: false });
    return Promise.resolve();
  }

  get(previewId: string): Promise<PreviewRecord | undefined> {
    const entry = this.entries.get(previewId);
    if (entry === undefined || entry.consumed) {
      return Promise.resolve(undefined);
    }
    if (this.isExpired(entry.record)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.record);
  }

  consume(previewId: string): Promise<ConsumeResult> {
    const entry = this.entries.get(previewId);
    if (entry === undefined) {
      return Promise.resolve({ status: "not_found" });
    }
    if (entry.consumed) {
      return Promise.resolve({ status: "already_used" });
    }
    if (this.isExpired(entry.record)) {
      return Promise.resolve({ status: "expired" });
    }
    entry.consumed = true;
    return Promise.resolve({ status: "ok", record: entry.record });
  }

  private isExpired(record: PreviewRecord): boolean {
    return this.now().getTime() > record.expiresAt.getTime();
  }
}
