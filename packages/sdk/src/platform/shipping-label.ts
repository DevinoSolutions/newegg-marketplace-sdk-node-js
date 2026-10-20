/**
 * Per-marketplace differences of the Newegg Shipping Label Service (contracts §23). The three
 * operations share verbs, OperationTypes and bodies on every platform; what differs is the set of
 * UPS service codes, the country code of the ship-from address and the currency the quoted amounts
 * are in. Keeping that here (ADR 0002) means the API layer has no per-marketplace `if`s.
 */
import type { NeweggMarketplace, RmaCurrency } from "../types.js";

export interface ShippingLabelPlatform {
  readonly marketplace: NeweggMarketplace;
  /** ISO 3166-1 alpha-3 country the ship-from address must carry (`USA` / `CAN`). */
  readonly countryCode: "USA" | "CAN";
  /** Documented `ShippingServiceCode` values for `ShippingCarrierCode` 100 (UPS), default first. */
  readonly serviceCodes: readonly number[];
  /** Quoted amounts are assumed to be in this currency (ASSUMPTION; the pages state none). */
  readonly currency: RmaCurrency;
  /** Postal-code pattern of the ship-from address. */
  readonly postalCodePattern: RegExp;
  /** Human text for error messages. */
  readonly postalCodeHint: string;
}

const usLabels: ShippingLabelPlatform = {
  marketplace: "us",
  countryCode: "USA",
  serviceCodes: [101, 102, 103, 104, 105],
  currency: "USD",
  postalCodePattern: /^\d{5}(?:-\d{4})?$/,
  postalCodeHint: "a 5-digit ZIP code (or ZIP+4)",
};
const b2bLabels: ShippingLabelPlatform = { ...usLabels, marketplace: "b2b" };
const caLabels: ShippingLabelPlatform = {
  marketplace: "ca",
  countryCode: "CAN",
  serviceCodes: [111, 112, 113, 114],
  currency: "CAD",
  postalCodePattern: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  postalCodeHint: "a Canadian postal code such as K1A 0B1",
};

/** Returns the shipping-label platform data for a marketplace. */
export function getShippingLabelPlatform(marketplace: NeweggMarketplace): ShippingLabelPlatform {
  switch (marketplace) {
    case "us":
      return usLabels;
    case "b2b":
      return b2bLabels;
    case "ca":
      return caLabels;
  }
}
