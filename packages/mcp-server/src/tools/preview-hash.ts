/**
 * Canonical hashes of the stored preview payloads, shared by the preview tools (which stamp the
 * hash on the record) and {@link previewHashMatches} (which re-checks it before an apply sends
 * anything). Re-verifying at apply means a record that was changed in a persistent or shared
 * `PreviewStore` between preview and apply is refused instead of executed (ADR 0005).
 *
 * RMA / courtesy-refund and shipping-label records hash extra fields (refund and label cost) and
 * re-check themselves in `service-write.ts` / `shipping-label-write.ts`.
 */
import { createHash } from "node:crypto";
import type {
  NormalizedInventoryUpdate,
  InventoryUpdateStrategy,
} from "@devino/newegg-marketplace-sdk";
import type {
  ListingPreviewRecord,
  PreviewRecord,
  PricePreviewRecord,
  VolumeDiscountPreviewRecord,
} from "../preview-store/index.js";

const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

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
  marketplace: string,
  strategy: InventoryUpdateStrategy,
  updates: NormalizedInventoryUpdate[],
): string {
  return sha256(
    JSON.stringify({ marketplace, strategy, updates: updates.map(canonicalInventoryUpdate) }),
  );
}

export function hashPricePreview(
  marketplace: string,
  updates: PricePreviewRecord["normalizedUpdates"],
  previewedCurrentPrices: PricePreviewRecord["previewedCurrentPrices"],
): string {
  return sha256(
    JSON.stringify({
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
    }),
  );
}

/** Listing creations and volume-discount updates hash their normalized items as stored. */
export function hashItemsPreview(
  marketplace: string,
  items: ListingPreviewRecord["items"] | VolumeDiscountPreviewRecord["items"],
): string {
  return sha256(JSON.stringify({ marketplace, items }));
}

/**
 * True when the record's stored hash matches its current content. Kinds whose hash is checked by
 * their own apply path (RMA / refund / shipping label) return true here.
 */
export function previewHashMatches(record: PreviewRecord): boolean {
  switch (record.kind) {
    case "inventoryUpdate":
      return (
        hashInventoryPreview(record.marketplace, record.strategy, record.normalizedUpdates) ===
        record.hash
      );
    case "priceUpdate":
      return (
        hashPricePreview(
          record.marketplace,
          record.normalizedUpdates,
          record.previewedCurrentPrices,
        ) === record.hash
      );
    case "listingCreate":
    case "volumeDiscountUpdate":
      return hashItemsPreview(record.marketplace, record.items) === record.hash;
    default:
      return true;
  }
}
