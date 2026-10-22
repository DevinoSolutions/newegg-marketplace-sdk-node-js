/**
 * Integrity MACs of the stored preview payloads, shared by the preview tools (which stamp the MAC
 * on the record) and {@link previewHashMatches} (which re-checks it before an apply sends
 * anything). Re-verifying at apply means a record that was changed in a persistent or shared
 * `PreviewStore` between preview and apply is refused instead of executed (ADR 0005).
 *
 * The record's `hash` is an HMAC-SHA256 under a server secret, not a plain digest, taken over a
 * key-sorted canonical JSON so a store that does not preserve object key order (Postgres jsonb, some
 * document stores) cannot turn a good record into a false `preview_tampered` (T-6215): the algorithm
 * and canonical forms are public, so an unkeyed hash would let anyone who can write the store
 * recompute a matching hash over a forged record (T-6218). The key is `NEWEGG_MCP_PREVIEW_HMAC_KEY`
 * when set, otherwise a random per-process key (fine for the in-memory store; a store shared
 * across processes MUST set the shared key, or each process refuses the other's previews). The
 * MAC input also carries the previewId, sessionId and expiresAt, so a valid record cannot be
 * re-filed under another id or session, or have its lifetime extended.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  NormalizedInventoryUpdate,
  InventoryUpdateStrategy,
} from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type {
  ListingPreviewRecord,
  PreviewRecord,
  PricePreviewRecord,
  ServiceWriteKind,
  ShippingLabelKind,
  VolumeDiscountPreviewRecord,
} from "../preview-store/index.js";

/** Bumped if the MAC input layout ever changes; part of the MAC input. */
const MAC_VERSION = 2;

let processKey: Buffer | undefined;

/**
 * The key previews are sealed with: the configured `NEWEGG_MCP_PREVIEW_HMAC_KEY`, else a random
 * 32-byte key generated once per process. Never logged or returned to a caller.
 */
export function previewKeyFor(config: Pick<McpServerConfig, "previewIntegrity">): Buffer {
  const configured = config.previewIntegrity?.hmacKey;
  if (configured !== undefined) return Buffer.from(configured, "utf8");
  processKey ??= randomBytes(32);
  return processKey;
}

/** What a MAC is bound to besides the payload: the record's identity, owner session and expiry. */
export interface PreviewSeal {
  readonly key: Buffer;
  readonly previewId: string;
  /** Undefined on stdio (a single implicit session). */
  readonly sessionId: string | undefined;
  readonly expiresAt: Date;
}

/** The seal for a record about to be stored by `ctx`'s session. */
export function sealFor(
  ctx: { readonly config: Pick<McpServerConfig, "previewIntegrity">; readonly sessionId?: string },
  previewId: string,
  expiresAt: Date,
): PreviewSeal {
  return { key: previewKeyFor(ctx.config), previewId, sessionId: ctx.sessionId, expiresAt };
}

/**
 * The JSON.stringify view of `value` with every object's keys in sorted order (arrays keep their
 * order). A store may hand objects back with their keys reordered; sorting makes the MAC independent
 * of that. `toJSON` is honoured and `undefined` properties are dropped, exactly as JSON.stringify
 * would, so a value that serializes the same MACs the same.
 */
function canonicalize(value: unknown): unknown {
  const plain =
    value !== null &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
      ? (value.toJSON as () => unknown)()
      : value;
  if (Array.isArray(plain)) return plain.map((entry) => canonicalize(entry));
  if (plain !== null && typeof plain === "object") {
    // A null prototype keeps a "__proto__" key an ordinary property.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(plain).sort()) {
      sorted[key] = canonicalize((plain as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return plain;
}

function mac(seal: PreviewSeal, payload: unknown): string {
  return createHmac("sha256", seal.key)
    .update(
      JSON.stringify(
        canonicalize({
          v: MAC_VERSION,
          previewId: seal.previewId,
          sessionId: seal.sessionId ?? null,
          expiresAt: seal.expiresAt.getTime(),
          payload,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function canonicalInventoryUpdate(update: NormalizedInventoryUpdate): Record<string, unknown> {
  return {
    inputIndex: update.inputIndex,
    type: update.identifier.type,
    value: update.identifier.value,
    condition: update.identifier.type === "upc" ? (update.identifier.condition ?? null) : null,
    quantity: update.quantity,
    warehouseLocation: update.warehouseLocation ?? null,
    fulfillmentOption: update.fulfillmentOption ?? null,
  };
}

export function hashInventoryPreview(
  seal: PreviewSeal,
  marketplace: string,
  strategy: InventoryUpdateStrategy,
  updates: NormalizedInventoryUpdate[],
): string {
  return mac(seal, {
    kind: "inventoryUpdate",
    marketplace,
    strategy,
    updates: updates.map(canonicalInventoryUpdate),
  });
}

export function hashPricePreview(
  seal: PreviewSeal,
  marketplace: string,
  updates: PricePreviewRecord["normalizedUpdates"],
  previewedCurrentPrices: PricePreviewRecord["previewedCurrentPrices"],
): string {
  return mac(seal, {
    kind: "priceUpdate",
    marketplace,
    updates: updates.map((update, position) => ({
      inputIndex: update.inputIndex,
      type: update.identifier.type,
      value: update.identifier.value,
      condition: update.identifier.type === "upc" ? (update.identifier.condition ?? null) : null,
      sellingPrice: update.sellingPrice,
      countryCode: update.countryCode ?? null,
      currency: update.currency ?? null,
      previewedCurrentPrice: previewedCurrentPrices[position] ?? null,
    })),
  });
}

/** Listing creations and volume-discount updates MAC their normalized items as stored. */
export function hashItemsPreview(
  seal: PreviewSeal,
  kind: ListingPreviewRecord["kind"] | VolumeDiscountPreviewRecord["kind"],
  marketplace: string,
  items: ListingPreviewRecord["items"] | VolumeDiscountPreviewRecord["items"],
): string {
  return mac(seal, { kind, marketplace, items });
}

/** RMA / courtesy-refund writes: the input plus the money the write moves (whole cents). */
export function hashServicePreview(
  seal: PreviewSeal,
  kind: ServiceWriteKind,
  marketplace: string,
  input: unknown,
  refundCents: number | undefined,
): string {
  return mac(seal, { kind, marketplace, input, refundCents: refundCents ?? null });
}

/** Shipping-label purchases and reprints: the input plus the quoted cost (whole cents). */
export function hashLabelPreview(
  seal: PreviewSeal,
  kind: ShippingLabelKind,
  marketplace: string,
  input: unknown,
  costCents: number | undefined,
): string {
  return mac(seal, { kind, marketplace, input, costCents: costCents ?? null });
}

/** Constant-time comparison of two hex MACs (length checked first). */
function macEquals(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function expectedHash(key: Buffer, record: PreviewRecord): string {
  const seal: PreviewSeal = {
    key,
    previewId: record.previewId,
    sessionId: record.sessionId,
    expiresAt: record.expiresAt,
  };
  switch (record.kind) {
    case "inventoryUpdate":
      return hashInventoryPreview(
        seal,
        record.marketplace,
        record.strategy,
        record.normalizedUpdates,
      );
    case "priceUpdate":
      return hashPricePreview(
        seal,
        record.marketplace,
        record.normalizedUpdates,
        record.previewedCurrentPrices,
      );
    case "listingCreate":
    case "volumeDiscountUpdate":
      return hashItemsPreview(seal, record.kind, record.marketplace, record.items);
    case "shippingLabelCreate":
    case "shippingLabelReprint":
      return hashLabelPreview(
        seal,
        record.kind,
        record.marketplace,
        record.input,
        record.costCents,
      );
    case "rmaSubmit":
    case "rmaEdit":
    case "rmaProcess":
    case "rmaReject":
    case "courtesyRefundIssue":
      return hashServicePreview(
        seal,
        record.kind,
        record.marketplace,
        record.input,
        record.refundCents,
      );
  }
}

/**
 * True when the record's stored MAC matches its current content under `key`. Fails closed: a
 * record that is malformed (a hashed field missing, an unknown kind, a non-string hash) is
 * reported as not matching rather than throwing.
 */
export function previewHashMatches(key: Buffer, record: PreviewRecord): boolean {
  try {
    return macEquals(expectedHash(key, record), record.hash);
  } catch {
    return false;
  }
}
