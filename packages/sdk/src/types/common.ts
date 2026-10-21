/** Shared marketplace, request-option and item-identifier types. Re-exported from `../types.ts`. */

// ----------------------------------------------------------------------------
// marketplaces & service domains
// ----------------------------------------------------------------------------
export type NeweggMarketplace = "us" | "b2b" | "ca";

export type NeweggServiceDomain =
  | "contentmgmt"
  | "ordermgmt"
  | "datafeedmgmt"
  | "servicemgmt"
  | "reportmgmt"
  | "sellermgmt"
  | "sbnmgmt"
  | "shippingservice";

// ----------------------------------------------------------------------------
// shared request options
// ----------------------------------------------------------------------------
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Auto-generated UUID when omitted. */
  correlationId?: string;
  /** Attach sanitized raw response payload to results (never surfaced via MCP). */
  includeRaw?: boolean;
}

// ----------------------------------------------------------------------------
// identifiers & updates (normalized domain types)
// ----------------------------------------------------------------------------
export type ItemCondition =
  "new" | "refurbished" | "usedLikeNew" | "usedVeryGood" | "usedGood" | "usedAcceptable";

export type ItemIdentifier =
  | { type: "sellerPartNumber"; value: string }
  | { type: "neweggItemNumber"; value: string }
  | { type: "upc"; value: string; condition?: ItemCondition };

export interface InventoryUpdate {
  identifier: ItemIdentifier;
  /** Non-negative safe integer; 0 is valid and meaningful. */
  quantity: number;
  /** ISO 3166-1 alpha-3, uppercase; required for US ops. */
  warehouseLocation?: string;
  fulfillmentOption?: "Seller";
  /** Caller bookkeeping, never sent to Newegg. */
  metadata?: Record<string, string>;
}
