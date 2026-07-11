import type { ItemIdentifier, NeweggMarketplace } from "../types.js";
import type { DirectUpdateGroup, FeedItemInput, PlatformAdapter, RequestSpec } from "./types.js";
import { buildItemFeedEnvelope } from "./feed-envelope.js";
import { extractBatch, identifierTypeCode, isDefinedItem, parseFlatItem } from "./normalize.js";
import { B2B_CA_FEED_REQUEST_TYPE } from "../feeds/constants.js";

/**
 * Shared adapter for the "item" endpoints used by B2B (`neweggbusiness.com`) and CA
 * (`newegg.ca`). They differ only in URL prefix; both use `version=304` on the single-item
 * read and the inventory-and-price endpoint (inventory-only subset) for direct writes.
 */
export function createItemAdapter(marketplace: NeweggMarketplace, prefix: string): PlatformAdapter {
  const singleInventoryPath = `${prefix}contentmgmt/item/inventory`;
  const inventoryListPath = `${prefix}contentmgmt/item/inventorylist`;
  const inventoryAndPricePath = `${prefix}contentmgmt/item/inventoryandprice`;

  return {
    marketplace,
    prefix,
    requiresWarehouseForUpdate: false,
    feedRequestType: B2B_CA_FEED_REQUEST_TYPE,

    getItemRequest(identifier: ItemIdentifier): RequestSpec {
      return {
        method: "POST",
        path: singleInventoryPath,
        query: { version: "304" },
        body: { Type: identifierTypeCode(identifier.type), Value: identifier.value },
      };
    },

    parseItem: parseFlatItem,

    getManyRequest(typeCode: string, values: string[]): RequestSpec {
      return {
        method: "POST",
        path: inventoryListPath,
        body: { Type: typeCode, Values: values },
      };
    },

    parseBatch(json: unknown) {
      const { itemsRaw, totalCount } = extractBatch(json);
      return { items: itemsRaw.map(parseFlatItem).filter(isDefinedItem), totalCount };
    },

    directUpdateRequest(group: DirectUpdateGroup): RequestSpec {
      const identifier = group.identifier;
      const quantity = group.entries[0]?.quantity ?? 0;
      // Inventory-only subset: Type/Value/Inventory ONLY. No Active, price, or FulfillmentOption.
      return {
        method: "PUT",
        path: inventoryAndPricePath,
        body: {
          Type: identifierTypeCode(identifier.type),
          Value: identifier.value,
          Inventory: String(quantity),
        },
      };
    },

    buildFeedEnvelope(items: FeedItemInput[]): unknown {
      return buildItemFeedEnvelope(items);
    },
  };
}
