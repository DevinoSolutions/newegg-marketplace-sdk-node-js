import type { FeedItemInput } from "./types.js";

/**
 * US inventory feed envelope (`INVENTORY_DATA`, DocumentVersion 2.0). `Item` is always
 * serialized as an array; `FulfillmentOption` is always `"Seller"` (feeds cannot touch SBN).
 */
export function buildUsFeedEnvelope(items: FeedItemInput[]): unknown {
  return {
    NeweggEnvelope: {
      Header: { DocumentVersion: "2.0" },
      MessageType: "Inventory",
      Message: {
        Inventory: {
          Item: items.map((item) => {
            const line: Record<string, unknown> = { SellerPartNumber: item.sellerPartNumber };
            if (item.neweggItemNumber) line.NeweggItemNumber = item.neweggItemNumber;
            line.WarehouseLocation = item.warehouseLocation;
            line.FulfillmentOption = "Seller";
            line.Inventory = String(item.quantity);
            return line;
          }),
        },
      },
    },
  };
}

/**
 * B2B/CAN inventory-and-price feed envelope (`INVENTORY_AND_PRICE_DATA`, DocumentVersion 1.0),
 * inventory-only use. `Overwrite` is hard-coded to `"No"` — there is no code path that can
 * emit `"Yes"` (which would deactivate unlisted items). Only `SellerPartNumber`,
 * optional `NeweggItemNumber`, and `Inventory` are emitted per item.
 */
export function buildItemFeedEnvelope(items: FeedItemInput[]): unknown {
  return {
    NeweggEnvelope: {
      Header: { DocumentVersion: "1.0" },
      MessageType: "Inventory",
      Overwrite: "No",
      Message: {
        Inventory: {
          Item: items.map((item) => {
            const line: Record<string, unknown> = { SellerPartNumber: item.sellerPartNumber };
            if (item.neweggItemNumber) line.NeweggItemNumber = item.neweggItemNumber;
            line.Inventory = String(item.quantity);
            return line;
          }),
        },
      },
    },
  };
}
