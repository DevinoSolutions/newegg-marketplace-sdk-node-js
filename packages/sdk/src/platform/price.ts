import type { ParsedPrice, ParsedPriceEntry } from "./types.js";
import type { PricePromotion } from "../types.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";

/**
 * `OnPromotion` code → promotion name (contracts §15.1/§15.2: 0 none, 1 Price Lock,
 * 2 Promotion Code, 3 Auto Add To Cart, 4 Combo, 5 Volume Discount).
 */
const PROMOTION_BY_CODE: Record<number, PricePromotion> = {
  1: "priceLock",
  2: "promotionCode",
  3: "autoAddToCart",
  4: "combo",
  5: "volumeDiscount",
};

/** Parses `OnPromotion` ("1,5", `1`, `"0"`, or absent). Code 0 and unknown codes yield nothing. */
function parsePromotions(raw: unknown): PricePromotion[] {
  const text = asString(raw);
  if (text === undefined) return [];
  const out: PricePromotion[] = [];
  for (const part of text.split(",")) {
    const code = asNumber(part);
    const name = code === undefined ? undefined : PROMOTION_BY_CODE[code];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Normalizes one price record (a US `PriceList.Price` row, or the flat B2B/CAN body). */
function parseEntry(raw: unknown): ParsedPriceEntry {
  return {
    countryCode: asString(getField(raw, "CountryCode")),
    currency: asString(getField(raw, "Currency")),
    active: asBoolean(getField(raw, "Active")),
    msrp: asNumber(getField(raw, "MSRP")),
    map: asNumber(getField(raw, "MAP")),
    checkoutMap: asBoolean(getField(raw, "CheckoutMAP")),
    sellingPrice: asNumber(getField(raw, "SellingPrice")),
    freeShipping: asBoolean(getField(raw, "EnableFreeShipping")),
    promotions: parsePromotions(getField(raw, "OnPromotion")),
    limitQuantity: asNumber(getField(raw, "LimitQuantity")),
  };
}

/**
 * US Get Item Price (International): `PriceList.Price` holds one row per destination
 * country, as an object when there is a single country and an array otherwise (§2 quirk);
 * a bare array under `PriceList` is tolerated as well.
 */
export function parseUsPrice(json: unknown): ParsedPrice | undefined {
  if (!isRecord(json)) return undefined;
  const itemNumber = asString(getField(json, "ItemNumber"));
  const sellerPartNumber = asString(getField(json, "SellerPartNumber"));
  const priceList = getField(json, "PriceList");
  if (itemNumber === undefined && sellerPartNumber === undefined && priceList === undefined) {
    return undefined;
  }
  const rows = Array.isArray(priceList) ? priceList : asArray(getField(priceList, "Price"));
  return { itemNumber, sellerPartNumber, entries: rows.filter(isRecord).map(parseEntry) };
}

/** B2B/CAN Get Item Price: one flat record (no country list, no `Currency`). */
export function parseFlatPrice(json: unknown): ParsedPrice | undefined {
  if (!isRecord(json)) return undefined;
  const itemNumber = asString(getField(json, "ItemNumber"));
  const sellerPartNumber = asString(getField(json, "SellerPartNumber"));
  const sellingPrice = getField(json, "SellingPrice");
  if (itemNumber === undefined && sellerPartNumber === undefined && sellingPrice === undefined) {
    return undefined;
  }
  return {
    itemNumber,
    sellerPartNumber,
    shippedByNewegg: asBoolean(getField(json, "ShipByNewegg")),
    entries: [parseEntry(json)],
  };
}
