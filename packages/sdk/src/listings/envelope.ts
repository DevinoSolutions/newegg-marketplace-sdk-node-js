import type { NormalizedCreateListing } from "../types.js";
import { EXISTING_ITEM_DOCUMENT_VERSION, EXISTING_ITEM_MESSAGE_TYPE } from "./constants.js";

/** Money as Newegg expects it: plain 2-decimal string, no separators. Rounds to the cent
 * first so float artifacts (e.g. 2.675 stored as 2.67499…) don't truncate the wrong way. */
function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function basicInfo(item: NormalizedCreateListing): Record<string, unknown> {
  const info: Record<string, unknown> = {
    SellerPartNumber: item.sellerPartNumber,
    Manufacturer: item.manufacturer,
  };
  if (item.manufacturerPartNumber !== undefined)
    info.ManufacturerPartsNumber = item.manufacturerPartNumber;
  if (item.upc !== undefined) info.UPCOrISBN = item.upc;
  if (item.neweggItemNumber !== undefined) info.NeweggItemNumber = item.neweggItemNumber;
  if (item.currency !== undefined) info.Currency = item.currency;
  if (item.msrp !== undefined) info.MSRP = money(item.msrp);
  if (item.map !== undefined) info.MAP = money(item.map);
  if (item.checkoutMap !== undefined) info.CheckoutMAP = item.checkoutMap ? "True" : "False";
  info.SellingPrice = money(item.sellingPrice);
  info.Shipping = item.shipping;
  info.Inventory = String(item.quantity);
  info.ItemCondition = item.condition;
  info.PacksOrSets = String(item.packsOrSets);
  info.ActivationMark = item.activate ? "True" : "False";
  if (item.countryOfOrigin !== undefined) info.CountryOfOrigin = item.countryOfOrigin;
  if (item.leadTime !== undefined) info.LeadTime = String(item.leadTime);
  if (item.shippingTemplate !== undefined) info.ShippingTemplate = item.shippingTemplate;
  return info;
}

/** Existing Item Creation (v2) JSON envelope for one chunk (contracts §13.2).
 * JSON serialization: `SummaryInfo` (XML-only) is omitted; there is NO `Overwrite` in v2. */
export function buildExistingItemEnvelope(items: NormalizedCreateListing[]): unknown {
  return {
    NeweggEnvelope: {
      Header: { DocumentVersion: EXISTING_ITEM_DOCUMENT_VERSION },
      MessageType: EXISTING_ITEM_MESSAGE_TYPE,
      Message: { Itemfeed: [{ Item: items.map((item) => ({ BasicInfo: basicInfo(item) })) }] },
    },
  };
}
