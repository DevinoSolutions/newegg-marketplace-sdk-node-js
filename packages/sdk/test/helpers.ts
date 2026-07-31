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
  feedSubmit: "datafeedmgmt/feeds/submitfeed",
  feedStatus: "datafeedmgmt/feeds/status",
  feedResult: "datafeedmgmt/feeds/result/",
  serviceStatus: "servicestatus",
  orderInfo: /ordermgmt\/order\/orderinfo\?/,
  orderStatus: /ordermgmt\/orderstatus\/orders\//,
  orderConfirmation: /ordermgmt\/orderstatus\/orders\/confirmation/,
  killItem: /ordermgmt\/killitem\/orders\//,
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
