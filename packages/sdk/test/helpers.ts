import { crc32, deflateRawSync } from "node:zlib";
import { createNeweggClient } from "../src/index.js";
import type {
  NeweggClient,
  NeweggClientConfig,
  NeweggLogger,
  NeweggMarketplace,
} from "../src/index.js";
import { createMockFetch, type MockRoute, type RecordedCall } from "../src/testing/index.js";

export const TEST_API_KEY = "test-api-key-abc123";
export const TEST_SECRET_KEY = "test-secret-key-xyz789";

/** Builds a client wired to a mock fetch, returning the client and its recorded calls. */
export function makeClient(
  marketplace: NeweggMarketplace,
  routes: MockRoute[],
  config: Partial<NeweggClientConfig> = {},
): { client: NeweggClient; calls: RecordedCall[] } {
  const { fetch, calls } = createMockFetch(routes);
  const client = createNeweggClient({
    sellerId: "A006",
    apiKey: TEST_API_KEY,
    secretKey: TEST_SECRET_KEY,
    marketplace,
    fetch,
    // Fast, deterministic retries in tests.
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    ...config,
  });
  return { client, calls };
}

/** A logger that records every event + fields for redaction/assertion checks. */
export function capturingLogger(): {
  logger: NeweggLogger;
  entries: Array<{ level: string; event: string; fields?: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, event, fields });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    entries,
  };
}

/** Path patterns keyed to distinct endpoints (trailing `?` disambiguates inventory vs inventorylist). */
export const paths = {
  usInventory: /international\/inventory\?/,
  usInventoryList: /international\/inventorylist\?/,
  itemInventory: /contentmgmt\/item\/inventory\?/,
  itemInventoryList: /contentmgmt\/item\/inventorylist\?/,
  itemInventoryAndPrice: /contentmgmt\/item\/inventoryandprice\?/,
  // Get Item Price (a READ; §15). The US path is READ-on-PUT / WRITE-on-POST.
  usPrice: /international\/price\?/,
  itemPrice: /contentmgmt\/item\/price\?/,
  feedSubmit: "datafeedmgmt/feeds/submitfeed",
  feedStatus: "datafeedmgmt/feeds/status",
  feedResult: "datafeedmgmt/feeds/result/",
  serviceStatus: "servicestatus",
  orderInfo: /ordermgmt\/order\/orderinfo\?/,
  orderStatus: /ordermgmt\/orderstatus\/orders\//,
  orderConfirmation: /ordermgmt\/orderstatus\/orders\/confirmation/,
  killItem: /ordermgmt\/killitem\/orders\//,
  // Service Management READS (§18). The paths are literal substrings, so the (WRITE) newrma /
  // updaterma / courtesyrefund/new endpoints can never match these patterns.
  rmaInfo: /servicemgmt\/rma\/rmainfo\?/,
  courtesyRefundInfo: /servicemgmt\/courtesyrefund\/info\?/,
  courtesyRefundStatus: /servicemgmt\/courtesyrefund\/requeststatus\?/,
  reportSubmit: /reportmgmt\/report\/submitrequest\?/,
  reportStatus: /reportmgmt\/report\/status\?/,
  reportResult: /reportmgmt\/report\/result\?/,
  // Public storefront (UNOFFICIAL, contracts §14) — different origin, no credentials.
  moreBuyingOptions: /product\/api\/MoreBuyingOptions/,
  storefrontProductPage: /^\/p\//,
} as const;

/** §5.1 US single-item read sample (numbers as strings). */
export const US_SINGLE_ITEM = {
  SellerID: "A006",
  ItemNumber: "9SIA0060884598",
  SellerPartNumber: "A006BSP3",
  InventoryAllocation: {
    Inventory: [
      { WarehouseLocation: "USA", FulfillmentOption: "0", AvailableQuantity: "107" },
      {
        WarehouseLocation: "USA",
        FulfillmentOption: "1",
        AvailableQuantity: "40",
        WarehouseAllocation: { Warehouse: [{ WarehouseCode: "07", Quantity: "3" }] },
      },
    ],
  },
};

/** §5.2 B2B/CAN single-item read sample (mixed number/string types). */
export const ITEM_SINGLE_ITEM = {
  Active: "0",
  ItemNumber: "9SIA0060884598",
  SellerID: "A006",
  SellerPartNumber: "A006BSP3",
  FulfillmentOption: "1",
  AvailableQuantity: 71,
  WarehouseAllocation: { Warehouse: [{ WarehouseCode: "35", Quantity: "3" }] },
};

/** §15.1 US Get Item Price sample (everything a string; the IRL row omits OnPromotion). */
export const US_PRICE_SAMPLE = {
  SellerID: "A006",
  ItemNumber: "9SIA0060884598",
  SellerPartNumber: "A006testitem201201021459",
  PriceList: {
    Price: [
      {
        CountryCode: "USA",
        Currency: "USD",
        Active: "0",
        MAP: "25.99",
        CheckoutMAP: "0",
        SellingPrice: "20.92",
        EnableFreeShipping: "1",
        OnPromotion: "1,5",
        LimitQuantity: "2",
      },
      {
        CountryCode: "IND",
        Currency: "INR",
        Active: "1",
        MAP: "25.99",
        CheckoutMAP: "0",
        SellingPrice: "389.92",
        EnableFreeShipping: "0",
        OnPromotion: "1,5",
        LimitQuantity: "2",
      },
      {
        CountryCode: "IRL",
        Currency: "EUR",
        Active: "0",
        MAP: "25.99",
        CheckoutMAP: "0",
        SellingPrice: "19.92",
        EnableFreeShipping: "0",
        LimitQuantity: "2",
      },
    ],
  },
};

/** §15.2 B2B/CAN Get Item Price sample (note the mixed string/number types). */
export const ITEM_PRICE_SAMPLE = {
  Active: "0",
  ItemNumber: "9SIA0060884598",
  SellerID: "A006",
  SellerPartNumber: "A006testitem201201021459",
  ShipByNewegg: "1",
  EnableFreeShipping: "1",
  MAP: 25.99,
  CheckoutMAP: 0,
  OnPromotion: "1,5",
  SellingPrice: 20.92,
  LimitQuantity: 1,
};

/** Builds a successful feed-submit response body with the given request id. */
export function feedSubmitBody(requestId: string, status = "SUBMITTED"): unknown {
  return {
    IsSuccess: true,
    OperationType: "SubmitFeedResponse",
    ResponseBody: {
      ResponseList: [
        {
          RequestDate: "2/22/2012 17:24:35",
          RequestId: requestId,
          RequestStatus: status,
          RequestType: "INVENTORY_DATA",
        },
      ],
    },
    SellerID: "A006",
  };
}

// ---------------------------------------------------------------------------
// zip fixture builder (store or deflate; local headers + central directory + EOCD)
// ---------------------------------------------------------------------------
export function buildZip(files: Array<{ name: string; data: string; method?: 0 | 8 }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data, "utf8");
    const method = file.method ?? 8;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, eocd]);
}
