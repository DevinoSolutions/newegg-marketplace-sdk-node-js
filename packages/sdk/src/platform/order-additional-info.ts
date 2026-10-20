/**
 * Per-marketplace availability of Get Additional Order Information (contracts §24). The portal
 * page lists a single Newegg.com URL; no B2B or CAN variant is documented, so those fail with the
 * existing unsupported-operation error rather than send a request that may not be served
 * (ADR 0002). Keeping that here means the API layer has no per-marketplace `if`s.
 */
import type { NeweggMarketplace } from "../types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";

export interface OrderAdditionalInfoPlatform {
  readonly marketplace: NeweggMarketplace;
  readonly supported: boolean;
}

const usInfo: OrderAdditionalInfoPlatform = { marketplace: "us", supported: true };
const b2bInfo: OrderAdditionalInfoPlatform = { marketplace: "b2b", supported: false };
const caInfo: OrderAdditionalInfoPlatform = { marketplace: "ca", supported: false };

/** Returns the additional-order-info platform data for a marketplace. */
export function getOrderAdditionalInfoPlatform(
  marketplace: NeweggMarketplace,
): OrderAdditionalInfoPlatform {
  switch (marketplace) {
    case "us":
      return usInfo;
    case "b2b":
      return b2bInfo;
    case "ca":
      return caInfo;
  }
}

/** Throws {@link UnsupportedMarketplaceOperationError} when the call is not offered on the platform. */
export function assertOrderAdditionalInfoSupported(platform: OrderAdditionalInfoPlatform): void {
  if (platform.supported) return;
  throw new UnsupportedMarketplaceOperationError(
    `Get Additional Order Information is documented for Newegg.com only; the ` +
      `${platform.marketplace} marketplace is not supported.`,
  );
}
