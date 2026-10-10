import type {
  ItemCondition,
  ItemIdentifier,
  NeweggMarketplace,
  NormalizedPriceUpdate,
  PricePromotion,
  WarehouseInventory,
} from "../types.js";

/** A fully-described HTTP request the client can execute; `sellerid` is added by the client. */
export interface RequestSpec {
  method: "GET" | "POST" | "PUT";
  /** Path relative to the client base URL, including the marketplace prefix. Lowercase, no leading slash. */
  path: string;
  /** Extra query params (excluding `sellerid`). */
  query?: Record<string, string>;
  /** Structured body; JSON-serialized by the client unless `bodyText` is provided. */
  body?: unknown;
  /** Pre-serialized body bytes (feeds use this so the payload hash matches exactly what is sent). */
  bodyText?: string;
  /** Raw query text appended verbatim after the built query string (e.g. the bare `v2`
   * template flag of the item-creation feeds — URLSearchParams would emit `v2=`). */
  rawQuerySuffix?: string;
}

/** Normalized single-item read result (before the API attaches marketplace/correlation). */
export interface ParsedItem {
  itemNumber?: string;
  sellerPartNumber?: string;
  upc?: string;
  condition?: ItemCondition;
  active?: boolean;
  totalAvailableQuantity: number;
  warehouses: WarehouseInventory[];
}

/** One normalized price record (a US destination country, or the B2B/CAN item itself). */
export interface ParsedPriceEntry {
  countryCode?: string;
  currency?: string;
  active?: boolean;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  freeShipping?: boolean;
  promotions: PricePromotion[];
  limitQuantity?: number;
}

/** Normalized Get Item Price result (before the API attaches marketplace/correlation). */
export interface ParsedPrice {
  itemNumber?: string;
  sellerPartNumber?: string;
  /** B2B/CAN only (`ShipByNewegg`). */
  shippedByNewegg?: boolean;
  entries: ParsedPriceEntry[];
}

/** Normalized price-write response (before the API attaches outcome status). */
export interface ParsedPriceUpdate {
  itemNumber?: string;
  sellerPartNumber?: string;
  /** B2B/CAN `Result` (1 success / 0 failure); undefined when the response carries none. */
  success?: boolean;
  /** The selling price the write response echoes (country-matched on US). */
  sellingPrice?: number;
}

/** A batch of direct-update entries sharing one identifier (US groups multiple warehouses). */
export interface DirectUpdateGroup {
  identifier: ItemIdentifier;
  entries: Array<{ warehouseLocation?: string; quantity: number }>;
}

/** A single feed line item (already reduced to feed-relevant fields). */
export interface FeedItemInput {
  sellerPartNumber: string;
  neweggItemNumber?: string;
  warehouseLocation?: string;
  quantity: number;
}

/**
 * Per-marketplace behaviour: endpoint/method/query builders, request serializers, tolerant
 * response normalizers, and feed-envelope construction. One implementation per marketplace.
 */
export interface PlatformAdapter {
  readonly marketplace: NeweggMarketplace;
  /** URL prefix after the base URL: "" (US), "b2b/", or "can/". */
  readonly prefix: string;
  /** US requires an explicit warehouse on every update; B2B/CAN use the default warehouse. */
  readonly requiresWarehouseForUpdate: boolean;
  /** INVENTORY_DATA (US) or INVENTORY_AND_PRICE_DATA (B2B/CAN). */
  readonly feedRequestType: string;

  getItemRequest(identifier: ItemIdentifier, warehouses: string[] | undefined): RequestSpec;
  parseItem(json: unknown): ParsedItem | undefined;

  getManyRequest(typeCode: string, values: string[], warehouses: string[] | undefined): RequestSpec;
  parseBatch(json: unknown): { items: ParsedItem[]; totalCount?: number };

  directUpdateRequest(group: DirectUpdateGroup): RequestSpec;

  /** Get Item Price — a READ on every platform despite the PUT/POST verbs (contracts §15). */
  getPriceRequest(identifier: ItemIdentifier, countries: string[] | undefined): RequestSpec;
  parsePrice(json: unknown): ParsedPrice | undefined;

  /**
   * WRITE: assigns ONE selling price. Sends the identifier plus `SellingPrice` (US: with the
   * country/currency) and nothing else - never Active, MAP, MSRP, shipping, limits or
   * inventory (contracts §16).
   */
  priceUpdateRequest(update: NormalizedPriceUpdate): RequestSpec;
  parsePriceUpdate(json: unknown, update: NormalizedPriceUpdate): ParsedPriceUpdate;

  buildFeedEnvelope(items: FeedItemInput[]): unknown;
}
