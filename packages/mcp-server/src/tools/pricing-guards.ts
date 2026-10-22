/**
 * Server-side price-write policy shared by `newegg_pricing_preview_update` (which plans) and
 * `newegg_pricing_apply_update` (which re-checks just before sending). The checks depend on the
 * live price, so they must run again at apply: the preview's answer can be stale by then.
 */
import type { PriceChange } from "@devino/newegg-marketplace-sdk";

/** The fat-finger guard: blocks a change larger than `maxPriceChangePercent` (either direction). */
export function enforceChangeLimit(change: PriceChange, maxPriceChangePercent: number): void {
  if (
    change.changePercent !== undefined &&
    Math.abs(change.changePercent) > maxPriceChangePercent
  ) {
    change.blockers.push(
      `The change of ${change.changePercent}% exceeds the server limit of ` +
        `${maxPriceChangePercent}% (NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT).`,
    );
    change.status = "blocked";
  }
}

/** The price recorded at preview time for the drift check: `null` when it could not be read. */
export function previewedPrice(change: PriceChange): number | null {
  return change.currentSellingPrice ?? null;
}

const toCents = (price: number): number => Math.round(price * 100);

/** True when the live price differs from the previewed one (compared in whole cents). */
export function priceDrifted(previewed: number | null, observed: number | null): boolean {
  if (previewed === null || observed === null) return previewed !== observed;
  return toCents(previewed) !== toCents(observed);
}
