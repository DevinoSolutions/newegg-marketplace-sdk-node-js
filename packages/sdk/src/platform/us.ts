import type { ItemIdentifier, NormalizedPriceUpdate } from "../types.js";
import type {
  DirectUpdateGroup,
  FeedItemInput,
  ParsedPriceUpdate,
  PlatformAdapter,
  RequestSpec,
} from "./types.js";
import { conditionToCode } from "../schemas/condition.js";
import { buildUsFeedEnvelope } from "./feed-envelope.js";
import { parseUsPrice, parseUsPriceUpdate } from "./price.js";
import { extractBatch, identifierTypeCode, isDefinedItem, parseUsItem } from "./normalize.js";
import { US_FEED_REQUEST_TYPE } from "../feeds/constants.js";

const INTERNATIONAL_INVENTORY_PATH = "contentmgmt/item/international/inventory";
const INTERNATIONAL_PRICE_PATH = "contentmgmt/item/international/price";
const INTERNATIONAL_INVENTORY_LIST_PATH = "contentmgmt/item/international/inventorylist";

/** US (`newegg.com`) adapter. International inventory endpoints; method selects read vs write. */
export const usAdapter: PlatformAdapter = {
  marketplace: "us",
  prefix: "",
  requiresWarehouseForUpdate: true,
  feedRequestType: US_FEED_REQUEST_TYPE,

  getItemRequest(identifier: ItemIdentifier, warehouses: string[] | undefined): RequestSpec {
    const body: Record<string, unknown> = {
      Type: identifierTypeCode(identifier.type),
      Value: identifier.value,
    };
    if (warehouses && warehouses.length > 0) {
      body.WarehouseList = { WarehouseLocation: warehouses };
    }
    return { method: "PUT", path: INTERNATIONAL_INVENTORY_PATH, body };
  },

  parseItem: parseUsItem,

  getManyRequest(
    typeCode: string,
    values: string[],
    warehouses: string[] | undefined,
  ): RequestSpec {
    const body: Record<string, unknown> = { Type: typeCode, Values: values };
    if (warehouses && warehouses.length > 0) body.WarehouseList = warehouses;
    return { method: "POST", path: INTERNATIONAL_INVENTORY_LIST_PATH, body };
  },

  parseBatch(json: unknown) {
    const { itemsRaw, totalCount } = extractBatch(json);
    return { items: itemsRaw.map(parseUsItem).filter(isDefinedItem), totalCount };
  },

  directUpdateRequest(group: DirectUpdateGroup): RequestSpec {
    const identifier = group.identifier;
    const body: Record<string, unknown> = {
      Type: identifierTypeCode(identifier.type),
      Value: identifier.value,
    };
    if (identifier.type === "upc" && identifier.condition) {
      body.Condition = conditionToCode(identifier.condition);
    }
    body.InventoryList = {
      Inventory: group.entries.map((entry) => ({
        WarehouseLocation: entry.warehouseLocation,
        AvailableQuantity: String(entry.quantity),
      })),
    };
    return { method: "POST", path: INTERNATIONAL_INVENTORY_PATH, body };
  },

  getPriceRequest(identifier: ItemIdentifier, countries: string[] | undefined): RequestSpec {
    const body: Record<string, unknown> = {
      Type: identifierTypeCode(identifier.type),
      Value: identifier.value,
    };
    if (identifier.type === "upc" && identifier.condition) {
      body.Condition = conditionToCode(identifier.condition);
    }
    if (countries && countries.length > 0) {
      body.CountryList = { CountryCode: countries };
    }
    // READ: Get Item Price is PUT on this path; the SAME path is a price WRITE on POST (§15.1).
    return { method: "PUT", path: INTERNATIONAL_PRICE_PATH, body };
  },

  parsePrice: parseUsPrice,

  priceUpdateRequest(update: NormalizedPriceUpdate): RequestSpec {
    const body: Record<string, unknown> = {
      Type: identifierTypeCode(update.identifier.type),
      Value: update.identifier.value,
    };
    if (update.identifier.type === "upc" && update.identifier.condition) {
      body.Condition = conditionToCode(update.identifier.condition);
    }
    // ONLY the price travels: no Active / MAP / CheckoutMAP / shipping / LimitQuantity, so
    // nothing else on the listing can change. WRITE: POST on the same URL the price READ PUTs.
    body.PriceList = {
      Price: [
        {
          CountryCode: update.countryCode,
          Currency: update.currency,
          SellingPrice: update.sellingPrice.toFixed(2),
        },
      ],
    };
    return { method: "POST", path: INTERNATIONAL_PRICE_PATH, body };
  },

  parsePriceUpdate(json: unknown, update: NormalizedPriceUpdate): ParsedPriceUpdate {
    return parseUsPriceUpdate(json, update.countryCode);
  },

  buildFeedEnvelope(items: FeedItemInput[]): unknown {
    return buildUsFeedEnvelope(items);
  },
};
