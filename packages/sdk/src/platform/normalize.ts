import type { ItemIdentifier, WarehouseInventory } from "../types.js";
import type { ParsedItem } from "./types.js";
import { codeToCondition } from "../schemas/condition.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";

/** Maps a normalized identifier type to Newegg's numeric `Type` code. */
export function identifierTypeCode(type: ItemIdentifier["type"]): string {
  switch (type) {
    case "neweggItemNumber":
      return "0";
    case "sellerPartNumber":
      return "1";
    case "upc":
      return "2";
  }
}

function fulfillmentFromCode(code: string | undefined): "seller" | "newegg" {
  return code === "1" ? "newegg" : "seller";
}

function conditionFrom(raw: unknown): ReturnType<typeof codeToCondition> {
  if (typeof raw === "number" || typeof raw === "string") return codeToCondition(raw);
  return undefined;
}

/** Extracts inventory entries from a US `InventoryAllocation` (array in batch, `{Inventory}` in single). */
function usAllocationEntries(allocation: unknown): unknown[] {
  if (Array.isArray(allocation)) return allocation;
  return asArray(getField(allocation, "Inventory"));
}

/**
 * Normalizes a US inventory item. Handles both the single-item shape
 * (`InventoryAllocation.Inventory[]`) and the batch shape (`InventoryAllocation[]`).
 */
export function parseUsItem(raw: unknown): ParsedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const itemNumber = asString(getField(raw, "ItemNumber"));
  const sellerPartNumber = asString(getField(raw, "SellerPartNumber"));
  const allocation = getField(raw, "InventoryAllocation");
  if (itemNumber === undefined && sellerPartNumber === undefined && allocation === undefined) {
    return undefined;
  }
  const condition = conditionFrom(getField(raw, "Condition"));
  const warehouses: WarehouseInventory[] = [];
  let total = 0;
  for (const entry of usAllocationEntries(allocation)) {
    const location = asString(getField(entry, "WarehouseLocation"));
    if (location === undefined) continue;
    const quantity = asNumber(getField(entry, "AvailableQuantity")) ?? 0;
    const fulfillment = fulfillmentFromCode(asString(getField(entry, "FulfillmentOption")));
    warehouses.push({ location, quantity, fulfillment });
    total += quantity;
  }
  return { itemNumber, sellerPartNumber, condition, totalAvailableQuantity: total, warehouses };
}

/**
 * Normalizes a flat B2B/CAN inventory item: a synthetic `default` warehouse entry for the
 * item's `AvailableQuantity`, plus any `WarehouseAllocation` breakdown entries.
 */
export function parseFlatItem(raw: unknown): ParsedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const itemNumber = asString(getField(raw, "ItemNumber"));
  const sellerPartNumber = asString(getField(raw, "SellerPartNumber"));
  const availableRaw = getField(raw, "AvailableQuantity");
  if (itemNumber === undefined && sellerPartNumber === undefined && availableRaw === undefined) {
    return undefined;
  }
  const available = asNumber(availableRaw) ?? 0;
  const fulfillment = fulfillmentFromCode(asString(getField(raw, "FulfillmentOption")));
  const active = asBoolean(getField(raw, "Active"));
  const warehouses: WarehouseInventory[] = [
    { location: "default", quantity: available, fulfillment },
  ];
  const allocation = getField(raw, "WarehouseAllocation");
  for (const entry of asArray(getField(allocation, "Warehouse"))) {
    const code = asString(getField(entry, "WarehouseCode"));
    if (code === undefined) continue;
    const quantity = asNumber(getField(entry, "Quantity")) ?? 0;
    warehouses.push({ location: code, quantity, fulfillment });
  }
  return { itemNumber, sellerPartNumber, active, totalAvailableQuantity: available, warehouses };
}

/** Extracts the item list + total count from a batch inventory envelope. */
export function extractBatch(json: unknown): { itemsRaw: unknown[]; totalCount?: number } {
  const body = getField(json, "ResponseBody") ?? json;
  return {
    itemsRaw: asArray(getField(body, "ItemList")),
    totalCount: asNumber(getField(body, "TotalCount")),
  };
}

export function isDefinedItem(item: ParsedItem | undefined): item is ParsedItem {
  return item !== undefined;
}
