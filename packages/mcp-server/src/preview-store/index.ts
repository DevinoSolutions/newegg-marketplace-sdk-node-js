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
  EditRmaInput,
  IssueCourtesyRefundInput,
  NeweggMarketplace,
  NormalizedInventoryUpdate,
  InventoryUpdateStrategy,
  NormalizedCreateListing,
  NormalizedPriceUpdate,
  NormalizedVolumeDiscountUpdate,
  ProcessRmaInput,
  RejectRmaInput,
  ShippingLabelInput,
  ShippingLabelReprintInput,
  SubmitRmaInput,
} from "@devino/newegg-marketplace-sdk";

/** Fields common to every stored, ready-to-apply operation. */
export interface PreviewRecordBase {
  readonly previewId: string;
  /** sha-256 (hex) of the canonical payload for this operation kind. */
  readonly hash: string;
  readonly marketplace: NeweggMarketplace;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /**
   * The MCP session that created the preview (HTTP transport; absent on stdio, which has a single
   * implicit session). Set by the server, never by a caller. A session can only consume its own
   * previews (T-5675).
   */
  readonly sessionId?: string;
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

/** A stored volume-discount update (contracts §22). Tiers here are authoritative at apply time. */
export interface VolumeDiscountPreviewRecord extends PreviewRecordBase {
  readonly kind: "volumeDiscountUpdate";
  readonly items: NormalizedVolumeDiscountUpdate[];
}

/**
 * A stored selling-price update (contracts §16). Only previewed-eligible (non-blocked) updates
 * are stored, and the prices here are authoritative at apply time.
 */
export interface PricePreviewRecord extends PreviewRecordBase {
  readonly kind: "priceUpdate";
  readonly normalizedUpdates: NormalizedPriceUpdate[];
}

/** Stored input of each RMA / courtesy-refund write (contracts §20), by record `kind`. */
export interface ServiceWriteInputs {
  readonly rmaSubmit: SubmitRmaInput;
  readonly rmaEdit: EditRmaInput;
  readonly rmaProcess: ProcessRmaInput;
  readonly rmaReject: RejectRmaInput;
  readonly courtesyRefundIssue: IssueCourtesyRefundInput;
}

/** Discriminator of the Service Management write previews. */
export type ServiceWriteKind = keyof ServiceWriteInputs;

/**
 * A stored RMA or courtesy-refund write. These move customer money or change a return, so the
 * `input` here is authoritative at apply time and `hash` (sha-256 of the canonical kind +
 * marketplace + input + refundCents) is re-checked before anything is sent.
 */
export type ServiceWritePreviewRecord = {
  [K in ServiceWriteKind]: PreviewRecordBase & {
    readonly kind: K;
    readonly input: ServiceWriteInputs[K];
    /**
     * Money the previewed write moves, in whole cents (undefined when it moves none). A write whose
     * amount is read from Newegg at plan time (Process RMA) re-reads it at apply and aborts when it
     * differs from this figure.
     */
    readonly refundCents?: number;
  };
}[ServiceWriteKind];

/** Stored input of each Shipping Label write (contracts §23), by record `kind`. */
export interface ShippingLabelInputs {
  readonly shippingLabelCreate: ShippingLabelInput;
  readonly shippingLabelReprint: ShippingLabelReprintInput;
}

/** Discriminator of the Shipping Label write previews. */
export type ShippingLabelKind = keyof ShippingLabelInputs;

/**
 * A stored label purchase or reprint. Buying a label charges the seller's account and ships the
 * order, so the `input` here is authoritative at apply time and `hash` (sha-256 of the canonical
 * kind + marketplace + input + costCents) is re-checked before anything is sent.
 */
export type ShippingLabelPreviewRecord = {
  [K in ShippingLabelKind]: PreviewRecordBase & {
    readonly kind: K;
    readonly input: ShippingLabelInputs[K];
    /**
     * The quoted cost of the previewed label in whole cents, recorded only when
     * a label cap was active at preview time (undefined when it was `unlimited`). Part of the
     * hash so it cannot be edited in the store.
     */
    readonly costCents?: number;
  };
}[ShippingLabelKind];

/** A stored, ready-to-apply operation, discriminated by `kind`. */
export type PreviewRecord =
  | InventoryPreviewRecord
  | ListingPreviewRecord
  | PricePreviewRecord
  | VolumeDiscountPreviewRecord
  | ServiceWritePreviewRecord
  | ShippingLabelPreviewRecord;

/** Result of an atomic consume — distinguishes the three failure modes ADR 0005 requires. */
export type ConsumeResult =
  | { readonly status: "ok"; readonly record: PreviewRecord }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "already_used" };

/**
 * Who is asking. When given, a store must only return or consume a record whose `sessionId`
 * equals `scope.sessionId` (both undefined counts as equal) and otherwise answer as if the
 * record did not exist, WITHOUT consuming it. The tool layer always passes a scope and also
 * re-checks the returned record, so a store that ignores the scope is still safe, only less kind.
 */
export interface PreviewScope {
  readonly sessionId: string | undefined;
}

export interface PreviewStore {
  /** Persists a preview record (overwrites any record with the same id). */
  put(record: PreviewRecord): Promise<void>;
  /** Returns a live (unconsumed, unexpired) record, or undefined otherwise. Never consumes. */
  get(previewId: string, scope?: PreviewScope): Promise<PreviewRecord | undefined>;
  /** Atomically marks the preview used and returns it, or reports why it could not be consumed. */
  consume(previewId: string, scope?: PreviewScope): Promise<ConsumeResult>;
}

/**
 * A view of `store` bound to one MCP session: records are stamped with `sessionId` on `put`, and
 * `get` / `consume` only see that session's records. Used by the server so every tool handler is
 * session-scoped without knowing about sessions.
 */
export function bindPreviewStoreToSession(
  store: PreviewStore,
  sessionId: string | undefined,
): PreviewStore {
  const scope: PreviewScope = { sessionId };
  return {
    put: (record) => store.put(sessionId === undefined ? record : { ...record, sessionId }),
    get: (previewId) => store.get(previewId, scope),
    consume: (previewId) => store.consume(previewId, scope),
  };
}

interface StoredEntry {
  record: PreviewRecord;
  consumed: boolean;
  /** Epoch ms of consumption, for tombstone retention. */
  consumedAt?: number;
}

export interface InMemoryPreviewStoreOptions {
  /** Hard cap on stored records (live + tombstones); the oldest are dropped first. Default 1000. */
  maxEntries?: number;
  /**
   * How long a consumed or expired record is remembered so `consume` can answer `already_used` /
   * `expired` instead of `not_found`. Default 10 minutes; afterwards the record is swept.
   */
  tombstoneRetentionMs?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TOMBSTONE_RETENTION_MS = 10 * 60_000;
/** Sweeps run at most this often (amortized onto put / get / consume). */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * In-memory `PreviewStore`. Entries are retained after consumption/expiry (as small
 * tombstones) so `consume` can report `already_used` and `expired` distinctly rather than
 * collapsing both into `not_found`. The clock is injectable for deterministic tests.
 */
export class InMemoryPreviewStore implements PreviewStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly now: () => Date;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private lastSweepAt = 0;

  constructor(now: () => Date = () => new Date(), options: InMemoryPreviewStoreOptions = {}) {
    this.now = now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.retentionMs = options.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS;
  }

  put(record: PreviewRecord): Promise<void> {
    this.sweepIfDue();
    // Re-inserting moves the record to the newest position of the eviction order.
    this.entries.delete(record.previewId);
    this.entries.set(record.previewId, { record, consumed: false });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return Promise.resolve();
  }

  get(previewId: string, scope?: PreviewScope): Promise<PreviewRecord | undefined> {
    this.sweepIfDue();
    const entry = this.entries.get(previewId);
    if (entry === undefined || entry.consumed) {
      return Promise.resolve(undefined);
    }
    if (this.isExpired(entry.record) || !inScope(entry.record, scope)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.record);
  }

  consume(previewId: string, scope?: PreviewScope): Promise<ConsumeResult> {
    this.sweepIfDue();
    const entry = this.entries.get(previewId);
    // A record that belongs to another session looks exactly like a missing one, and is left alone.
    if (entry === undefined || !inScope(entry.record, scope)) {
      return Promise.resolve({ status: "not_found" });
    }
    if (entry.consumed) {
      return Promise.resolve({ status: "already_used" });
    }
    if (this.isExpired(entry.record)) {
      return Promise.resolve({ status: "expired" });
    }
    entry.consumed = true;
    entry.consumedAt = this.now().getTime();
    return Promise.resolve({ status: "ok", record: entry.record });
  }

  private isExpired(record: PreviewRecord): boolean {
    return this.now().getTime() > record.expiresAt.getTime();
  }

  /** Drops consumed records and expired-unapplied records once their retention has passed. */
  private sweepIfDue(): void {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = nowMs;
    for (const [id, entry] of this.entries) {
      const goneAt = entry.consumed
        ? (entry.consumedAt ?? nowMs)
        : entry.record.expiresAt.getTime();
      if (nowMs - goneAt > this.retentionMs) this.entries.delete(id);
    }
  }
}

function inScope(record: PreviewRecord, scope: PreviewScope | undefined): boolean {
  return scope === undefined || record.sessionId === scope.sessionId;
}
