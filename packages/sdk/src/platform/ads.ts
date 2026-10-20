/**
 * Per-marketplace availability of the Sponsored Ads reads (contracts §25). Every page lists the
 * Newegg.com URL only (`api.newegg.com/marketplace/sponsoredmgmt/...`) - there is no
 * Neweggbusiness.com or Newegg.ca variant - so B2B and CAN fail with the existing
 * unsupported-operation error rather than sending a request that cannot be served (ADR 0002).
 * Keeping that here means the API layer has no per-marketplace `if`s.
 */
import type { NeweggMarketplace } from "../types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";

export interface AdsPlatform {
  readonly marketplace: NeweggMarketplace;
  readonly supported: boolean;
}

const usAds: AdsPlatform = { marketplace: "us", supported: true };
const b2bAds: AdsPlatform = { marketplace: "b2b", supported: false };
const caAds: AdsPlatform = { marketplace: "ca", supported: false };

/** Returns the Sponsored Ads platform data for a marketplace. */
export function getAdsPlatform(marketplace: NeweggMarketplace): AdsPlatform {
  switch (marketplace) {
    case "us":
      return usAds;
    case "b2b":
      return b2bAds;
    case "ca":
      return caAds;
  }
}

/** Throws {@link UnsupportedMarketplaceOperationError} when Sponsored Ads is not offered. */
export function assertAdsSupported(platform: AdsPlatform): void {
  if (platform.supported) return;
  throw new UnsupportedMarketplaceOperationError(
    `Newegg Sponsored Ads is documented for Newegg.com only; the ${platform.marketplace} ` +
      `marketplace is not supported.`,
  );
}
