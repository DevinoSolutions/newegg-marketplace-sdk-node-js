/**
 * Per-marketplace availability of Get Order Information request criteria (contracts §10.1). Newegg
 * rejects an unknown `RequestCriteria` child with `400 CE003`, and live read-only probes on
 * 2026-10-21 (T-5912) showed `CountryCode`, `PremierOrder` and `Type` = 4 (NWS) are accepted on
 * Newegg.com only, while `LastUpdatedAfter` and `IsInternal` are valid on all three. A filter the
 * platform cannot honor must never be silently dropped (the caller would get a wider result than
 * asked for), so it fails with the existing unsupported-operation error BEFORE any request is sent
 * (ADR 0002). Keeping that here means the API layer has no per-marketplace `if`s.
 */
import type { ListOrdersInput, NeweggMarketplace } from "../types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";

export interface OrderCriteriaPlatform {
  readonly marketplace: NeweggMarketplace;
  /** `CountryCode` (ISO3 ship-to country). */
  readonly countryCode: boolean;
  /** `PremierOrder`. */
  readonly premierOrder: boolean;
  /** `Type` = 4 (NWS). The other `Type` values are not restricted here. */
  readonly nwsType: boolean;
}

const us: OrderCriteriaPlatform = {
  marketplace: "us",
  countryCode: true,
  premierOrder: true,
  nwsType: true,
};
const b2b: OrderCriteriaPlatform = {
  marketplace: "b2b",
  countryCode: false,
  premierOrder: false,
  nwsType: false,
};
const ca: OrderCriteriaPlatform = {
  marketplace: "ca",
  countryCode: false,
  premierOrder: false,
  nwsType: false,
};

/** Returns the order-criteria capabilities of a marketplace. */
export function getOrderCriteriaPlatform(marketplace: NeweggMarketplace): OrderCriteriaPlatform {
  switch (marketplace) {
    case "us":
      return us;
    case "b2b":
      return b2b;
    case "ca":
      return ca;
  }
}

/**
 * Throws {@link UnsupportedMarketplaceOperationError} naming every criterion in `input` that the
 * platform does not accept. Only criteria the caller actually set are checked.
 */
export function assertOrderCriteriaSupported(
  platform: OrderCriteriaPlatform,
  input: ListOrdersInput,
): void {
  const unsupported: string[] = [];
  if (input.countryCode !== undefined && !platform.countryCode) unsupported.push("countryCode");
  if (input.premierOrder !== undefined && !platform.premierOrder) unsupported.push("premierOrder");
  if (input.type === "nws" && !platform.nwsType) unsupported.push('type "nws"');
  if (unsupported.length === 0) return;
  throw new UnsupportedMarketplaceOperationError(
    `Get Order Information does not accept ${unsupported.join(", ")} on the ` +
      `${platform.marketplace} marketplace (Newegg answers 400 CE003); these criteria are ` +
      `Newegg.com (us) only. Remove them or use a us client.`,
    { details: { marketplace: platform.marketplace, unsupportedCriteria: unsupported } },
  );
}
