/**
 * Parsing/normalization for the **UNOFFICIAL** public storefront endpoints (contracts §14).
 * Everything here is defensive: the storefront is undocumented, so missing and extra fields
 * are tolerated and scalars are read through the shared wire coercers.
 */
import { z } from "zod";
import type { StorefrontOffer } from "../types.js";
import { asArray, asBoolean, asNumber, asString, getField } from "../schemas/wire.js";

/** One `ItemInfo` row. `looseObject` keeps unknown keys (there are many) instead of failing. */
const offerWireSchema = z.looseObject({
  Item: z.unknown().optional(),
  UnitCost: z.unknown().optional(),
  ShippingCharge: z.unknown().optional(),
  Instock: z.unknown().optional(),
  Active: z.unknown().optional(),
  IsActivated: z.unknown().optional(),
  Seller: z.unknown().optional(),
});

/** MoreBuyingOptions envelope. Only the fields the SDK reads are declared. */
export const moreBuyingOptionsSchema = z.looseObject({
  ItemInfo: z.unknown().optional(),
  Total: z.unknown().optional(),
  CurrentPageNum: z.unknown().optional(),
  PageCount: z.unknown().optional(),
});

type MoreBuyingOptionsWire = z.infer<typeof moreBuyingOptionsSchema>;

/** Trims a wire string and collapses empty/whitespace-only values to `undefined`. */
function cleanString(value: unknown): string | undefined {
  const str = asString(value)?.trim();
  return str === undefined || str === "" ? undefined : str;
}

/** `20156294` -> `20-156-294`. */
function dashed(digits: string): string {
  return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5, 8)}`;
}

/**
 * Normalizes a parent catalog identifier into the form `ParentItem` accepts.
 *
 * Accepts the dashed numeric form (`20-156-294`), the bare 8-digit form (`20156294`), the
 * product-page form (`N82E16820156294`), and marketplace-style parent CODEs
 * (`3C6-00T1-002H0`), which are passed through unchanged.
 */
export function normalizeParentItemNumber(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  // Product-page item number: "N82E16" + an optional category digit + the 8 catalog digits.
  const productPage = /^N82E16\d?(\d{8})$/i.exec(value);
  if (productPage?.[1] !== undefined) return dashed(productPage[1]);
  if (/^\d{8}$/.test(value)) return dashed(value);
  return value;
}

/**
 * Extracts a parent catalog identifier from a `/p/<offerNumber>` 301 `Location` header.
 * Handles both observed redirect targets: `/<slug>/p/N82E168…` and `/p/<CODE>`.
 * Returns `undefined` when the location has no `/p/<value>` segment.
 */
export function parentFromRedirectLocation(location: string, baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(location, baseUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const index = segments.lastIndexOf("p");
  if (index === -1) return undefined;
  const target = segments[index + 1];
  if (target === undefined || target === "") return undefined;
  return normalizeParentItemNumber(decodeURIComponent(target));
}

/**
 * Normalizes one `ItemInfo` row. Returns `undefined` for rows without an item number or a
 * parseable price — those are not usable offers and are dropped rather than surfaced as `NaN`.
 */
function normalizeOffer(raw: unknown): StorefrontOffer | undefined {
  const parsed = offerWireSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const row = parsed.data;

  const offerItemNumber = cleanString(row.Item);
  const price = asNumber(row.UnitCost);
  if (offerItemNumber === undefined || price === undefined) return undefined;

  const sellerId = cleanString(getField(row.Seller, "SellerId"));
  const sellerName = cleanString(getField(row.Seller, "SellerName"));

  return {
    offerItemNumber,
    sellerName,
    sellerId,
    // Newegg's own (first-party) offers carry no seller: `Seller` is null, or an object whose
    // `SellerId` is the empty string.
    isNewegg: sellerId === undefined,
    price,
    shippingCharge: asNumber(row.ShippingCharge) ?? 0,
    inStock: asBoolean(row.Instock) ?? false,
    active: asBoolean(row.Active) ?? asBoolean(row.IsActivated) ?? false,
  };
}

/** Normalizes every usable `ItemInfo` row, preserving the storefront's own ordering. */
export function normalizeOffers(wire: MoreBuyingOptionsWire): StorefrontOffer[] {
  const offers: StorefrontOffer[] = [];
  for (const row of asArray(wire.ItemInfo)) {
    const offer = normalizeOffer(row);
    if (offer !== undefined) offers.push(offer);
  }
  return offers;
}

/** Reads the envelope's `Total`, falling back to the number of normalized offers. */
export function readTotal(wire: MoreBuyingOptionsWire, offerCount: number): number {
  return asNumber(wire.Total) ?? offerCount;
}
