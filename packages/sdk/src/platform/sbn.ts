/**
 * Per-marketplace availability of the Shipped-by-Newegg inbound-shipment reads (contracts §21).
 * The pages list Newegg.com and Neweggbusiness.com only; CAN is not listed, so it fails with the
 * existing unsupported-operation error rather than sending a request that cannot be served
 * (ADR 0002). Keeping that here means the API layer has no per-marketplace `if`s.
 */
import type { NeweggMarketplace } from "../types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";

export interface SbnPlatform {
  readonly marketplace: NeweggMarketplace;
  readonly supported: boolean;
}

const usSbn: SbnPlatform = { marketplace: "us", supported: true };
const b2bSbn: SbnPlatform = { marketplace: "b2b", supported: true };
const caSbn: SbnPlatform = { marketplace: "ca", supported: false };

/** Returns the SBN platform data for a marketplace. */
export function getSbnPlatform(marketplace: NeweggMarketplace): SbnPlatform {
  switch (marketplace) {
    case "us":
      return usSbn;
    case "b2b":
      return b2bSbn;
    case "ca":
      return caSbn;
  }
}

/** Throws {@link UnsupportedMarketplaceOperationError} when SBN is not offered on the platform. */
export function assertSbnSupported(platform: SbnPlatform): void {
  if (platform.supported) return;
  throw new UnsupportedMarketplaceOperationError(
    `Shipped by Newegg (SBN) inbound shipments are documented for Newegg.com and Newegg Business ` +
      `only; the ${platform.marketplace} marketplace is not supported.`,
  );
}
