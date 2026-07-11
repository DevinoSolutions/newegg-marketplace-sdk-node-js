import type { ItemIdentifier } from "../types.js";
import type { DirectUpdateGroup, FeedItemInput, PlatformAdapter, RequestSpec } from "./types.js";
import { conditionToCode } from "../schemas/condition.js";
import { buildUsFeedEnvelope } from "./feed-envelope.js";
import { extractBatch, identifierTypeCode, isDefinedItem, parseUsItem } from "./normalize.js";
import { US_FEED_REQUEST_TYPE } from "../feeds/constants.js";

const INTERNATIONAL_INVENTORY_PATH = "contentmgmt/item/international/inventory";
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

  buildFeedEnvelope(items: FeedItemInput[]): unknown {
    return buildUsFeedEnvelope(items);
  },
};
