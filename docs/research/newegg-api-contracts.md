# Newegg Marketplace API — Verified Wire Contracts

> Extracted 2026-07-10 from the official Newegg Developer Portal
> (https://developer.newegg.com/newegg_marketplace_api/). Every endpoint, method and
> body below was verified against the official sample requests/responses on the pages
> cited. Items marked **ASSUMPTION** were not fully specified by the documentation and
> are isolated behind named adapters in the SDK (see `docs/platform-differences.md`).

## 1. Authentication (all platforms)

| Concern    | Value                                                                     |
| ---------- | ------------------------------------------------------------------------- |
| API key    | `Authorization: {apiKey}` request header (raw value, no scheme prefix)    |
| Secret key | `SecretKey: {secretKey}` request header                                   |
| Seller     | `?sellerid={SellerID}` query parameter (value may keep its original case) |
| Media type | `Content-Type: application/json` + `Accept: application/json`             |
| Transport  | HTTPS only                                                                |

Auth error bodies (JSON **array**):
`[{"Code":"InvalidConsumerKey","Message":"The provided consumer key is malformed or otherwise invalid."}]`,
`[{"Code":"InvalidToken","Message":"Invalid secret key."}]`.
The API gateway may also answer `401` with the **plain-text** body `Gateway: Seller Auth failed.`
(observed live 2026-07-10) — error parsing must tolerate non-JSON bodies.

Other observed error shapes:

- Single JSON object: `{"Code":"CT002","Message":"Invalid SellerPartNumber"}`
- JSON array: `[{"Code":"CE001","Message":"SellerID cannot be null or empty"}]`
- XML: `<?xml version="1.0"?>...<Code>DF006</Code>...` (returned when `Accept` handling falls back)

## 2. Base URLs and general rules

| Platform                   | Prefix                                    |
| -------------------------- | ----------------------------------------- |
| Newegg.com (`us`)          | `https://api.newegg.com/marketplace/`     |
| Neweggbusiness.com (`b2b`) | `https://api.newegg.com/marketplace/b2b/` |
| Newegg.ca (`ca`)           | `https://api.newegg.com/marketplace/can/` |

- Endpoints are **case-sensitive**; the whole URL must be lowercase **except the Seller ID value**.
- No blank spaces / line breaks in URLs.
- **All datetime fields are Pacific Time** (docs say "Pacific Standard Time") in requests
  and responses, e.g. `2/22/2012 17:24:35`. Response timestamps sometimes carry an
  explicit offset (`2022-04-20T23:46:41.7786361-07:00`).
- API credentials are **platform-specific**: a US key is not valid on `/b2b/` or `/can/`.

## 3. Throttling

- Rate limiting is **per seller**, per API function, in one-minute windows.
- Data-feed functions add hourly request limits and per-request size limits.
- On exceeding a limit: HTTP **429** with body `[{"Code":"429","Message":"Too many request."}]`.
- Data-feed hourly-allowance error (code **DF012**):
  `[{"Code":"DF012","Message":"Your feed with request ID: 2291326430 exceeded the hourly allowance and cannot be processed. Please submit your feed again after 2016-12-16 11:05:00."}]`
  (timestamp is Pacific Time).
- Diagnostic response headers (all confirmed on the throttling page):
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-ResetTime`,
  `X-RecordCount-Limit`, `X-RecordCount-Remaining`, `X-RecordCount-ResetTime`.

## 4. Item identifier `Type` codes

`0` = Newegg Item Number, `1` = Seller Part Number, `2` = UPC. Verified in every official
sample (`"Type": "1"` always paired with a seller part number value). `Condition` applies
when the identifier is UPC.

**ASSUMPTION (condition codes)**: `1`=New, `2`=Refurbished, `3`=Used-Like New,
`4`=Used-Very Good, `5`=Used-Good, `6`=Used-Acceptable. The docs' condition table did not
render in extraction; the mapping matches Newegg's item-condition codes used across the
Item Management APIs (batch read sample returns `"Condition": 1` for a new item). Isolated
in `packages/sdk/src/schemas/condition.ts`. _Update 2026-10-10:_ the Get Item Price,
Update Item Price and Update Inventory and Price pages' `Condition` tables DO render and list
exactly these codes (§15.2), so the mapping is now documented rather than assumed.

## 5. Inventory reads

### 5.1 US single item — Get Inventory (International)

```
PUT https://api.newegg.com/marketplace/contentmgmt/item/international/inventory?sellerid={SellerID}
```

Request:

```json
{
  "Type": "1",
  "Value": "A006testitem201201021459",
  "WarehouseList": { "WarehouseLocation": ["USA", "AUS"] }
}
```

Response (note: numbers as strings):

```json
{
  "SellerID": "A006",
  "ItemNumber": "9SIA0060884598",
  "SellerPartNumber": "...",
  "InventoryAllocation": {
    "Inventory": [
      { "WarehouseLocation": "USA", "FulfillmentOption": "0", "AvailableQuantity": "107" },
      {
        "WarehouseLocation": "USA",
        "FulfillmentOption": "1",
        "AvailableQuantity": "40",
        "WarehouseAllocation": { "Warehouse": [{ "WarehouseCode": "07", "Quantity": "3" }] }
      }
    ]
  }
}
```

`FulfillmentOption`: `"0"` = shipped by seller, `"1"` = shipped by Newegg (SBN); SBN
entries break down per Newegg `WarehouseCode`.

### 5.2 B2B / CAN single item — Get Item Inventory

```
POST https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventory?sellerid={SellerID}&version=304
POST https://api.newegg.com/marketplace/can/contentmgmt/item/inventory?sellerid={SellerID}&version=304
```

Request: `{ "Type": "1", "Value": "A006testitem201201021459" }`

Response (**mixed types on the wire** — `AvailableQuantity` observed both as number `71`
and string `"50"`):

```json
{
  "Active": "0",
  "ItemNumber": "9SIA0060884598",
  "SellerID": "A006",
  "SellerPartNumber": "...",
  "FulfillmentOption": "1",
  "AvailableQuantity": 71,
  "WarehouseAllocation": { "Warehouse": [{ "WarehouseCode": "35", "Quantity": "3" }] }
}
```

The XML sample also shows `WarehouseCode` `"SBS"` (shipped-by-seller bucket) inside
`WarehouseAllocation`. The `version=304` query parameter is part of the documented URL.

**Verified live (CA, 2026-07-17) — identifier resolution:** `Type: "0"` (Newegg item number)
resolves the SELLER's offer numbers (`9SI…` form) only. The catalog's product-form numbers
(`20-xxx-xxx`, as returned by the Item Lookup Report §12) return CT026 "item does not exist in
your account" whether or not the seller has an offer on that product — they are NOT valid
inventory identifiers. To check "do I already list this product?", read by `Type: "2"` (UPC)
or `Type: "1"` (seller part number). Not-found error codes differ by identifier type
(verified live, 2026-07-18): SKU/item-number reads fail CT026, while UPC reads for a product
the seller has no offer on fail **CT010** (9/9 observed; CT010 also covers malformed UPC
values — the two are indistinguishable on the wire). Also: while an item is deactivated,
reads report `AvailableQuantity` 0, which may mask the stored quantity.

### 5.3 US batch — Get Batch Inventory (International)

```
POST https://api.newegg.com/marketplace/contentmgmt/item/international/inventorylist?sellerid={SellerID}
```

Request: `{ "Type": "1", "Values": ["SKU-1","SKU-2"], "WarehouseList": ["USA","AUS"] }`
(`WarehouseList` here is a plain string array — different from the single-item read.)

Response envelope:

```json
{
  "ResponseBody": {
    "ItemList": [
      {
        "ItemNumber": "...",
        "SellerPartNumber": "...",
        "Condition": 1,
        "InventoryAllocation": [
          { "WarehouseLocation": "USA", "FulfillmentOption": "0", "AvailableQuantity": 10 }
        ]
      }
    ],
    "TotalCount": 3
  },
  "IsSuccess": true,
  "OperationType": "GetInventoryList",
  "SellerID": "A006",
  "ResponseDate": "2022-04-20T23:46:41.7786361-07:00"
}
```

**ASSUMPTION (batch size)**: the documented per-request maximum for `Values` did not
render in extraction; the SDK chunks batch reads at **100** identifiers per request
(constant `GET_BATCH_INVENTORY_MAX_VALUES`, documented and configurable).

### 5.4 B2B / CAN batch — Get Batch Inventory

```
POST https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventorylist?sellerid={SellerID}
POST https://api.newegg.com/marketplace/can/contentmgmt/item/inventorylist?sellerid={SellerID}
```

Request: `{ "Type": "1", "Values": ["SKU-1","SKU-2"] }` (no `WarehouseList`, no `version` param)

Response: same envelope; items are flat:
`{ "ItemNumber", "SellerPartNumber", "FulfillmentOption": "0"|"1", "Active": "0"|"1",
"AvailableQuantity": 10, "WarehouseAllocation"?: [ { "WarehouseCode", "Quantity" } ] }`.

## 6. Inventory writes (direct)

### 6.1 US — Update Item Inventory (International)

```
POST https://api.newegg.com/marketplace/contentmgmt/item/international/inventory?sellerid={SellerID}
```

Request (numbers serialized as strings, matching official sample):

```json
{
  "Type": "1",
  "Value": "A006BSP3",
  "InventoryList": {
    "Inventory": [
      { "WarehouseLocation": "USA", "AvailableQuantity": "107" },
      { "WarehouseLocation": "AUS", "AvailableQuantity": "0" }
    ]
  }
}
```

Response: `{ "SellerID", "ItemNumber", "SellerPartNumber", "InventoryList": { "Inventory": [...] } }`
(XML root `<UpdateInventoryResult>`). Limit: 10,000 requests/hour.
`WarehouseLocation` is an ISO 3166-1 alpha-3 country code (e.g. `USA`, `AUS`).
Same URL as the single-item read — **method selects the operation** (PUT=read, POST=write).

### 6.2 B2B / CAN — Update Inventory and Price (inventory-only use)

```
PUT https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventoryandprice?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/can/contentmgmt/item/inventoryandprice?sellerid={SellerID}
```

Official full sample body includes price fields; **the SDK sends the inventory-only
subset**: `{ "Type": "1", "Value": "A006BSP3", "Inventory": "20" }`. No `Active`,
no price fields, no `FulfillmentOption` are ever sent by the inventory API
(sending `Active` can activate/deactivate a listing; `null`/omitted = no change per docs).

Response: `{ "UpdateInventoryAndPriceResult": { "SellerID", "ItemNumber",
"SellerPartNumber", "FulfillmentOption", "Active", "Result", "AvailableQuantity",
"MAP", "CheckoutMAP", "SellingPrice", "EnableFreeShipping", "LimitQuantity" } }` (all strings).

Platform notes (verbatim from docs):

- "Once an item has been deactivated, all price and inventory update requests shall be disregarded."
  **Verified live (CA, 2026-07-17): this is a FALSE SUCCESS** — the update on a deactivated item
  is HTTP-accepted and the per-item `Result` reads succeeded, but the stored quantity does not
  change. Do not trust a "succeeded" outcome unless the item reads `Active`. (The ITEM_DATA v2
  feed, §13, DOES persist fields on deactivated items.)
  **Verified live (CA, 2026-09-01) — partial apply in a single request:** sending
  `Active: "1"` together with `Inventory` and `SellingPrice` on a deactivated item applies
  `Active` and `SellingPrice` but silently drops `Inventory` (the item was still deactivated
  when the inventory part was evaluated). Activate first, confirm the item reads `Active`,
  then send `Inventory` in a second request.
- **`AvailableQuantity` in this endpoint's response is not a reliable read** (verified live,
  CA, 2026-09-01): a field-less body (`{ "Type", "Value" }` only) is a harmless no-op and
  echoes the item state, but its `AvailableQuantity` read `0` thirty seconds after a
  successful `Inventory` update whose own response echoed the new quantity, while the
  documented Get Inventory read (§5.2, `POST …/item/inventory?version=304`) returned the
  updated quantity at the same moment and again two minutes later. Verify quantity with
  §5.2, never with this endpoint's echo.
- "You're not able to update the inventory for a SBN (Shipped by Newegg) item."
- Default-warehouse semantics: B2B/CAN direct updates apply to the platform's default
  warehouse; there is no `WarehouseLocation` in the request.

## 7. Data feeds

### 7.1 US — Inventory Update Feed

```
POST https://api.newegg.com/marketplace/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_DATA
```

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "2.0" },
    "MessageType": "Inventory",
    "Message": {
      "Inventory": {
        "Item": [
          {
            "SellerPartNumber": "a006-test-001",
            "NeweggItemNumber": "9SIAWE50008504",
            "WarehouseLocation": "USA",
            "FulfillmentOption": "Seller",
            "Inventory": "200"
          }
        ]
      }
    }
  }
}
```

`SellerPartNumber` required; `NeweggItemNumber` optional; one warehouse per region per
item ("only one warehouse per region"). `FulfillmentOption: "Seller"` (feeds cannot touch
SBN inventory). The official single-item sample nests `Item` as an object; the SDK always
serializes `Item` as an **array** (accepted single-or-array is an XML-to-JSON artifact;
responses require tolerant single-or-array parsing everywhere).

### 7.2 B2B / CAN — Inventory and Price Feed (inventory-only use)

```
POST https://api.newegg.com/marketplace/b2b/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_AND_PRICE_DATA
POST https://api.newegg.com/marketplace/can/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_AND_PRICE_DATA
```

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "1.0" },
    "MessageType": "Inventory",
    "Overwrite": "No",
    "Message": {
      "Inventory": {
        "Item": [
          {
            "SellerPartNumber": "SKU-1",
            "Inventory": "159"
          }
        ]
      }
    }
  }
}
```

- **`DocumentVersion` is `1.0` here (US uses `2.0`).**
- `Overwrite` sits at the envelope level. Docs: _"Yes: Will have the added effect of
  deactivating all of your items from the website not listed on this datafeed."_ —
  the SDK **hard-codes `"No"`** and provides no way to set `"Yes"` through the inventory API.
- Optional per-item fields in the official sample (`SellingPrice`, `Shipping`,
  `ActivationMark`, `Currency`, `LimitQuantity`, `FulfillmentOption`, `NeweggItemNumber`)
  are **never emitted** by the inventory-only serializer except `NeweggItemNumber`.

### 7.3 Feed submit response (both platforms)

```json
{
  "IsSuccess": true,
  "OperationType": "SubmitFeedResponse",
  "ResponseBody": {
    "ResponseList": [
      {
        "RequestDate": "2/22/2012 17:24:35",
        "RequestId": "2PQCX3CMQ82MK",
        "RequestStatus": "SUBMITTED",
        "RequestType": "INVENTORY_DATA"
      }
    ]
  },
  "SellerID": "A006"
}
```

XML variant nests `ResponseList > ResponseInfo` — tolerant parsing required.
`RequestId` observed both alphanumeric (`2PQCX3CMQ82MK`) and numeric (`2291326430`).

### 7.4 Feed limits

- Max **10,000 records per feed file**; max **10 feed submissions per minute**;
  max **100,000 inventory records per hour** (feed error `DF003` mentions a 30,000
  `MaxCount` cap for status queries; `DF012` for the hourly allowance).

### 7.5 Get Feed Status

```
PUT https://api.newegg.com/marketplace/{prefix}datafeedmgmt/feeds/status?sellerid={sellerid}
```

```json
{
  "OperationType": "GetFeedStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": "2PQCX3SPZ3QBF" },
      "MaxCount": "100",
      "RequestStatus": "ALL"
    }
  }
}
```

`RequestID` accepts a single string or an array of strings. `RequestStatus` filter values:
`ALL | SUBMITTED | IN_PROGRESS | FINISHED | CANCELLED`. Response: same `ResponseList`
shape as 7.3 with per-request `RequestStatus`. Date-range filters exist in the docs but
their exact field names did not render in extraction — **date filters are intentionally
not implemented**; status is queried by request ID only (documented limitation).

### 7.6 Get Feed Result

```
GET https://api.newegg.com/marketplace/{prefix}datafeedmgmt/feeds/result/{Requestid}?sellerid={sellerid}
```

Response:

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "1.0" },
    "MessageType": "ProcessingReport",
    "Message": {
      "ProcessingReport": {
        "OriginalMessageName": "APIAutoFile.xml",
        "StatusCode": "ProcessReport",
        "ProcessingSummary": { "ProcessedCount": "3", "SuccessCount": "1", "WithErrorCount": "2" },
        "Result": [
          {
            "AdditionalInfo": { "SellerPartNumber": "sellerparttest001", "...": "..." },
            "ErrorList": { "ErrorDescription": ["Error(s). Item not created.", "..."] }
          }
        ]
      }
    }
  }
}
```

Semantics: `ProcessingSummary` carries totals; `Result` entries detail records **with
errors/warnings** (`SuccessCount` = "total successfully processed records"). Successful
records generally do not get a `Result` entry — per-record success is inferred from the
summary. `Result` may be a single object or an array; `ErrorDescription` may be a single
string or an array. Error `DF006` = invalid RequestID.

## 8. Service status

```
GET https://api.newegg.com/marketplace/{prefix}{domain}/servicestatus?sellerid={SellerID}
```

`{domain}` ∈ `contentmgmt | ordermgmt | datafeedmgmt | servicemgmt | reportmgmt |
sellermgmt | sbnmgmt | shippingservice`.

Response: `{ "NeweggAPIResponse": { "IsSuccess": "true", "OperationType": "GetServiceStatus",
"SellerID": "A006", "ResponseBody": { "Status": "0"|"1", "Timestamp": "2/15/2012 2:50:38",
"Message"?: "..." } } }` — `Status` `"1"` = available, `"0"` = unavailable. Note the extra
`NeweggAPIResponse` wrapper (absent from some other JSON responses) and booleans as strings.

## 9. Live verification log (2026-07-10)

Read-only probes with the credentials provided in `.env` (marketplace `CA`):
`GET .../can/contentmgmt/servicestatus` and `POST .../can/contentmgmt/item/inventorylist`
both returned **HTTP 401 `Gateway: Seller Auth failed.`** — same result on US and B2B
prefixes. Endpoints and header format match the official docs; the credentials themselves
were not accepted on any platform at test time. No mutating call was attempted.

## 10. Order Management (reads)

> Extracted 2026-07-12 from the official Newegg Developer Portal order-management pages
> (sources cited per subsection). Only **read** operations are documented; the SDK's order
> surface is read-only (no ship / cancel / refund). The portal also exposes _Get Additional
> Order Information_ and mutating order calls — deliberately **not** contracted here yet.

Order datetimes follow the §2 rule (Pacific Time, no offset — e.g. `3/18/2023 1:04:16`).
Money fields are decimals in the order's `CurrencyCode` (USD unless stated) and, like every
number on this API, may arrive as a JSON number _or_ string. Any single-element list may be
an object instead of an array (§2) — every list below is subject to that quirk.

### 10.1 Get Order Information

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/get_order_information/` (2026-07-12).

```
PUT https://api.newegg.com/marketplace/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
```

A **read via PUT** (classify by this doc, not the HTTP verb — cf. §2). Auth required; XML/JSON
in and out. Rate limit **1000 requests/hour** per seller. Documented `version` values:
`304, 305, 306, 307, 309, 310, 311, 312, 313, 314, 315` (**note: no 308**); newer versions add
fields (flagged below).

Request — `RequestCriteria` selects orders; every criterion is optional (omit to match all).
Types mirror the official sample (paging/enum values sent as strings, all accepted):

```json
{
  "OperationType": "GetOrderInfoRequest",
  "RequestBody": {
    "PageIndex": "1",
    "PageSize": "100",
    "RequestCriteria": {
      "OrderNumberList": { "OrderNumber": ["159243598", "41473642"] },
      "SellerOrderNumberList": { "SellerOrderNumber": ["SO159243598"] },
      "Status": "1",
      "Type": "0",
      "OrderDateFrom": "2011-01-01 09:30:47",
      "OrderDateTo": "2011-12-17 09:30:47",
      "OrderDownloaded": 0,
      "CountryCode": "USA",
      "PremierOrder": "1"
    }
  }
}
```

- `PageSize` max **100** (default 100); `PageIndex` default 1.
- `OrderNumberList.OrderNumber[]` — an **array wrapper**, not a scalar; when present, other
  criteria are ignored (direct lookup by order number). `SellerOrderNumberList` is the
  analogous wrapper for seller order numbers (SBN).
- Enum criteria: `Status` 0 Unshipped · 1 PartiallyShipped · 2 Shipped · 3 Invoiced · 4 Voided
  · 5 Payment Pending (v312+; blank = all). `Type` 0 All · 1 SBN (shipped by Newegg) · 2 SBS
  (shipped by seller) · 3 Multi-Channel · 4 NWS. `OrderDownloaded` 0 include downloaded
  (default) · 1 exclude already-downloaded. `PremierOrder` 0 All · 1 Premier only · 2 No
  Premier. `VoidSoon` (optional) 24 | 48 — orders auto-voiding within N hours.
- `OrderDateFrom`/`OrderDateTo`: Pacific-Time strings (§2).

Response — envelope + `ResponseBody.PageInfo` + `ResponseBody.OrderInfoList`; each order nests
`ItemInfoList` and `PackageInfoList`. XML wraps lists as `<OrderInfoList><OrderInfo>…`; JSON
uses bare arrays. Like §8, the JSON body may or may not carry the outer `NeweggAPIResponse`
wrapper — tolerate both.

```json
{
  "IsSuccess": true,
  "OperationType": "GetOrderInfoResponse",
  "SellerID": "A2EU",
  "ResponseDate": "01/05/2022 14:16:28",
  "ResponseBody": {
    "PageInfo": { "TotalCount": 1, "TotalPageCount": 1, "PageIndex": 1, "PageSize": 100 },
    "OrderInfoList": [
      {
        "SellerID": "A2EU",
        "OrderNumber": 511952652,
        "SellerOrderNumber": "2153930",
        "InvoiceNumber": 0,
        "OrderDownloaded": false,
        "OrderDate": "03/18/2023 1:04:16",
        "AutoVoidTime": "04/01/2023 1:12:39",
        "OrderStatus": 4,
        "OrderStatusDescription": "Voided",
        "CustomerName": "…",
        "CustomerPhoneNumber": "…",
        "CustomerEmailAddress": "cusa.***@marketplace.newegg.com",
        "OnTimeShipDueDate": "11/14/2021",
        "DeliverDueDate": "11/22/2021",
        "ShipToAddress1": "…",
        "ShipToAddress2": "…",
        "ShipToCityName": "…",
        "ShipToStateCode": "CA",
        "ShipToZipCode": "91748-1119",
        "ShipToCountryCode": "UNITED STATES",
        "ShipService": "Standard Shipping (5-7 business days)",
        "SignatureRequired": true,
        "ShipToFirstName": "…",
        "ShipToLastName": "…",
        "ShipToCompany": "…",
        "CurrencyCode": "USD",
        "OrderItemAmount": 1.0,
        "ShippingAmount": 0,
        "DiscountAmount": 0,
        "RefundAmount": 0,
        "OrderTotalAmount": 1.0,
        "OrderQty": 2,
        "IsAutoVoid": false,
        "SalesChannel": 0,
        "FulfillmentOption": 0,
        "ItemInfoList": [
          {
            "SellerPartNumber": "…",
            "NeweggItemNumber": "9SIA2EUGAT9779",
            "MfrPartNumber": "…",
            "UPCCode": "",
            "Description": "…",
            "OrderedQty": 2,
            "ShippedQty": 0,
            "UnitPrice": 0.5,
            "ExtendUnitPrice": 1.0,
            "ExtendShippingCharge": 0,
            "Status": 1,
            "StatusDescription": "Unshipped",
            "BuyerRequestedCancel": false
          }
        ],
        "PackageInfoList": [
          {
            "ShipCarrier": "…",
            "ShipService": "…",
            "TrackingNumber": "…",
            "ShipDate": "…",
            "SellerPartNumber": "…",
            "MfrPartNumber": "…",
            "ShippedQty": 1,
            "Memo": ""
          }
        ]
      }
    ]
  }
}
```

- Envelope: `IsSuccess`, `SellerID`, `OperationType` = `GetOrderInfoResponse`; paging under
  `ResponseBody.PageInfo` (`TotalCount`, `TotalPageCount`, `PageIndex`, `PageSize`).
- `OrderNumber` observed as a JSON number here and a string in §10.2 — parse tolerantly.
- `OrderStatus` (response): same 0–5 codes as request `Status`; `OrderStatusDescription` is
  the human label. Item-level `Status`: **1 Unshipped · 2 Shipped · 3 Cancelled** — a
  _different_ scale from `OrderStatus`, do not conflate.
- `SalesChannel`: 0 Newegg · 1 Multi-channel · 2 Replacement · 3 NWS. `FulfillmentOption`:
  0 ship by seller · 1 ship by Newegg (SBN).
- `CustomerEmailAddress` is a masked Newegg relay (`…@marketplace.newegg.com`), never the
  buyer's real address.
- Money fields (`OrderItemAmount`, `ShippingAmount`, `DiscountAmount`, `RefundAmount`,
  `SalesTax`, `VATTotal`, `DutyTotal`, `RecyclingFeeAmount`, `OrderTotalAmount`, and item
  `UnitPrice`/`ExtendUnitPrice`/`ExtendShippingCharge`/…) are decimals in `CurrencyCode`;
  observed both as numbers (`1.0`) and strings (`"0.00"`).
- Version-gated fields: `OnTimeShipDueDate`/`DeliverDueDate` (v311), `CurrencyCode` (v313),
  `SignatureRequired` (v314), `AutoVoidTime`/`IsAutoVoid` (v313/v315). Each is optional.

**ASSUMPTION (default version):** the SDK pins `version=315` (highest documented, and the top
of the page's version table) for order reads so every mapped field is available; older
versions merely omit newer fields. Isolated behind the order adapter, overridable.

### 10.2 Get Order Status

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/get_order_status/` (2026-07-12).

```
GET https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
GET https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
GET https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
```

A lightweight single-order status check. **GET**, no request body; `{ordernumber}` is a path
segment. Auth required; XML/JSON out. Only `version=304`. Rate limit **500 requests/hour**.

Response — a **flat object** (no envelope; XML root `QueryOrderStatusInfo`):

```json
{
  "OrderNumber": "159243598",
  "OrderStatusCode": 1,
  "OrderStatusName": "PartiallyShipped",
  "SellerID": "A006",
  "OrderDownloaded": true,
  "SalesChannel": 0,
  "FulfillmentOption": 0
}
```

- `OrderStatusCode`/`OrderStatusName`: 0 Unshipped · 1 PartiallyShipped · 2 Shipped ·
  3 Invoiced · 4 Voided · 5 PaymentPending — same codes as §10.1 `OrderStatus`; the name is
  the camel-case `OrderStatusName` value.
- `OrderDownloaded`: `"True"`/`"False"` (string boolean).
- `SalesChannel`, `FulfillmentOption`: as in §10.1.
- Errors: `SO002` (order number must be an integer 1–2147483647), `SO003` (no data found, or
  the order does not belong to this seller). Both XML `<Errors>` and JSON-array shapes (§1).
  The SDK's "try" variant maps `SO003` to a not-found (`undefined`) result, mirroring the
  inventory `CT026` handling (§5); every other error throws.

## 11. Order Management (writes)

> Extracted 2026-07-14 from the official Newegg Developer Portal order-management pages (sources
> cited per subsection). These are the **mutating** order operations — ship, cancel, mark-downloaded
> (confirmation), and remove-item. The SDK implements them under the same write-safety rules as
> inventory writes (MCP preview→apply, `NEWEGG_MCP_ALLOW_WRITES` gate) and, like feeds, treats them
> as **non-idempotent**: a request whose body may have reached Newegg is never auto-retried
> (ADR 0004). Auth required; XML/JSON in and out; each is rate limited **1000 requests/hour**.

**Shared endpoint quirk (HTTP verb ≠ semantics, cf. §2/§10.2).** Ship Order and Cancel Order both
`PUT` to `ordermgmt/orderstatus/orders/{ordernumber}` — the _same_ URL that Get Order Status (§10.2)
reads with `GET`. That path is **read-on-GET, write-on-PUT**; the `Action` field in the PUT body
selects the mutation (`1` cancel, `2` ship). Classify by this doc, never by the URL. Order
Confirmation and Remove Item use distinct paths (`…/orders/confirmation`, `ordermgmt/killitem/…`).

Response dates are Pacific Time (§2), in either `M/D/YYYY H:mm:ss` (confirmation) or an ISO-like
`YYYY-MM-DDTHH:mm:ss` / `YYYY-MM-DD HH:mm:ss` form (ship `ShipDate`, remove-item `RequestDate`) —
parse via `platform/dates.ts`. Any single-element list (`Package`, `Item`, `OrderNumber`) may be an
object instead of an array (§2).

### 11.1 Ship Order (`Action` = 2)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/ship_order/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
```

`PUT`, only `version=304`. Updates shipment of one or more items. Newegg accepts one item split
across multiple packages but rejects a package that ships fewer than the ordered quantity of an item
without the rest being shipped in sibling packages (total shipped must equal total ordered for that
item). Shipping every item completes the order; shipping some leaves it `PartiallyShipped`.

Request — `Value.Shipment` carries a header + a `PackageList`; each `Package` has its own
carrier/tracking and an `ItemList`. (In XML the `Value` element is CDATA-wrapped XML; in JSON it is
a nested object.)

```json
{
  "Action": "2",
  "Value": {
    "Shipment": {
      "Header": { "SellerID": "A006", "SONumber": "159243598" },
      "PackageList": {
        "Package": [
          {
            "TrackingNumber": "TRACK1",
            "ShipCarrier": "Purolator",
            "ShipService": "3-5",
            "ItemList": { "Item": { "SellerPartNumber": "A006ZX-35833", "ShippedQty": "1" } }
          }
        ]
      }
    }
  }
}
```

- `Action` `2` = ship (required). `SONumber` is the order number and must equal `{ordernumber}` in
  the URL (else `SO040`); the header `SellerID` must match the URL `sellerid`.
- Per package (required): `TrackingNumber`, `ShipCarrier` (a Newegg Integrated Carrier List value),
  `ShipService`. Per item (required): `SellerPartNumber`, `ShippedQty` (> 0); `NeweggItemNumber`
  optional. `Package` and `Item` are object-or-array (§2).

Response — `PackageProcessingSummary` counts, then a `Result` with the new order status and
per-package `ProcessStatus`:

```json
{
  "IsSuccess": true,
  "PackageProcessingSummary": { "TotalPackageCount": 1, "SuccessCount": 1, "FailCount": 0 },
  "Result": {
    "OrderNumber": "159243598",
    "OrderStatus": "Shipped",
    "SellerID": "A006",
    "Shipment": {
      "PackageList": [
        {
          "TrackingNumber": "TRACK1",
          "ShipDate": "2012-02-10T15:30:01",
          "ProcessStatus": true,
          "ProcessResult": "Success",
          "ItemList": [
            {
              "NeweggItemNumber": "9SIA0060845543",
              "SellerPartNumber": "A006ZX-35833",
              "ShippedQty": 1
            }
          ]
        }
      ]
    }
  }
}
```

- **`IsSuccess` "always returns true"** per the docs — do NOT read it as the per-package outcome.
  Real success is per package: `ProcessStatus` (`true`/`false`) + `ProcessResult`, with
  `SuccessCount`/`FailCount` in the summary. **ASSUMPTION:** the SDK surfaces a partial failure
  (`FailCount > 0`, or any `ProcessStatus=false`) as an error/warning, not silent success.
- `OrderStatus` here is a **string** (`Shipped` / `PartiallyShipped`), not the §10 numeric code.
- `ShipDate` is Pacific (`YYYY-MM-DDTHH:mm:ss`).

### 11.2 Cancel Order (`Action` = 1)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/cancel_status/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
```

`PUT`, only `version=304`. Same URL as Ship (§11.1) and Get Order Status (§10.2); `Action=1` selects
cancel. Only **unshipped** orders can be voided (`SO006`/`SO008`).

Request — a reason code in `Value`:

```json
{ "Action": "1", "Value": "24" }
```

- `Value` cancel reason code (required): `24` Out of Stock · `72` Customer Requested to Cancel ·
  `73` Price Error · `74` Unable to Fulfill Order (any other → `SO017`).
- **SBN caveat:** a Shipped-by-Newegg order may not cancel if the Newegg warehouse is already
  processing it; the response comes back `Processing` and the final result must be polled via Get
  SBN Order Cancellation Request Result (deferred — see the end of §11).

Response:

```json
{
  "IsSuccess": "true",
  "Result": { "OrderNumber": "159243598", "SellerID": "A006", "OrderStatus": "Void" }
}
```

- `OrderStatus`: `Void` = cancelled successfully; `Processing` = SBN cancellation accepted, result
  pending (poll separately). `IsSuccess` is a string boolean (`"true"`/`"false"`).

### 11.3 Order Confirmation (mark downloaded)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/order_confirmation/` (2026-07-14).

```
POST https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
POST https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
POST https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
```

`POST` (no `{ordernumber}` path segment, no `version`). Marks one or more orders as **downloaded**
(acknowledged) on the seller portal — the workflow signal that an order has been pulled into the
seller's system. Re-marking a downloaded order is effectively a no-op, but it is still a mutation →
same write gating.

Request — `DownloadedOrderList.OrderNumber[]` (array wrapper):

```json
{
  "OperationType": "OrderConfirmationRequest",
  "RequestBody": { "DownloadedOrderList": { "OrderNumber": ["159243598"] } }
}
```

- `OperationType` fixed `OrderConfirmationRequest`. `OrderNumber` list required; `IssueUser` (an
  eligible seller-account email) optional.

Response — wrapped in `NeweggAPIResponse` (tolerate the wrapper present or absent, §8):

```json
{
  "NeweggAPIResponse": {
    "IsSuccess": "true",
    "OperationType": "OrderConfirmationResponse",
    "SellerID": "A006",
    "ResponseDate": "2/22/2012 16:38:53",
    "ResponseBody": {
      "RequestDate": "2/22/2012 16:38:53",
      "DownloadedOrderList": { "OrderNumber": "159243598" }
    }
  }
}
```

- `ResponseDate`/`RequestDate` Pacific (`M/D/YYYY H:mm:ss`). Errors use the **`CE` prefix** (`CE001`
  SellerID null/empty), not `SO` — route through the shared upstream-error path (§1).

### 11.4 Remove Item (KillItem)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/remove_item/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/can/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
```

`PUT` to the `killitem` path (no `version`). Removes one or more line items from an unshipped order
by `SellerPartNumber`. **Not** allowed on SBN orders (`SO005`/`SO056`).

Request — `KillItem.Order.ItemList.Item[]`:

```json
{
  "OperationType": "KillItemRequest",
  "RequestBody": {
    "KillItem": { "Order": { "ItemList": { "Item": [{ "SellerPartNumber": "AWHZ3434" }] } } }
  }
}
```

- `OperationType` fixed `KillItemRequest`. Each `Item.SellerPartNumber` required; `Item` is
  object-or-array. `IssueUser` and `Memo` (reason) optional. A repeated part# → `SO055`.

Response:

```json
{
  "IsSuccess": true,
  "OperationType": "KillItemResponse",
  "SellerID": "A006",
  "Memo": null,
  "ResponseBody": {
    "Orders": {
      "OrderNumber": "88237462",
      "Result": { "ItemList": [{ "SellerPartNumber": "AWHZ3434" }] }
    },
    "RequestDate": "2012-02-22 16:42:10"
  },
  "ResponseDate": "2012-02-22 16:42:10"
}
```

- `ResponseBody.Orders.Result.ItemList` echoes the removed items. `Memo` is `null` on success and
  carries the error description when `IsSuccess` is false. Dates Pacific (`YYYY-MM-DD HH:mm:ss`).

### 11.5 Order-write error codes

Ship/Cancel (`orderstatus/orders/{n}`) and Remove-Item (`killitem`) return the `SO*` family; Order
Confirmation returns `CE*`. Both arrive as XML `<Errors><Error><Code>` or a JSON array
`[{ "Code", "Message" }]` (§1) — route through `errors/parse-upstream.ts`. Key codes:

| Code             | Meaning (write-relevant)                                      |
| ---------------- | ------------------------------------------------------------- |
| SO001 / SO009    | Seller ID / order number null or empty                        |
| SO002            | Order number must be an integer 1–2147483647                  |
| SO003            | No data found, or the order is not this seller's              |
| SO004 / SO054    | Replacement SO with an RMA — cannot be voided                 |
| SO005 / SO056    | Cannot remove item — Shipped-by-Newegg order                  |
| SO006            | Only unshipped orders can be voided (current status `{0}`)    |
| SO008            | Order already voided                                          |
| SO011            | Only unshipped orders can be shipped (current status `{0}`)   |
| SO012            | Only shipped-by-seller orders are supported                   |
| SO014 / SO037    | `Action` must be `1` (cancel) or `2` (ship)                   |
| SO016            | Order not yet downloaded to the portal — retry after ~2 hours |
| SO017            | Cancel reason must be `24` / `72` / `73` / `74`               |
| SO020            | A package is missing shipping information                     |
| SO025 / SO027    | Some / all items already shipped                              |
| SO030            | Malformed shipment segment                                    |
| SO040            | Body order# / Seller ID ≠ the URL values                      |
| SO050 / SO055    | Invalid / repeated `SellerPartNumber` (remove-item)           |
| SO051            | Item already cancelled in Newegg's system                     |
| SO056 (ship ctx) | Premier order — must ship via Newegg Shipping Label Service   |
| CE001            | (confirmation) Seller ID null or empty                        |

`SO056` text differs by endpoint (Premier-order-ship in §11.1; SBN-remove in §11.4) — Newegg reuses
the number, so surface the message, not just the code.

**DEFERRED (not contracted here):** Get SBN Order Cancellation Request Result
(`…order_management/get_sbn_shipped_by_newegg_order_cancellation_request_result/`) — needed only to
poll the `Processing` outcome of an SBN cancel (§11.2); add when SBN cancel is implemented.

## 12. Reports Management — Item Lookup (catalog resolution)

Verified 2026-07-16 against the official pages:

- Submit: `https://developer.newegg.com/newegg_marketplace_api/reports_management/submit_report_request/submit_item_lookup_report/`
- Status: `https://developer.newegg.com/newegg_marketplace_api/reports_management/get_report_status/`
- Result: `https://developer.newegg.com/newegg_marketplace_api/reports_management/get_report_result/get_item_lookup_report/`

Async 3-step lifecycle: submit → poll status → page through the result. All three endpoints exist
on every platform via the standard prefix (`reportmgmt/…`, `b2b/reportmgmt/…`, `can/reportmgmt/…`).

**Read/write classification:** all three are READS. Report submission is a `POST`, but it creates a
report job only — it never mutates listings, prices, inventory, or orders (§2's rule: classify by
contract, not verb). Owner approved live read-only use 2026-07-16.

### 12.1 Submit Item Lookup Report

`POST {prefix}reportmgmt/report/submitrequest?sellerid={sellerid}` — rate limit **100/hour**.

```json
{
  "OperationType": "ItemLookupRequest",
  "RequestBody": {
    "RequestCriteria": {
      "Item": [
        { "UPC": "20140711101111", "Condition": "1" },
        {
          "ManufacturerName": "q-see",
          "ManufacturerPartNumber": "canmfpn20140711101",
          "PacksOrSets": 1
        }
      ]
    }
  }
}
```

- Per item: `UPC` (required if no MPN) OR `ManufacturerName` + `ManufacturerPartNumber` (both
  required if no UPC). Optional: `Condition` (integer 1–6, table in §4; Used only on Newegg.com),
  `PacksOrSets` (integer).
- Max **1000** items per request (error `RP021` beyond that).
- Response (`OperationType: "ItemLookupReportResponse"`): the request id is nested in a LIST —
  `ResponseBody.ResponseList[0].RequestId` (XML wraps it further as `ResponseList > ResponseInfo`):

```json
{
  "IsSuccess": true,
  "OperationType": "ItemLookupReportResponse",
  "SellerID": "a001",
  "ResponseBody": {
    "ResponseList": [
      {
        "RequestId": "270Z8Y3SYIGQV",
        "RequestType": "ITEM_LOOKUP",
        "RequestDate": "07/12/2014 11:34:57",
        "RequestStatus": "SUBMITTED"
      }
    ]
  }
}
```

- Dates Pacific, `MM/DD/YYYY HH:mm:ss`. `RequestStatus` on submit is `SUBMITTED`.

### 12.2 Get Report Status

`PUT {prefix}reportmgmt/report/status?sellerid={sellerid}` — rate limit **500/hour**.

```json
{
  "OperationType": "GetReportStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": "2PQBYWH4V68ZP" },
      "MaxCount": "10"
    }
  }
}
```

- NOTE the extra `GetRequestStatus` wrapper inside `RequestBody`. `RequestID` accepts a single id
  (official JSON example) — XML shows the same element repeated for multiple ids, so an array is
  the multi-id JSON form (**ASSUMPTION** for arrays; single-string form is verified).
- When `RequestID` is provided, `RequestType`/`MaxCount`/`RequestStatus`/date filters are ignored.
  `MaxCount` caps at 100. Report types include `ITEM_LOOKUP` and `ITEM_BASIC_INFO_REPORT`.
- Response (`OperationType: "GetReportStatusResponse"`): `ResponseBody.ResponseList[]` (XML nests
  `ResponseInfo`; treat as object-OR-array) with `RequestId`, `RequestType`, `RequestDate`,
  `RequestStatus`, `TotalCount`.
- `RequestStatus` enum: `SUBMITTED` | `IN_PROGRESS` | `FINISHED` | `CANCELLED`.
- Errors: `RP004`–`RP007` (date-filter validation), standard `<Errors>`/JSON-array envelope (§1).

### 12.3 Get Item Lookup Report Result

`PUT {prefix}reportmgmt/report/result?sellerid={sellerid}` — rate limit **500/hour**.

```json
{
  "OperationType": "ItemLookupRequest",
  "RequestBody": {
    "RequestID": "2PQBYWH4V68ZP",
    "PageInfo": { "PageIndex": "1", "PageSize": "100" }
  }
}
```

- `PageSize` max 100. `PageIndex` 1-based. Optional `IssueUser` (registered portal email).
- Response (`OperationType: "ItemLookupResponse"`):

```json
{
  "IsSuccess": true,
  "SellerID": "A006",
  "ResponseBody": {
    "PageInfo": { "TotalCount": 3, "TotalPageCount": 1, "PageIndex": 1, "PageSize": 100 },
    "RequestID": "27YV8H1HHRFLZ",
    "RequestDate": "02/16/2023 14:00:03",
    "ItemList": [
      {
        "ManufacturerName": "Plantronics",
        "ManufacturerPartNumber": "203500-105",
        "Condition": 1,
        "Note": "No match found."
      },
      {
        "NeweggItemNumber": "0G6-0008-003W9",
        "UPC": "017229164116",
        "Condition": 1,
        "PacksOrSets": 1,
        "ManufacturerName": "Plantronics",
        "ManufacturerPartNumber": "206110-101",
        "WebsiteShortTitle": "Plantronics Voyager 5200 …",
        "Variety": { "GroupID": 204142502, "Options": [{ "Name": "Color", "Value": "Blue" }] }
      }
    ]
  },
  "ResponseDate": "02/16/2023 14:06:04"
}
```

- The list key is `ResponseBody.ItemList` (XML: `ItemList > Item`; treat as object-OR-array).
- Each row ECHOES the submitted criteria. A row WITHOUT `NeweggItemNumber` is a miss and carries
  `Note` (e.g. `"No match found."`). Hit rows carry `NeweggItemNumber` ("Newegg's assigned number
  for item"), `UPC`, `Condition` (number; §4 table), `PacksOrSets`, `ManufacturerName`,
  `ManufacturerPartNumber`, `WebsiteShortTitle` (catalog title — useful to confirm the product),
  and optionally `Variety` (`GroupID` + `Options[{Name,Value}]`) for variant groups.
- The official JSON example is syntactically invalid (missing comma, trailing comma) — trust the
  field inventory, not the sample's punctuation. Numbers may arrive as strings elsewhere; parse
  tolerantly as always.
- **Verified live (CA, 2026-07-17):** hit lists may interleave condition-less PSEUDO-ROWS — an
  `R`-suffixed variant of the real item number (e.g. `20-250-259R` alongside `20-250-259`)
  carrying NO `Condition` field, apparently a refurb catalog echo — and the pseudo-row can come
  FIRST. The Existing Item Creation feed (§13) rejects the `R` number with "Newegg item number
  does not exist". Consumers must prefer condition-bearing rows; the SDK's `catalog.resolve`
  ranks them first.
- **Verified live (CA, 2026-07-18, 5/5 A/B reproductions): duplicate-product criteria poison the
  report.** A submission containing two criteria that match the SAME catalog product (observed:
  a UPC plus that product's manufacturer+MPN) reaches `FINISHED`, but the result endpoint then
  returns HTTP 500 `InternalError` ("currently unavailable … Please try again") on every fetch,
  permanently — indistinguishable on the wire from an outage. The identical input set minus the
  duplicate succeeds. De-duplicate inputs by product, not just by criteria value; the SDK's
  `resolve()` raises a diagnostic error for this case.

## 13. Data Feeds — Existing Item Creation (listing writes)

Creates seller listings against products **already in Newegg's catalog** (resolved via §12). This is
the `&v2` datafeed template — distinct from full item creation (`&v1`) and the basic-info feed
(`&v3`).

Verified against the official Java/C# SDKs and the docs page:

- Docs: `https://developer.newegg.com/newegg_marketplace_api/datafeed_management/existing_item_creation_feed/`
  (fetched 2026-07-17, page last updated 2021-03-09).
- Java SDK `Newegg/newegg-marketplace-sdk-java` file
  `DataFeed/src/main/java/com/newegg/marketplace/sdk/datafeed/inner/SubmitCreationCaller.java`
  (`requesttype=ITEM_DATA&v2`; `&v1` = full item creation, `&v3` = basic-info feed).
- C# SDK `Newegg/newegg-marketplace-sdk-dotnet` file
  `DataFeed/Model/SubmitFeed/ExistingItemCreationFeed.cs` (`base("2.0","BatchItemCreation")`).

**Read/write classification:** WRITE. Any live use requires explicit owner authorization in the
current session; the live test suite must never contain this surface (enforced by
`scripts/check-live-readonly.ts`).

### 13.1 Submit Existing Item Creation Feed

```
POST {prefix}datafeedmgmt/feeds/submitfeed?sellerid={id}&requesttype=ITEM_DATA&v2
```

Prefixes `""` / `b2b/` / `can/` (§1). **`&v2` is a bare flag (no `=`)** selecting the existing-item
template; `&v1` selects full item creation, `&v3` the basic-info feed.

- **Discrepancy:** the docs page (fetched 2026-07-17) omits `&v2` from the URL — the official Java
  SDK's `SubmitCreationCaller` sends `requesttype=ITEM_DATA&v2`, and the C# SDK models this feed as
  `BatchItemCreation` v2.0. The SDKs win; the docs page is treated as stale.
- Limits: **10 submits/min** (shared submitfeed budget), **3,000 records per file**, **15 MB per
  file**, **30,000 records/hour**. Request-failure errors: `DF003` / `DF004` / `DF011`.

### 13.2 Request envelope (JSON)

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "2.0" },
    "MessageType": "BatchItemCreation",
    "Message": {
      "Itemfeed": [
        {
          "Item": [
            {
              "BasicInfo": {
                "SellerPartNumber": "...",
                "Manufacturer": "...",
                "ManufacturerPartsNumber": "...",
                "UPCOrISBN": "...",
                "NeweggItemNumber": "...",
                "Currency": "CAD",
                "MSRP": "0.00",
                "MAP": "0.00",
                "CheckoutMAP": "False",
                "SellingPrice": "9.99",
                "Shipping": "Default",
                "Inventory": "1",
                "ItemCondition": "New",
                "PacksOrSets": "1",
                "ActivationMark": "False",
                "CountryOfOrigin": "TWN",
                "LeadTime": "2",
                "ShippingTemplate": "..."
              }
            }
          ]
        }
      ]
    }
  }
}
```

- `SummaryInfo` is an XML-only required-but-EMPTY element — **omitted entirely** in the JSON
  serialization.
- There is **no `Overwrite` field in the v2 envelope** (`Overwrite` is v1-only; see §7.2 for the
  inventory feed's hard-coded `"No"`).
- Spelling landmines: `ManufacturerPartsNumber` (plural "Parts"), `UPCOrISBN`, `CheckoutMAP`,
  `ActivationMark`.
- `Itemfeed` and `Item` are arrays in JSON; numbers/prices are sent as strings.

### 13.3 BasicInfo field table

From the official docs page:

| Attribute                 | Required?    | Notes                                                                                                                                                                                                                   |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SellerPartNumber`        | Yes          | ≤40 chars incl. space; immutable once created.                                                                                                                                                                          |
| `Manufacturer`            | Yes (always) | Must match a name predefined in Newegg's system — additions via mktp.content@newegg.com.                                                                                                                                |
| `UPCOrISBN`               | Conditional  | One of {`UPCOrISBN`, `ManufacturerPartsNumber`, `NeweggItemNumber`} required. 12-digit UPC or 13-digit EAN.                                                                                                             |
| `ManufacturerPartsNumber` | Conditional  | One of the three above; ≤40 chars.                                                                                                                                                                                      |
| `NeweggItemNumber`        | Conditional  | One of the three above; Newegg's assigned catalog number (§12).                                                                                                                                                         |
| `SellingPrice`            | Yes          | String.                                                                                                                                                                                                                 |
| `Shipping`                | Yes          | Docs page values `Default` \| `Free`. **Discrepancy:** the C# SDK's carrier-speed `Shipping` enum belongs to the v1 feed — docs page wins here, to be confirmed against the first live preview.                         |
| `Inventory`               | Yes          | Integer. Default warehouse: CAN warehouse on newegg.ca, USA warehouse on the US/B2B platforms.                                                                                                                          |
| `PacksOrSets`             | Yes          | Integer; immutable once created.                                                                                                                                                                                        |
| `Currency`                | Optional     | `USD` / `CAD`; defaults CAD on newegg.ca, USD elsewhere.                                                                                                                                                                |
| `MSRP`                    | Optional     | String.                                                                                                                                                                                                                 |
| `MAP`                     | Optional     | `0` / `0.00` removes MAP; null = no change.                                                                                                                                                                             |
| `CheckoutMAP`             | Optional     | `True` / `False`.                                                                                                                                                                                                       |
| `ItemCondition`           | Optional     | `New` / `Refurbished` everywhere; `UsedLikeNew` / `UsedVeryGood` / `UsedGood` / `UsedAcceptable` (+ `ConditionDetails` + `UsedItemImages`/`ImageUrl`/`IsPrimary`) are Newegg.com-platform-only. Immutable once created. |
| `ActivationMark`          | Optional     | `True` = listed for sale, `False` = hidden/offline, null = no change.                                                                                                                                                   |
| `CountryOfOrigin`         | Optional     | ISO 3166-1 alpha-3.                                                                                                                                                                                                     |
| `LeadTime`                | Optional     | Business days 1–14; Newegg default 2.                                                                                                                                                                                   |
| `ShippingTemplate`        | Optional     | ≤200 chars; blank = no change.                                                                                                                                                                                          |

### 13.4 Submit response

Identical `SubmitFeedResponse` shape to §7.3 — `IsSuccess`, `OperationType: "SubmitFeedResponse"`,
`SellerID`, `ResponseBody.ResponseList[]` entries
`{ RequestId, RequestType: "ITEM_DATA", RequestDate (Pacific Time), RequestStatus: "SUBMITTED" }`.
The XML variant nests `ResponseList > ResponseInfo`. Parsed by the SDK's existing feed-submit parser.

### 13.5 Result

Generic `ProcessingReport` (§7.6 shape): `NeweggEnvelope > Message > ProcessingReport` with
`ProcessingSummary { ProcessedCount, SuccessCount, WithErrorCount }` and `Result[]` records carrying
`AdditionalInfo { SellerPartNumber, ManufacturerPartsNumber, UPCOrISBN, SubCategoryID }` +
`ErrorList > ErrorDescription[]` (CDATA text). Partial success is possible (e.g. `"Item Created with
Image error(s)."`).

Verified live (CA, 2026-07-17):

- Clean successes produce NO `Result` records — only warned/failed records appear; verify success
  via `ProcessingSummary.SuccessCount`, not per-record echoes. Records are isolated: one item's
  failure does not poison the rest of the feed.
- Newegg enforces **UPC + condition uniqueness per seller account**. Creating a second offer on an
  already-listed product fails with an error naming the existing offer's
  `Seller Part Number` — this error is the authoritative "already listed" signal (pre-checking is
  optional; an inventory read by UPC, §5.2 note, works as a best-effort pre-check).
- Newly created items are INVISIBLE to the inventory API (CT026) while under Newegg's content
  review (~2 h observed; docs say ≤6 h normal / ≤24 h max) and "cannot be activated" until review
  completes. Trust the ProcessingReport, then re-check after the review window.

Verified live (CA, 2026-09-02) — Refurbished offers:

- A `Refurbished` offer must target a catalog item whose own condition is Refurbished. Sending
  `ItemCondition: Refurbished` against a New catalog item fails per record with
  `The item <n> entered already exists in our system with different Item Condition New.` (3/3).
  Refurbished catalog items are separate records with CODE-form numbers (e.g. `0D9-0009-00CY3`,
  `27N-0022-000R6`, `13B-005K-00054`); the Item Lookup Report (§12) returns them when the input
  carries `Condition: 2`, and returns nothing when no refurbished record exists. Existing-item
  creation cannot create one.
- CODE-form `NeweggItemNumber` values are accepted by the creation feed (1/1 succeeded).
- `PacksOrSets` must match the catalog item's own value, or the record fails with
  `already exists in our system with different Pack or Sets <n>` (a 2-stick memory kit's
  refurbished record carries `PacksOrSets` 2 while its New record carries 1).

## 14. Public storefront APIs (UNOFFICIAL)

> ⚠️ **WARNING — UNOFFICIAL.** Everything in this section is a **public retail storefront**
> endpoint, not part of the Newegg Marketplace **seller** API. There is **no official
> documentation URL**: the shapes below were **observed live on newegg.ca, 2026-07-31** with a
> plain Node `fetch` (no cookies, no credentials, no session). No SLA, no versioning, no
> deprecation notice — Newegg can change or remove these at any time, and the CDN may block
> clients that do not look like a browser. Treat every field as best-effort.
>
> **Read/write classification: READ.** These endpoints are unauthenticated and touch nothing on
> the seller account. They never carry seller credentials (§1 auth headers must NOT be sent —
> they are meaningless here and would leak secrets to a non-API host).

**Why the SDK has this at all:** the seller API exposes no competitive-pricing surface — there is
no "who else sells this / what is the buy-box price" endpoint anywhere in `contentmgmt`,
`ordermgmt`, `datafeedmgmt`, or `reportmgmt`. The storefront's own buy-box widget is the only
observed source. Available for the `ca` and `us` storefronts only; **`b2b` has no public
storefront** (the SDK throws `UnsupportedMarketplaceOperationError`).

| Marketplace | Storefront origin        |
| ----------- | ------------------------ |
| `ca`        | `https://www.newegg.ca`  |
| `us`        | `https://www.newegg.com` |
| `b2b`       | — (unsupported)          |

### 14.1 More Buying Options (all seller offers for a product)

```
GET https://www.newegg.ca/product/api/MoreBuyingOptions
      ?ParentItem=20-156-294
      &TabType=0&SortBy=0&FilterBy=&FirstCall=true&PageNum=1&PageSize=10
```

Required headers (omitting them can get the request blocked by the CDN):

| Header            | Value                                                |
| ----------------- | ---------------------------------------------------- |
| `User-Agent`      | a browser-like desktop UA string                     |
| `Accept`          | `application/json, text/plain, */*`                  |
| `Accept-Language` | `en-US,en;q=0.9`                                     |
| `Referer`         | the storefront origin, e.g. `https://www.newegg.ca/` |

`ParentItem` accepts **both** observed parent forms (both verified live):

- the dashed catalog form — `20-156-294`
- a marketplace-style parent CODE — `3C6-00T1-002H0`, `0D9-002W-000F0`

**ASSUMPTION**: `TabType` / `SortBy` / `FilterBy` / `FirstCall` / `PageNum` / `PageSize` were
copied from the retail page's own first-load request and echoed back unchanged; only their
observed values are known to work. Paging beyond page 1 was not exercised.

**Response.** HTTP `200` with `content-type: text/plain` — but the body **IS JSON**. Parse by
shape, never by content type.

```json
{
  "ItemInfo": [
    {
      "Item": "20-156-294",
      "UnitCost": 129.99,
      "ShippingCharge": 0.01,
      "Instock": true,
      "Active": "1",
      "IsActivated": true,
      "Seller": null
    },
    {
      "Item": "9SIXXXXXXXXXXX",
      "UnitCost": 134.5,
      "ShippingCharge": 0,
      "Instock": true,
      "Active": "1",
      "IsActivated": true,
      "Seller": { "SellerId": "XXXX", "SellerName": "Example Seller Inc", "SellerRating": 4.8 }
    }
  ],
  "TabInfo": [],
  "Total": 2,
  "CurrentPageNum": 1,
  "PageCount": 1
}
```

Field notes (only the fields the SDK relies on; each row carries many more):

| Field            | Notes                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Item`           | The offer's item number. **Newegg first-party offers echo the PARENT catalog number** (e.g. `20-156-294`); marketplace offers carry the seller offer number (`9SI…`).                                                                |
| `UnitCost`       | Offer price, storefront currency (CAD on `.ca`). Number in observation; coerce defensively.                                                                                                                                          |
| `ShippingCharge` | **CAUTION: `0.01` is observed on offers the page itself labels "Free Shipping".** It is a raw/sentinel value — a non-zero `ShippingCharge` does NOT reliably mean paid shipping. Expose as-is; do not derive a landed price from it. |
| `Instock`        | Boolean.                                                                                                                                                                                                                             |
| `Active`         | String `"1"` / `"0"`; `IsActivated` is the boolean twin. Either may be missing — read both.                                                                                                                                          |
| `Seller`         | Object **or null**. `null` (or `{ "SellerId": "", "SellerName": null }`) ⇒ the offer is **Newegg first-party**. Marketplace offers carry `SellerId` + `SellerName` (+ `SellerRating`, …).                                            |
| `Total`          | Offer count for the product. `CurrentPageNum` / `PageCount` describe paging.                                                                                                                                                         |

**ASSUMPTION — offer ordering is the buy box.** `ItemInfo` ordering appears to be the
storefront's featured ranking: in every observation the **first** entry matched the offer shown
in the page's buy box. This is not documented and not guaranteed; the SDK surfaces
`buyBox = offers[0]` under exactly this assumption.

**ASSUMPTION — deactivated/out-of-stock rows.** Rows with `Active: "0"` / `Instock: false` were
observed in the list; whether the storefront always includes them (and whether they can ever rank
first) is unverified.

### 14.2 Parent-number resolution from a seller offer number

MoreBuyingOptions is keyed by the **parent** product, not by a seller offer number. Given a `9SI…`
offer number, the public product page redirects to its parent (verified live 2026-07-31):

```
GET https://www.newegg.ca/p/<offerNumber>      (redirect: "manual" — do NOT follow)
→ 301, Location: …
```

Two `Location` shapes were observed; both yield a usable `ParentItem`:

| `Location`                                       | Parent                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `https://www.newegg.ca/<slug>/p/N82E168XXXXXXXX` | dashed numeric form of the 8 digits: `N82E16820156294` → `20-156-294` (`XX-XXX-XXX`)         |
| `https://www.newegg.ca/p/<CODE>`                 | the CODE itself (`3C6-00T1-002H0`, `0D9-002W-000F0`) — pass straight through as `ParentItem` |

The redirect target **is** the answer, so the request must use manual redirect handling. No
`Location`, or a `Location` with no `/p/<value>` segment, is a hard failure (the SDK throws
`NeweggApiError`) — never silently fall back to the offer number.

**ASSUMPTION**: the `N82E168` prefix is treated as fixed-width (`N82E16` + one category digit +
the 8 catalog digits); only 15-character product-page numbers were observed.

### 14.3 SDK mapping

`client.storefront.getOffers({ itemNumber })` → one §14.1 request;
`client.storefront.getOffers({ offerNumber })` → one §14.2 redirect probe, then one §14.1 request.
Offers are normalized to `{ offerItemNumber, sellerName, sellerId, isNewegg, price,
shippingCharge, inStock, active }`; rows without an item number or a parseable price are dropped.
No local rate-limit budget is applied (these are not seller-API calls and carry no
`X-RateLimit-*` headers) — callers should throttle their own polling.

## 15. Pricing (reads)

> Extracted 2026-10-10 from the official Newegg Developer Portal. Pages cited per subsection;
> every fact is dated 2026-10-10 (the portal marks the page bodies "Last updated August 28, 2020").
> Only the **read** operation (Get Item Price) is contracted here and implemented
> (`client.pricing.get/tryGet/getMany`, MCP `newegg_pricing_get`). The price **write** endpoints
> are named in §15.1 for classification only.

### 15.1 Operation inventory and classification

Source: `https://developer.newegg.com/newegg_marketplace_api/item_management` (2026-10-10).

| Operation (portal title)         | Platforms  | Verb + path (under the §2 prefix)                           | Class     | In SDK                       |
| -------------------------------- | ---------- | ----------------------------------------------------------- | --------- | ---------------------------- |
| Get Item Price                   | Newegg.com | `PUT contentmgmt/item/international/price`                  | **READ**  | yes                          |
| Get Item Price (B2B and CAN)     | B2B, CAN   | `POST {b2b,can}/contentmgmt/item/price`                     | **READ**  | yes                          |
| Get Batch Price                  | Newegg.com | page not retrievable (§15.4)                                | READ      | no                           |
| Get Batch Price (B2B and CAN)    | B2B, CAN   | page not retrievable (§15.4)                                | READ      | no                           |
| Update Item Price                | Newegg.com | `POST contentmgmt/item/international/price` (**same URL**)  | **WRITE** | no                           |
| Update Inventory and Price       | B2B, CAN   | `PUT {b2b,can}/contentmgmt/item/inventoryandprice` (§6.2)   | **WRITE** | inventory-only subset (§6.2) |
| Price Update Feed (`PRICE_DATA`) | Newegg.com | `POST datafeedmgmt/feeds/submitfeed?requesttype=PRICE_DATA` | **WRITE** | no                           |

The index page also lists Volume Discount Creation/Update/Removal, Get Volume Discount Request
Result, Item Repricer and Get Item Repricer Setting (names only; no bodies fetched — out of scope).

**Verbs do not imply safety here (cf. §2, §6.1, §10.2).** The US price URL is **read-on-PUT /
write-on-POST**; the B2B/CAN read is a POST. The classification above comes from each page's own
description ("Retrieves price-related information…" vs "Updates price, shipping, and/or status…"),
never from the verb.

### 15.2 US — Get Item Price

Source: `https://developer.newegg.com/documents/newegg_marketplace_api/item_management/get_price/`
(2026-10-10).

```
PUT https://api.newegg.com/marketplace/contentmgmt/item/international/price?sellerid={SellerID}
```

Auth required; XML/JSON in and out; documented rate limit **10,000 requests/hour** (no per-minute
figure — the generic §3 per-minute window and 429 still apply). Only the US page lists this
endpoint; it is **Newegg.com only**.

Request (`Type`/`Value` as §4; `Condition` only when `Type` = `2`, default 1 = New; the page's
condition table renders here: 1 New · 2 Refurbished · 3 Used–Like New · 4 Used–Very Good ·
5 Used–Good · 6 Used–Acceptable — confirming the §4 mapping):

```json
{
  "Type": "1",
  "Value": "A006testitem201201021459",
  "CountryList": { "CountryCode": ["USA", "AUS"] }
}
```

The field table lists a single string `CountryCode` ("3-letter ISO code of the seller's warehouse
location; defaults to All if blank") while the official JSON sample uses the `CountryList` wrapper
above. **ASSUMPTION:** the SDK sends the sample's `CountryList.CountryCode[]` form, and only when
the caller passes `countries`; omitting it returns every country (documented default).

Response — one `Price` per destination country, as an object when single and an array otherwise
(§2 quirk). The sample is all strings (numbers **and** `"0"/"1"` flags):

```json
{
  "SellerID": "A006",
  "ItemNumber": "9SIA0060884598",
  "SellerPartNumber": "A006testitem201201021459",
  "PriceList": {
    "Price": [
      {
        "CountryCode": "USA",
        "Currency": "USD",
        "Active": "0",
        "MAP": "25.99",
        "CheckoutMAP": "0",
        "SellingPrice": "20.92",
        "EnableFreeShipping": "1",
        "OnPromotion": "1,5",
        "LimitQuantity": "2"
      },
      { "CountryCode": "IND", "Currency": "INR", "SellingPrice": "389.92" },
      { "CountryCode": "IRL", "Currency": "EUR", "LimitQuantity": "2" }
    ]
  }
}
```

(The IND/IRL rows are abbreviated here; in the official sample they carry the same fields, and the
IRL row omits `OnPromotion` entirely.)

| Field                | Notes (documented)                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Currency`           | ISO 4217 string for `SellingPrice`/`MSRP`/`MAP` in that country (the table says "Integer" but every sample is a string — treated as a string).                 |
| `MSRP`               | Decimal 0.00–99999.00, "supported for all sellers". **Not shown in any sample payload** — parsed when present, never required (**ASSUMPTION** it is returned). |
| `MAP`                | Minimum advertised price; below it the shopper must add to cart to see the price.                                                                              |
| `CheckoutMAP`        | `0`/`1`. `1` ⇒ price only at checkout and `MAP` is ignored; `MAP` > 0 with blank `CheckoutMAP` defaults to false.                                              |
| `SellingPrice`       | The actual price.                                                                                                                                              |
| `EnableFreeShipping` | `0` default · `1` free shipping.                                                                                                                               |
| `OnPromotion`        | Comma-separated codes: `0` none · `1` Price Lock · `2` Promotion Code · `3` Auto Add To Cart · `4` Combo · `5` Volume Discount. May be absent.                 |
| `Active`             | `0` inactive · `1` active (per country).                                                                                                                       |
| `LimitQuantity`      | Max units per customer per 48 h (max 500). `0` deletes the value and `null` means no update — **write-side wording** repeated on this read page.               |

Errors (documented): `CT001` invalid ItemNumber · `CT002` invalid SellerPartNumber · `CT003`
invalid UPCCode · `CT005` invalid action `Type` (0/1/2) · `CT010` no item with the specified
condition · `CT026` item not found. Body shape is the §1 JSON array
(`[{"Code":"CT002","Message":"Invalid SellerPartNumber"}]`); the XML form is
`<Errors><Error><Code/><Message/></Error></Errors>` (`CE003` for a malformed `Type`). Both
not-found codes are treated as "unknown item" by `tryGet` / `getMany` (**ASSUMPTION** —
extrapolated from the inventory reads, §5.2; not live-verified on this endpoint).

### 15.3 B2B / CAN — Get Item Price

Source: `https://developer.newegg.com/newegg_marketplace_api/item_management/get_item_price/`
(2026-10-10).

```
POST https://api.newegg.com/marketplace/b2b/contentmgmt/item/price?sellerid={SellerID}
POST https://api.newegg.com/marketplace/can/contentmgmt/item/price?sellerid={SellerID}
```

Auth required; XML/JSON; **10,000 requests/hour**. A **read** despite the POST verb. No `version`
parameter is documented. Request: `{ "Type": "1", "Value": "…" }` + optional `Condition` (UPC
only); **no country list**. Response is one flat record (XML root `<PriceResult>`); the JSON sample
mixes types — flags as strings, money and `LimitQuantity` as numbers:

```json
{
  "Active": "0",
  "ItemNumber": "9SIA0060884598",
  "SellerID": "A006",
  "SellerPartNumber": "A006testitem201201021459",
  "ShipByNewegg": "1",
  "EnableFreeShipping": "1",
  "MAP": 25.99,
  "CheckoutMAP": 0,
  "OnPromotion": "1,5",
  "SellingPrice": 20.92,
  "LimitQuantity": 1
}
```

Fields are as §15.2 minus `CountryCode`/`Currency`, plus `ShipByNewegg` (`0` ship by seller · `1`
ship by Newegg). `MSRP` is documented in the table and absent from the sample (same ASSUMPTION as
§15.2). Errors: the same six codes as §15.2.

**Currency (ASSUMPTION).** The B2B/CAN price response carries no currency and the read/update
pages state none. The only documented currency rule is the _Inventory And Price Feed (B2B and
CAN)_ page's `Currency` field
(`https://developer.newegg.com/newegg_marketplace_api/datafeed_management/submit_feed/inventory_and_price_feed/`,
2026-10-10): omitted ⇒ the platform default, **CAD for Newegg.ca, USD for Neweggbusiness.com**
(the same sentence also says "Newegg.com", an evident typo). The SDK therefore reports
`currency: "CAD"` (`ca`) / `"USD"` (`b2b`) with `currencyInferred: true`. Confirm against a real
account before repricing anything.

### 15.4 Batch price — documented, not retrievable

The index page lists **Get Batch Price** (Newegg.com: "…price-related information of specified
items for destination countries") and **Get Batch Price (B2B and CAN)** ("…price information for
multiple items in the default warehouse at once"), with these link targets (2026-10-10):
`…/item_management/get-batch-price/` and `…/item_management/get-batch-price-b2b-and-can/`. Every
URL form tried on 2026-10-10 returned HTTP 404 (with and without the `/documents/` segment, hyphen
and underscore slugs, with and without trailing slash, the `zh-hans` locale) — so request/response
shapes, size limits and rate limits are **unverified**. By analogy with the batch inventory reads
(§5.3/§5.4) the path would be `…/item/(international/)pricelist` with `{Type, Values[]}` — only a
guess (**ASSUMPTION**), **not implemented**. `client.pricing.getMany` instead fans out §15.2/§15.3
single reads (bounded concurrency, default 4; at most 100 identifiers per call as SDK policy; each
costs one request of the 10,000/hour budget) and aggregates per-identifier outcomes. Revisit when
the pages can be read.

### 15.5 What the price endpoint adds over the field-less `inventoryandprice` read (§6.2)

A field-less `PUT …/inventoryandprice` with `{Type,Value}` is, by live observation (§6.2), a
harmless no-op that echoes `SellingPrice`/`MAP`/`CheckoutMAP`/`EnableFreeShipping`/`LimitQuantity`/
`Active`/`AvailableQuantity`. The dedicated price read:

- is a **documented, side-effect-free read** (the `inventoryandprice` call is a write endpoint
  whose no-op behaviour is only an observation, and which silently drops fields on deactivated
  items);
- **adds** `OnPromotion` (promotion locks — locked items reject price/shipping edits with
  CT019/CT016), `ShipByNewegg` (B2B/CAN), and documents `MSRP`;
- on the US adds per-destination-country rows with `CountryCode` + `Currency` (the US price is
  per-country; there is no single "the price");
- **omits** `AvailableQuantity`, `FulfillmentOption` and `Result` (use the inventory reads for
  those);
- is subject to its own 10,000/hour budget.

MAP/CheckoutMAP/free-shipping/active/limit are present in both. Neither endpoint reveals the
buy-box competitor price — that is the unofficial storefront reader (§14).

### 15.6 SDK mapping

`client.pricing.get({ identifier, countries? })` → one §15.2 (`us`) or §15.3 (`b2b`/`ca`) request
(`platform/us.ts`, `platform/item-adapter.ts`); `countries` is ignored off the US. Normalized to
`ItemPriceSnapshot { itemNumber, sellerPartNumber, shippedByNewegg?, prices: PriceEntry[] }` where
`PriceEntry = { countryCode?, currency, currencyInferred, active?, msrp?, map?, checkoutMap?,
sellingPrice?, freeShipping?, promotions[], limitQuantity? }`. `tryGet` maps `CT026`/`CT010` to
`undefined`; `getMany` returns `{ items, missingIdentifiers, failures }` and still throws on
credential errors, exhausted rate limits and aborts. Retries follow ADR 0004's direct-operation
policy (reads are safe to retry).

**Not live-verified (2026-10-10):** the shapes above come from the docs' samples only. The live
suite has a read-only price test (`test/live/pricing-read.live.test.ts`) that was not run when
this section was written; promote the ASSUMPTIONs (country filter form, `MSRP` presence,
not-found codes, inferred currency) once it has been run against a real account.

## 16. Pricing (writes)

> Extracted 2026-10-10 from the official Newegg Developer Portal (pages marked "Last updated
> August 28, 2020"). **Implemented in code and mocked tests only; no price write has EVER been sent
> to a real account** (repo rule 2; `check:live-readonly` forbids the call and both endpoints in
> `test/live`). Everything below is therefore documented-shape, not live-verified, except where a
> row cites an earlier live observation.

### 16.1 US — Update Item Price

Source: `https://developer.newegg.com/newegg_marketplace_api/item_management/update-item-price/`
(2026-10-10).

```
POST https://api.newegg.com/marketplace/contentmgmt/item/international/price?sellerid={SellerID}
```

Same URL as the §15.2 read (**PUT = read, POST = write**). Rate limit 10,000 requests/hour.
Request fields: `Type` (0 NE item #, 1 seller part #, 2 UPC), `Value`, `Condition` (UPC only),
then `PriceList.Price[]` rows each with required `CountryCode` (ISO alpha-3) + `Currency` ("must
match CountryCode or the submission errors out", CT075) and optional `MSRP`, `MAP`, `CheckoutMAP`,
`SellingPrice`, `EnableFreeShipping`, `Active`, `LimitQuantity`. Documented omission semantics:
only `Active` and `LimitQuantity` are stated to mean "null = no change"; **the page does not state
what an omitted `SellingPrice`/`MAP`/… does** — **ASSUMPTION** (unverified): an omitted field is left
unchanged, as for B2B/CAN (§16.2).

The SDK therefore sends exactly one row per update:

```json
{
  "Type": "1",
  "Value": "<seller part #>",
  "PriceList": { "Price": [{ "CountryCode": "USA", "Currency": "USD", "SellingPrice": "20.92" }] }
}
```

No `Active`, `MAP`, `CheckoutMAP`, `MSRP`, `EnableFreeShipping` or `LimitQuantity` is ever sent.
Because of the omission ASSUMPTION the SDK warns on every US preview, and the owner currently has no
US API account to confirm it. Response: the same shape as the §15.2 read (root `<UpdatePriceResult>`
in XML); treated as success when it parses and contains no `Result: "0"`.

### 16.2 B2B / CAN — Update Inventory and Price (price-only use)

Source: the "Update Inventory and Price" page listed on
`https://developer.newegg.com/newegg_marketplace_api/item_management` (2026-10-10; same endpoint
as §6.2):

```
PUT https://api.newegg.com/marketplace/{b2b,can}/contentmgmt/item/inventoryandprice?sellerid={SellerID}
```

The SDK sends the **price-only subset** `{ "Type": "1", "Value": "SKU", "SellingPrice": "20.92" }`
(plus `Condition` for UPC). `Inventory`, `Active`, `MAP`, `CheckoutMAP`, `MSRP`, shipping and
`FulfillmentOption` are never sent. Omitting fields as "no change" is **verified live for this
endpoint** (§6.2: a field-less body is a harmless no-op, and the SDK's inventory-only bodies are
in production use; CA, 2026-07/09). That a **price-only** body leaves `Inventory`/`Active`
untouched is the same documented "null/omitted = no change" rule — **ASSUMPTION** until a price
write is ever authorized and observed. Response `UpdateInventoryAndPriceResult` (§6.2) — the echoed `SellingPrice` is
read, but the SDK **does not trust it** (see §16.4).

### 16.3 Error codes relevant to a price write

From the update pages' tables (2026-10-10): `CT007` selling price outside 0–99999.99 (2 decimals);
`CT032` selling price cannot be 0; `CT029` selling price cannot exceed MSRP; `CT019` item locked by
a promotion — selling price cannot be updated; `CT075` currency invalid for the country;
`CT050` activation fails below strict MAP; `CT067` MAP regulated by an existing Newegg setting;
`CT014`/`CT015` item unknown / not this seller's. The SDK pre-validates CT007/CT032 locally
(price in (0, 99999.99], ≤ 2 decimals) and **never rounds or clamps**; CT029/CT075/CT019 are
surfaced by `previewUpdate` as blockers/warnings when the current row reveals them.

### 16.4 Silent-success traps (why every write is read back)

- Updates to a **deactivated** item are "disregarded" yet reported successful (§6.2, live 2026-07-17).
- The write response's echoed price is not authoritative (cf. the unreliable `AvailableQuantity`
  echo, §6.2). The SDK verifies with a fresh §15 read of the same row (US: the same country).

### 16.5 Alternative not used: `PRICE_DATA` feed

`POST datafeedmgmt/feeds/submitfeed?requesttype=PRICE_DATA` (US) is asynchronous, indeterminate
(ADR 0004) and shares the feed-envelope risks; per ADR 0003 a handful of price changes go direct.
Not implemented. If it is ever added, the envelope `Overwrite` stays hard-coded `"No"`.

### 16.6 SDK mapping

`client.pricing.update(updates, { verify?, concurrency? })` (WRITE; 1–100 updates, one request
each, concurrency 2, own 10,000/hour budget `pricing.update`): validate → de-duplicate
(last-write-wins on identifier + condition + country) → write → read back →
`PriceUpdateResult` with per-item `verified | accepted | unverified | unknown | failed`.
Price assignments are absolute and idempotent, so the direct-operation retry policy applies
(408/429/502/503/504 and network errors, ADR 0004). If a write still fails ambiguously (timeout /
408 / 5xx / reset after dispatch) the SDK reads the price back: equal → `verified`, otherwise
`unknown` ("re-read before retrying"); nothing is thrown per item. `previewUpdate` is read-only and
computes the change percent plus blockers (unknown item, currency mismatch, price above MSRP) and
warnings (inactive, promotion lock, below MAP, no-op). MCP: `newegg_pricing_preview_update` →
`newegg_pricing_apply_update`, both registered only with `NEWEGG_MCP_ALLOW_WRITES=true`; the
preview additionally blocks a change larger than `NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT` (default 50)
and stores only the eligible updates under the single-use `previewId` (ADR 0005).

**ASSUMPTIONs to retire when a write is ever authorized and run:** US omission semantics (§16.1),
the US write response shape, `CT029` on the B2B/CAN endpoint, and whether the B2B/CAN echoed
`SellingPrice` reflects a deactivated item's real price.

## 17. Reports Management — Settlement, Daily Inventory/Price, Item Basic Info, Order List and RMA List reports (reads)

Extracted 2026-10-10 from the official Reports Management pages (all under
`https://developer.newegg.com/newegg_marketplace_api/reports_management/`; the `submit_report_request/`
index page was last updated 2018-10-15, `get_report_result/` 2021-10-28):

| Report                        | Submit page (`submit_report_request/…`)           | Result page (`get_report_result/…`)                                                                                                                         |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settlement Summary            | `submit_settlement_summary_report/`               | `get_settlement_summary_report/`                                                                                                                            |
| Settlement Transaction        | `submit_settlement_transaction_report/`           | `get_settlement_transaction_report/`                                                                                                                        |
| Daily Inventory (Newegg.com)  | `submit_daily_inventory_report/`                  | `get_daily_inventory_report/`                                                                                                                               |
| Daily Inventory (B2B and CAN) | `submit_daily_inventory_report_b2b_can/`          | `get_daily_inventory_report_b2b_can/`                                                                                                                       |
| Daily Price (Newegg.com only) | `submit_daily_price_report/`                      | `get_daily_price_report/`                                                                                                                                   |
| Order List                    | `submit_order_list_report/`                       | `get_order_list_report/`                                                                                                                                    |
| RMA List                      | `submit_rma_list_report/`                         | `get_rma_list_report/`                                                                                                                                      |
| Item Basic Information        | `submit-item-basic-info-report/` (hyphens)        | `get-item-basic-information-report/` — **404 on 2026-10-10** (linked from the result index, page missing); the file columns below are live-verified instead |
| Status (all report types)     | `https://…/reports_management/get_report_status/` | —                                                                                                                                                           |

The lifecycle is §12's: `POST reportmgmt/report/submitrequest` (100/hour) → `PUT
reportmgmt/report/status` (500/hour) → `PUT reportmgmt/report/result` (500/hour), on every platform
via the standard prefix. **Classification: all READS** (owner-approved in §12; a report submission
creates a report job and mutates nothing). The SDK shares one implementation of the lifecycle between
the Item Lookup report and these (`packages/sdk/src/reportmgmt/`).

Common to every type:

- Submit body is `{ OperationType, RequestBody: { <Criteria>: { RequestType, … } } }`. The optional
  `IssueUser` (a registered Seller Portal email; defaults to the seller id) is **not sent** by the SDK.
- The submit response is §12.1's: `ResponseBody.ResponseList[0].{RequestId, RequestType, RequestDate,
RequestStatus: "SUBMITTED"}` (object-or-array; XML wraps `ResponseInfo`). The docs' field tables
  misspell the status field `RequestSatus`; every sample uses `RequestStatus` (the SDK reads both).
- Status is §12.2's. `RequestType` values documented for status filtering: `ALL`, `ORDER_LIST_REPORT`,
  `SETTLEMENT_SUMMARY_REPORT`, `SETTLEMENT_TRASACTION_REPORT` (sic — the status page's spelling; the
  submit page and the SDK use `SETTLEMENT_TRANSACTION_REPORT`), `DAILY_INVENTORY_REPORT`,
  `RMA_LIST_REPORT`, `ITEM_LOOKUP`, `INTERNATIONAL_INVENTORY_REPORT`, `INTERNATIONAL_PRICE_REPORT`,
  `CAPROP65_REPORT`, `ITEM_BASIC_INFO_REPORT` (+ `PREMIER_ITEM_REPORT` in responses). Status values:
  `SUBMITTED | IN_PROGRESS | FINISHED | CANCELLED`. `RP004`–`RP007` are the status date-filter errors.
- The submit pages share one copy-pasted error table: `RP010` invalid order number, `RP018` invalid
  settlement date, `RP019` request id null/empty, `RP020` missing settlement criteria, `RP021` more than
  1,000 lookup items, `RP022` Daily Inventory multi-warehouse. Most do not apply to the report they
  appear under (RP022 even contradicts the Daily Inventory sample, which submits two warehouses). Treat
  the codes as hints and surface `Message`.
- All dates are Pacific Time. Samples use `YYYY-MM-DD` (`2011-12-01`) and `M/D/YYYY` (`2/23/2012`); the
  docs defer to an "Acceptable Date Format" page that was not fetched (**ASSUMPTION**: `YYYY-MM-DD` and
  `M/D/YYYY[ H:mm:ss]` are accepted; the SDK sends the caller's string, or a `Date` rendered as its
  Pacific `YYYY-MM-DD`).
- Throttling: submit 100/hour, status 500/hour, result 500/hour per seller (no per-minute figure is
  listed); 429 `[{"Code":"429",…}]` and the `X-RateLimit-*` headers follow §3. The submit budget is
  shared by every report type (and the §12 lookup).
- Error bodies: JSON array `[{"Code":"CE001","Message":"SellerID cannot be null or empty"}]` or the XML
  `<Errors><Error><Code>…` form (§1); `errors/parse-upstream.ts` normalizes both.

### 17.1 Which reports are paged-inline and which are files

| Report                 | Result delivery                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Settlement Summary     | inline JSON, **paged** (`PageInfo`, max 100 rows/page)                                         |
| Settlement Transaction | inline JSON, **paged** (max 100 rows/page)                                                     |
| Order List             | inline JSON, paged (max 100/page; `OrderInfoList`, §10.1-like) — live-verified                 |
| RMA List               | inline JSON, paged (max 100/page; `RMAInfoList`) — live-verified                               |
| Daily Inventory        | **file** — `ResponseBody.ReportFileURL` (FTP, embedded credentials)                            |
| Daily Price            | **file** — `ResponseBody.ReportFileURL` (FTP, embedded credentials)                            |
| Item Basic Information | **file** — same `ReportFileURL` shape, zipped (live-verified on CAN 2026-09-01 and 2026-10-10) |

### 17.2 Settlement Summary report

Submit — `POST {prefix}reportmgmt/report/submitrequest?sellerid={sellerid}` (all three platforms):

```json
{
  "OperationType": "SettlementSummaryReportRequest",
  "RequestBody": {
    "SettlementSummaryReportCriteria": {
      "RequestType": "SETTLEMENT_SUMMARY_REPORT",
      "DateFrom": "2011-12-01",
      "DateTo": "2011-12-30"
    }
  }
}
```

`DateFrom` and `DateTo` are both required (Pacific). The page states **no maximum range**
(**ASSUMPTION**: none is enforced). Response `OperationType`: `SettlementSummaryReportResponse`,
`RequestType`: `SETTLEMENT_SUMMARY_REPORT`.

Result — `PUT {prefix}reportmgmt/report/result?sellerid={sellerid}[&version={version}]` (500/hour):

```json
{
  "OperationType": "SettlementSummaryReportRequest",
  "RequestBody": { "RequestID": "<id>", "PageInfo": { "PageSize": "10", "PageIndex": "1" } }
}
```

`PageSize` max 100. Response `OperationType`: `GetSettlementSummaryInfoResponse`. The documented
sample is wrapped in `NeweggAPIResponse` (the parser accepts wrapped and unwrapped forms):

```json
{
  "NeweggAPIResponse": {
    "IsSuccess": "true",
    "SellerID": "A09D",
    "OperationType": "GetSettlementSummaryInfoResponse",
    "ResponseBody": {
      "PageInfo": { "TotalCount": "1", "TotalPageCount": "1", "PageSize": "10", "PageIndex": "1" },
      "RequestID": "2PQBZMZTL3DYF",
      "RequestDate": "2/21/2012 15:12:55",
      "SettlementSummaryList": [
        {
          "SettlementDate": "2/21/2012 12:00:00",
          "SettlementDateFrom": "8/5/2011 12:00:00",
          "SettlementDateTo": "2/21/2012 12:00:00",
          "SettlementID": "0",
          "ItemPrice": "71.00",
          "Shipping": "31.95",
          "TotalOrderAmount": "102.95",
          "TotalRefunds": "-184.51",
          "TotalNeweggFee": "-638.63",
          "TotalSettlement": "-720.19",
          "ReservedBalance": "12.22"
        }
      ]
    }
  }
}
```

(abbreviated; the values are the docs' placeholders, not account data). Row fields by group — every
amount is a **string**, USD on Newegg.com / Neweggbusiness.com and CAD on Newegg.ca:

- Order amounts: `SettlementDate`, `SettlementDateFrom`, `SettlementDateTo`, `SettlementID`, `ItemPrice`,
  `Shipping`, `TaxDuty`, `GSTTotal`, `HSTTotal`, `GSTAndHST`, `PSTTotal`, `PSTAndQST`, `EHFTotal`,
  `Other`, `RecyclingFeeTotal`, `TotalOrderAmount`.
- Refunds: `Refunds`, `ChargeBack`, `MiscellaneousAdjustment`, `CourtesyRefund`, `TotalRefunds`.
- Newegg fees: `NeweggCommissionFee`, `NeweggTransactionFee`, `NeweggRefundCommissionFee`,
  `NeweggMonthlyFee`, `NeweggStorageFee`, `NeweggRMABuyoutFee`, `NeweggServiceFeeTax`,
  `NeweggPremierFee`, `NeweggShippingLabelFee`, `CreditCardPayment`, `FulfillmentByNeweggFee`,
  `MultiChannelFee`, `AdjustmentFee`, `MerchandisingFee`, `TotalNeweggFee`.
- Totals: `TotalSettlement`, `SalesTaxFeeCollectedFromCustomer`, `SalesTaxFeesLiabilityShiftToNewegg`,
  `ReservedBalance`, `PreviousReservedBalance`; also `CheckNumber` (the BFUS sample shows `[]`) and `Memo`.

**`version` query (result request) — field sets by platform:**

| Version | Platform | Change                                                                                                                                                                                                                            |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 306     | B2B      | adds `RecyclingFeeTotal`                                                                                                                                                                                                          |
| 307     | all      | adds `NeweggShippingLabelFee`, `NeweggPremierFee`                                                                                                                                                                                 |
| 308     | US       | removes `Other`, `MiscellaneousAdjustment`, `NeweggTransactionFee`, `NeweggRMABuyoutFee`; adds `TaxDuty`, `CourtesyRefund`, `CreditCardPayment`, `FulfillmentByNeweggFee`, `MultiChannelFee`, `AdjustmentFee`, `MerchandisingFee` |
| 308     | B2B      | same removals; adds `CourtesyRefund`, `CreditCardPayment`, `FulfillmentByNeweggFee`, `MultiChannelFee`, `AdjustmentFee`, `MerchandisingFee`                                                                                       |
| 308     | CAN      | removes `GSTTotal`, `HSTTotal`, `PSTTotal` and the same four as US; adds `GSTAndHST`, `PSTAndQST` and the six B2B additions                                                                                                       |
| 309     | US       | adds `RecyclingFeeTotal`                                                                                                                                                                                                          |
| 310     | all      | adds `ReservedBalance`, `PreviousReservedBalance`                                                                                                                                                                                 |
| 313     | all      | adds `SalesTaxFeeCollectedFromCustomer`, `SalesTaxFeesLiabilityShiftToNewegg`                                                                                                                                                     |

Quirks: the JSON sample misspells the key `SalerTaxFeeCollectedFromCustomer` and omits commas; it also
mixes fields from different versions; the CAN URL on the page is mistyped (`sellerid={sellerid}={version}`).
The SDK defaults `version` to **313** (newest field set — **ASSUMPTION**: accepted on all three
platforms) and lets the caller override it. An absent field means "not reported", never zero.

### 17.3 Settlement Transaction report

Submit (all platforms, 100/hour):

```json
{
  "OperationType": "SettlementTransactionReportRequest",
  "RequestBody": {
    "SettlementTransactionReportCriteria": {
      "RequestType": "SETTLEMENT_TRANSACTION_REPORT",
      "TransactionType": "1",
      "SettlementDateFrom": "2011-02-21",
      "SettlementDateTo": "2012-02-22",
      "SettlementDate": "2/23/2012"
    }
  }
}
```

All criteria are optional **but** Newegg answers `RP020` unless `SettlementID`, `SettlementDate`, **or**
both `SettlementDateFrom` and `SettlementDateTo` is present — the SDK enforces this before sending.
Other criteria: `OrderNumber` (integer) and `TransactionType` (integer, default `0` = all; the sample sends
the string `"1"`). The page states no maximum range. Response `OperationType`:
`SettlementTransactionReportResponse`.

`TransactionType`: 0 All · 1 Order · 2 Refund · 3 Credit request · 4 Chargeback · 5 Monthly fee ·
6 Fulfill by Newegg fee · 7 Multi-channel fee · 8 RMA processing fee · 9 Tax & duty · 10 Storage fee ·
11 RMA buyout fee · 12 Adjustment fee · 13 Monthly fee by credit card · 14 SBN inbound fee ·
15 Merchandising fee · 16 Newegg Premier fee · 17 Newegg shipping label fee · 18 Return and disposal fee ·
19 Newegg relabeling fee · 20 Recycling fee / EHF · 21 Return shipping label fee · 22 Newegg service fee
tax (Newegg.ca only) · 23 Print shipping label service · 24 Reserved balance · 25 Previous reserved
balance · 26 Commission incentive refund · 27 Unsold listing fee · 28 Order processing fee · 29 Sales
tax/fees · 30 SBN inbound incompliance charges · 31 Sponsored ads · 32 Item overage fee.

Result — the same `PUT reportmgmt/report/result` request as §17.2 with
`OperationType: "SettlementTransactionReportRequest"` (no `version` documented). Response
`OperationType`: `GetSettlementTransactionInfoResponse`; rows live in
`ResponseBody.SettlementTransactionInfoList` (XML: `> SettlementTransactionInfo`) beside `PageInfo`,
`RequestID` and `RequestDate`:

```json
{
  "NeweggAPIResponse": {
    "IsSuccess": "true",
    "SellerID": "A09D",
    "OperationType": "GetSettlementTransactionInfoResponse",
    "ResponseBody": {
      "PageInfo": {
        "TotalCount": "21",
        "TotalPageCount": "21",
        "PageSize": "10",
        "PageIndex": "1"
      },
      "RequestID": "2PQDKCAQFHL3M",
      "RequestDate": "2/23/2012 11:39:00",
      "SettlementTransactionInfoList": [
        {
          "TransactionDate": "8/9/2011 12:00:00",
          "TransactionType": "Order",
          "OrderID": "87123017",
          "InvoiceID": "75994476",
          "SellerPartNumber": "A09D77897686",
          "NeweggItemNumber": "9SIA00X0002HJ5",
          "ItemDescription": "dfdfgsdfg",
          "ItemCondition": "New",
          "Amount": "10.00",
          "Shipping": "2.00",
          "CommissionFee": "-0.75",
          "SettlementID": "null"
        }
      ]
    },
    "Memo": null
  }
}
```

`ItemCondition` is a label (New, Refurbished, Used – Like New, Used – Very Good, Used – Good,
Used – Acceptable); amounts are USD (Newegg.com, Neweggbusiness.com) or CAD (Newegg.ca); `SettlementID` and
`Memo` may be the literal string `"null"` or JSON null (the SDK treats both as absent).

### 17.4 Daily Inventory report (file)

**Newegg.com** — submit `POST reportmgmt/report/submitrequest?sellerid=&version=310`. The `version` is
documented as required with `310` the only value: for sellers with more than 40,000 items the report is
split into 40,000-record files **zipped into one package**.

```json
{
  "OperationType": "InternationalInventoryReportRequest",
  "RequestBody": {
    "DailyInventoryReportCriteria": {
      "FulfillType": "0",
      "WarehouseList": { "WarehouseLocation": ["USA", "AUS"] },
      "RequestType": "INTERNATIONAL_INVENTORY_REPORT",
      "FileType": "XLS"
    }
  }
}
```

`FulfillType`: `0` all (default) · `1` Fulfill by Seller · `2` Fulfill by Newegg. `WarehouseLocation`: 3-letter
ISO code(s), blank = all (each region allows one SBS warehouse). `FileType`: `TXT` (default) · `CSV` ·
`XLS`. Response `OperationType`: `InternationalInventoryReportResponse`, `RequestType`:
`INTERNATIONAL_INVENTORY_REPORT`.

**Neweggbusiness.com / Newegg.ca** — the same endpoint under `b2b/` / `can/`, `version=310`,
`OperationType: "DailyInventoryReportRequest"`, criteria `{ FulfillType, RequestType:
"DAILY_INVENTORY_REPORT", FileType }` (no warehouse list: the single default warehouse). Response
`OperationType`: `DailyInventoryReportResponse`.

Result — `PUT {prefix}reportmgmt/report/result?sellerid=` with `{ "OperationType":
"<InternationalInventoryReportRequest | DailyInventoryReportRequest>", "RequestBody": { "RequestID": "<id>" } }`
(no paging). The B2B/CAN page shows its request URL **without** the `b2b`/`can` segment — treated as a doc
slip; the SDK uses the platform prefix. The response has an odd `NeweggAPIResponse` wrapper and `sellerID`
casing:

```json
{
  "NeweggAPIResponse": {
    "IsSuccess": "true",
    "sellerID": "A006",
    "OperationType": "InternationalInventoryReportResponse",
    "ResponseBody": {
      "RequestID": "2PQC13C7UYDPQ",
      "RequestType": "INTERNATIONAL_INVENTORY_REPORT",
      "RequestDate": "2/21/2012 15:32:57",
      "ReportFileURL": "ftp://<user>:<password>@ftp03.newegg.com/InternationalInventoryReport_2PQC13C7UYDPQ.xls"
    },
    "Memo": null
  }
}
```

The B2B/CAN result `OperationType` is written `DailyinventoryReportResponse` (sic).

File columns. **US:** `Seller Part #`, `NE Item #`, `Warehouse Location`, `Fulfillment Option` ("Seller
Only"), `Inventory`. **B2B/CAN:** `Seller Part #`, `NE Item #`, `Currency` (blank = USD on the US
marketplace / CAD on Canada), `MSRP` (0.00–99999.00), `Support MSRP for all seller`, `MAP`, `Checkout MAP`,
`Selling Price`, `Inventory`, `Fulfillment Option` (`Newegg` | `Seller`), `Shipping` (`default` | `free`),
`Activation Mark`, `Memo`. The pages do not state the TXT delimiter or encoding (**ASSUMPTION**: TXT is
tab-delimited with a header row and CSV is RFC 4180; the SDK detects the delimiter from the header line and
requests `CSV` by default) and show both `.txt` and `.xls` file names within one page, so the file-name
extension is not trustworthy.

### 17.5 Daily Price report (file; Newegg.com only)

Submit `POST reportmgmt/report/submitrequest?sellerid=&version=310` (the page's sample omits `version`):

```json
{
  "OperationType": "InternationalPriceReportRequest",
  "RequestBody": {
    "DailyPriceReportCriteria": {
      "CountryList": { "CountryCode": ["USA", "AUS"] },
      "RequestType": "INTERNATIONAL_PRICE_REPORT",
      "FileType": "XLS"
    }
  }
}
```

`CountryCode`: 3-letter ISO list, blank = all; `FileType` `TXT` (default) | `CSV` | `XLS`. Response types
`InternationalPriceReportResponse` / `INTERNATIONAL_PRICE_REPORT`. Result: `PUT …/report/result` with
`{ "OperationType": "InternationalPriceReportRequest", "RequestBody": { "RequestID": "<id>" } }` →
`NeweggAPIResponse.ResponseBody.ReportFileURL` as in §17.4. Columns: `Seller Part #`, `NE Item #`,
`CountryCode`, `Currency`, `MSRP`, `MAP`, `Checkout MAP`, `Selling Price`, `Shipping` (`default` | `free`),
`Activation Mark`, `Memo`. The page lists only the Newegg.com URL: B2B/CAN have **no** Daily Price report
(their price columns ride on the B2B/CAN Daily Inventory report).

**The `ReportFileURL` is a secret.** It is `ftp://{user}:{password}@ftp03.newegg.com/{file}` with credentials
embedded (live-verified on the Item Basic Information report, CAN 2026-09-01). Never
log it, put it in an error, return it from an MCP tool or store it in the repo. The SDK withholds the URL
from every public type (`ReportFileInfo` exposes only the host and file name), redacts `user:pass@` in every
`raw` payload (`includeRaw`), downloads over FTP itself (passive mode, host allow-list `*.newegg.com`, size
caps) or through the caller's `reportFileDownloader`, and keeps the URL out of thrown errors.

### 17.6 Order List and RMA List reports

Verified 2026-10-10 against `submit_order_list_report/`, `get_order_list_report/`,
`submit_rma_list_report/` and `get_rma_list_report/` (base `https://developer.newegg.com/newegg_marketplace_api/reports_management/`)
and live on CAN (below). Now wrapped as `client.reports.orderList` / `rmaList`: unlike Get Order Information
(§10) and Get RMA Information (§18) these are asynchronous jobs, so they suit large date ranges; the rows
reuse the §10.1 / §18.1 mappers. The submit pages state 100 submissions/hour, the result pages 500/hour, and
share the copy-pasted RP error table (§17 preamble).

- **Order List** — submit `OperationType: "OrderListReportRequest"`, criteria `OrderReportCriteria`
  `{ RequestType: "ORDER_LIST_REPORT", KeywordsType (0 all · 1 OrderNumber · 2 InvoiceNumber · 3 CustomerName
· 4 SellerPartNumber · 5 NeweggItemNumber · 6 CustomerPhoneNumber · 7 TitleDescription · 8 Manufacturer ·
9 SellerOrderNumber), KeywordsValue, Status (0 Unshipped · 1 Partially Shipped · 2 Shipped · 3 Invoiced ·
4 Voided · 5 Payment Pending; required), Type (0 all · 1 SBN · 2 SBS · 3 Multi-Channel), OrderDateFrom,
OrderDateTo, VoidSoon (24 | 48), OrderDownloaded ("false" includes downloaded orders), CountryCode (US
only), PremierOrder (0 | 1 | 2; US only) }`. Result: inline paged (100/page), response
  `GetOrderInfoResponse`, with a required `version` query (305 B2B/CAN adds `SellerOrderNumber`; 306 US adds it
  and B2B adds `RecyclingFeeAmount`; 307 US adds `SalesTax`/`VATTotal`/`DutyTotal`; 309 all add replacement
  order numbers; 310 US adds `AutoRegWarranty`). Rows are §10.1's order-info shape (`OrderInfoList >
OrderInfo`, `ItemInfoList`, `PackageInfoList`).
- **RMA List** — submit `OperationType: "RMAListReportRequest"`, criteria `RMAListReportCriteria`
  `{ RequestType: "RMA_LIST_REPORT", KeywordsType (0 all · 1 RMANumber · 2 OrderNumber · 3 CustomerName · 4
SellerRMANumber), KeywordsValue, Status (0 all · 1 Open · 2 Received · 3 Rejected · 4 Voided · 5 Closed ·
6 Processing), RMADateFrom, RMADateTo, RMAType (0 all · 1 Replacement · 2 Refund), ProcessedBy (0 all ·
1 Seller · 2 Newegg) }`. Result: inline paged, response `GetRMAListInfoResponse`, `version` query (305
  B2B/CAN; 306/307 US; 309 all; 320 all) selects the field set; rows in `RMAInfoList > RMAInfo` with an
  `RMATransactionList > RMATransaction` per SKU. The page's samples disagree with its own field table
  (nested `RefundInfo`, `ReturnShippingLabel > Label`); **live-verified** below: the samples win.

Request details (the same on all three platforms unless noted):

- Order List `Status` is **required** (an omitted status is not defaulted by the SDK); `KeywordsType` defaults
  to `0` and `KeywordsValue` is ignored then. `OrderDownloaded` is inverted: `"false"` includes downloaded
  orders (default), `"true"` excludes them. `CountryCode` / `PremierOrder` are **Newegg.com only** (the SDK
  rejects them on B2B/CAN before spending a submission). Wire values are sent as strings, as in the samples.
- The result request is `{ OperationType: "OrderListReportRequest" | "RMAListReportRequest", RequestBody: {
RequestID, PageInfo: { PageIndex, PageSize } } }` plus the **required** `version` query. Documented versions:
  Order List — 305 (B2B/CAN: `SellerOrderNumber`), 306 (US: `SellerOrderNumber`; B2B: `RecyclingFeeAmount`),
  307 (US: `SalesTax`/`VATTotal`/`DutyTotal`), 309 (all: replacement order numbers; US adds
  `RecyclingFeeAmount`), 310 (US: `AutoRegWarranty`); RMA List — 305 (B2B/CAN), 306/307 (US), 309 (all), 320
  (all: return-shipping label). The SDK validates `version` against the platform's documented set
  (`platform/reports.ts`) and defaults Order List to **309**, RMA List to **320**. **ASSUMPTION:** versions
  outside that set (e.g. Order List 315, which Get Order Information accepts) are rejected by Newegg too.
- RMA List `Status` default `0` = all; `RMAType` / `ProcessedBy` default `0`; response `OperationType`s are
  `GetOrderInfoResponse` / `GetRMAListInfoResponse`. The RMA row additionally carries flat `CustomerAddress`
  (one string), `LastEditUser` (can be a user e-mail) and `RMANote` — all PII-class, never mapped to an MCP tool.

**Live verification (CAN, 2026-10-10, read-only; no account values recorded).**

- Order List: submit/status/result all work with `version=309`. A query with no matching orders is
  `FINISHED` within ~30 s and the result carries `PageInfo` (`TotalCount: 0`) but **no `OrderInfoList` key at
  all** (not `""`, not `[]`). With data, `OrderInfoList` is a bare JSON array of `OrderInfo` (27 rows on one
  page matched the synchronous Get Order Information count for the same status). The row shape equals §10.1
  plus Newegg.ca's `GSTorHSTAmount`, `PSTorQSTAmount` and `EHFAmount` (now `OrderAmounts.gstOrHstAmount` /
  `pstOrQstAmount` / `ehfAmount`), `UnitShippingCharge` (unmapped) and **package lines nested under
  `PackageInfoList[].ItemInfoList[]`** (`SellerPartNumber`, `MfrPartNumber`, `ShippedQty`) instead of the
  flat package fields of the field table (now `OrderPackage.items`). `IsSuccess` is a real boolean, the
  numeric ids arrive as numbers, `SellerOrderNumber` as `""`.
- RMA List: `RMAInfoList` is a bare array; every row has `RMANumber` (number), `SellerRMANumber` (`""`),
  `RMAType`/`RMAStatus` (numbers) with descriptions, `LastEditDate`/`LastEditUser`, `OrderNumber`, `OrderAmount`,
  `RMAProcessedBy`, the customer block (`CustomerName`, `CustomerPhoneNumber`, a flat `CustomerAddress`),
  `RMAReceiveDate`, `RMANote`, `RefundGSTorHSTAmount`/`RefundPSTorQSTAmount` (CAN), `ReturnShippingLabel` (an
  **array** of `{TrackingNumber, TrackingURL, LabelEstimateCost, PaidBy}`) and `RMATransactionList` (an array).
  Each transaction nests **`RefundInfo`** = `{ItemReturnQty, ItemRefundPerQty, ItemShippingRefund,
RMATotalRefund, RefundReason (number), RefundReasonDescription}` — different names from Get RMA Information's
  flat `ReturnQuantity` / `ReturnUnitPrice` / `RefundShippingPrice` / `RMAReason`; the SDK flattens and aliases
  them (`ReplacementReason*` the same way, **ASSUMPTION** for replacement RMAs: none existed to verify).
  `RMATotalRefund` is exposed per line as `RmaItem.rmaTotalRefund` (documented as the RMA total; whether it
  repeats on every line of a multi-line RMA is **ASSUMPTION**-unverified).
- Timing: with the three reports running concurrently, Item Basic Info took ~214 s, RMA List ~137 s (2 RMAs),
  Order List ~258 s (27 orders), and an empty-result Order List ~31 s. Newegg builds them in a background job,
  so the SDK's wait budget for these three is 300 s (`REPORT_LIST_TIMEOUT_MS`) and the MCP tools return
  `pending` + `requestId` after `waitSeconds`.

### 17.7 SDK mapping

`client.reports.*` — all READS, none gated; the MCP tools register unconditionally:

| SDK                                                                         | Wire                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `settlementSummary.submit/status/result/waitForRequest/waitForResult`       | §17.2 (paged inline, `version` default 313)                                  |
| `settlementTransactions.…`                                                  | §17.3 (paged inline; the RP020 rule is enforced client-side)                 |
| `dailyInventory.submit/status/result/download/waitForRequest/waitForResult` | §17.4 (file; US vs B2B/CAN differences live in `platform/reports.ts`)        |
| `dailyPrice.…`                                                              | §17.5 (file; US only — B2B/CAN throw `UnsupportedMarketplaceOperationError`) |
| `itemBasicInfo.submit/status/result/download/waitForRequest/waitForResult`  | §17.8 (file; identical request on every platform)                            |
| `orderList.submit/status/result/waitForRequest/waitForResult`               | §17.6 (paged inline, `version` default 309, rows = `Order`)                  |
| `rmaList.…`                                                                 | §17.6 (paged inline, `version` default 320, rows = `Rma`)                    |
| `status(requestId)`                                                         | §12.2 (report-type independent)                                              |

`waitFor*` polls with `pollIntervalMs` (2 s) ×1.5 per poll up to 15 s inside a time budget - **300 s for
the two settlement reports and for Item Basic Info / Order List / RMA List, 120 s for the daily file reports**
(changed 2026-10-10: a Settlement Summary took about 170 s live, see below; an explicit `timeoutMs` always
wins) - then throws
`ReportTimeoutError` carrying the `requestId` (continue with `waitForRequest(requestId)`; never resubmit —
100/hour). A CANCELLED report throws a non-retryable `ReportTimeoutError`. Paged reports are fetched up to
`maxPages` (default 50 → 5,000 rows) and flagged `truncated` beyond it; file reports keep at most `maxRows`
parsed rows (default 50,000) and report the full `totalRows`.

**ASSUMPTIONs (retire when verified live):** `YYYY-MM-DD` / `M/D/YYYY` date acceptance; settlement-summary
`version=313` accepted on every platform; no date-range cap on either settlement report; the TXT delimiter
(tab) and UTF-8 encoding of the daily report files; the B2B/CAN Daily Inventory result `OperationType`
(`DailyInventoryReportRequest`, taken from the page); that the daily reports' file arrives zipped only above
40,000 items (the SDK reads both a bare file and a zip); whether `NeweggAPIResponse` wraps the
settlement results (the parser accepts both). Still open for the 2026-10-10 additions: Order List /
RMA List results for versions other than the defaults (309 / 320); the replacement-RMA field names
(`ReplacementReason*`); month-first `Date Created` and the units of the Item Basic Info dimensions; the
`Status`/`Type` filters beyond the unfiltered CAN queries run live; the US and B2B variants of all three
reports (only CAN was exercised).

**Live verification (2026-10-10, US seller account, read-only; no account values recorded).**

- Settlement Summary: `YYYY-MM-DD` dates, `version=313` and a 60-day range were all accepted on US. The
  report took about 170 s from SUBMITTED to FINISHED, which exceeded the SDK's original 120 s default.
  The settlement reports (summary and transactions) now default to a 300 s wait budget
  (`REPORT_SETTLEMENT_TIMEOUT_MS`); a slower report still throws `ReportTimeoutError` with the
  `requestId` to continue with `waitForRequest(requestId)` (the MCP tools bound their own wait with
  `waitSeconds`, max 115, and return `pending` + `requestId`). The paged result parsed (`PageSize` 100) and the
  documented amount fields mapped.
- Daily Inventory (US, `INTERNATIONAL_INVENTORY_REPORT`): submit accepted, but the report was still
  `IN_PROGRESS` after more than 5 minutes. Calling `result` before FINISHED returns HTTP 400 `CE012`
  (surfaced as `NeweggApiError`), so wait for FINISHED first. The FTP download of a Daily Inventory file
  is covered by mocked tests and a local fake FTP server only (**ASSUMPTION**: passive FTP to the documented
  `ftp03.newegg.com` URL); the SDK's downloader **was** verified live on the Item Basic Info report's
  `mktpftpreport.newegg.com` URL (§17.8), which retires the "FTP download itself" assumption in general.
- **Empty lists (checked 2026-10-10, CAN):** servicemgmt answers an empty list with `""` (§18); the reports do
  NOT do that. An Order List with no matches omits the list key entirely (only `PageInfo` with
  `TotalCount: 0` is present). The SDK's report row reader also drops a `""` / `{}` list node and blank
  entries so neither can become a phantom row.
- Status polling shares one 500/hour budget: aggressive probing hit HTTP 429 on `status`. The SDK backs
  off 1.5x up to 15 s.

### 17.8 Item Basic Information report (file; every listing of the seller)

The only way to enumerate "all my listings" (there is no synchronous list endpoint; §5/§15 reads are keyed).
Submit page (read 2026-10-10): `https://developer.newegg.com/newegg_marketplace_api/reports_management/submit_report_request/submit-item-basic-info-report/`.
The matching result page (`…/get_report_result/get-item-basic-information-report/`) returned **HTTP 404** on
2026-10-10, so the response/columns below are **live-verified** (CAN, 2026-09-01 and 2026-10-10), not
doc-sourced.

Submit — `POST {prefix}reportmgmt/report/submitrequest?sellerid=` (100/hour, all three platforms, **no
`version` query**):

```json
{
  "OperationType": "ItemBasicInfoReportRequest",
  "RequestBody": {
    "ItemBasicInfoReportCriteria": {
      "RequestType": "ITEM_BASIC_INFO_REPORT",
      "Status": "0",
      "FileType": "CSV"
    }
  }
}
```

`Status`: `0` all (default) · `1` active only · `2` inactive only. `FileType`: `TXT` · `CSV` · `XLS` (the
SDK sends `CSV`; XLS is not parsed). The optional `IssueUser` is not sent. Response: `OperationType:
"ItemBasicInfoReportResponse"`, `RequestType: "ITEM_BASIC_INFO_REPORT"`, the usual §12.1 `ResponseList`
entry. The page lists only the shared copy-pasted RP error table plus `CE003` (schema validation: bad
`Status`/`FileType`/missing `RequestType`).

Result — `PUT …/report/result` with `{ "OperationType": "ItemBasicInfoReportRequest", "RequestBody": {
"RequestID": "<id>" } }` (no paging). The file URL is nested at `NeweggAPIResponse.ResponseBody.ReportFileURL`
(the top-level `ResponseBody` is absent). It is an FTP URL **with embedded credentials** (a secret, §17.5) on
host **`mktpftpreport.newegg.com`** (not `ftp03.newegg.com`); the file is a **zip** (`ApiItemBaseInfoReport_<id>.zip`)
holding one CSV. The SDK's FTP downloader (passive, `*.newegg.com`) fetched it live without change.

Columns (live, CSV; header text normalized by lower-casing and dropping punctuation, `#` → "number"):

| Normalized header (SDK key)                              | `ItemBasicInfoRow` field         | Notes                                                       |
| -------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `sellerpartnumber`                                       | `sellerPartNumber`               | the SKU                                                     |
| `neitemnumber`                                           | `neweggItemNumber`               | 14-character Newegg item number                             |
| `manufacturerpartnumber`                                 | `manufacturerPartNumber`         | present on every live row                                   |
| `upc`                                                    | `upc`                            | blank on some rows (13 of 85 live)                          |
| `status`                                                 | `status`, `active`               | `Active` / `Inactive` (47 / 38 live)                        |
| `wesiteshorttitle` (sic; `websiteshorttitle` accepted)   | `title`                          | Newegg misspells the header "Wesite Short Title"            |
| `industry`, `subcategory`                                | `industry`, `subcategory`        |                                                             |
| `bulletdescription`                                      | `bulletDescription`              | quoted, usually contains newlines                           |
| `itemlength` / `itemwidth` / `itemheight` / `itemweight` | `itemLength` … `itemWeight`      | decimals; **ASSUMPTION** units (in / lb) are not documented |
| `itemimage`                                              | `imageUrls`                      | comma-separated URLs (up to 7 live), split                  |
| `datecreated`                                            | `dateCreated`                    | `MM/DD/YYYY` (month-first **ASSUMPTION**) → `YYYY-MM-DD`    |
| `platform`                                               | `platform`                       | `CAN` on Newegg.ca                                          |
| `itemgroupid`                                            | `itemGroupId`                    | variant-family id, blank for single-SKU listings            |
| `customvariety1name` … `customvariety3value`             | `varieties[]`                    | up to 3 `{name, value}` options                             |
| anything else                                            | `extra` (SDK only; never in MCP) | forward compatibility                                       |

The report carries **no price, inventory, fulfillment or condition column** — join the Daily Inventory report
(§17.4; B2B/CAN include price and activation) on `Seller Part #` for those. SKUs and Newegg item numbers were
unique across the file on the live account. Timing ~214 s for 85 rows while two other reports were running;
the report finishes `inProgress` for minutes, so wait for `FINISHED` (a result call earlier returns HTTP 400
`CE012`, §17 live notes).

### 17.9 Not built: Item Ranking and Tax Setting

- **Item Ranking** (`https://developer.newegg.com/newegg_marketplace_api/reports_management/item-ranking/`,
  read 2026-10-10) is not a `reportmgmt` async report: `POST {prefix}contentmgmt/item/ranking?sellerid=` is a
  synchronous call (1000/min) that takes `Type` (0 Newegg item # / 1 seller part # / 2 UPC), `Values` and
  `CountryCode` and returns `ItemRankResponse > ItemList > RankItem` (buy-box rank/winner, selling price,
  shipping, seller rating, sales ranking). The page states "Only Account Managers can help a seller to
  access this", so it is gated per account and cannot be verified on a normal seller. It is a different
  lifecycle and access model from the reports, so it is **left unbuilt** (a future `client.catalog.*` read).
  Errors `CT001`–`CT003`, `CT099`.
- **Tax Setting** (`…/get_report_result/get_tax_setting_report_for_items_enabled_for_china/`) is a
  China-programme-only result page with no matching submit page in the Submit Report Request index
  (the index lists no tax report), so its request is undocumented; **left unbuilt**. California's
  Proposition 65 Warning report (`submit_californias_proposition_65_warning_report/`, status type
  `CAPROP65_REPORT`) is likewise not built.

## 18. Service Management — RMA and courtesy refunds

Extracted 2026-10-10 from the official RMA Management pages, all under
`https://developer.newegg.com/newegg_marketplace_api/rma_management/` (the index and every sub-page were
last updated 2018-10-15). The section lists eight functions, all stated as available on all three
platforms. The wire domain is `servicemgmt/` (the standard prefix applies: none on Newegg.com, `b2b/`,
`can/`). Every example below uses fictional identifiers; the docs' own sample data is not reproduced.

| Function                           | Page (`rma_management/…`)             | Verb | Path (after prefix)                        | `OperationType`                  | Class     |
| ---------------------------------- | ------------------------------------- | ---- | ------------------------------------------ | -------------------------------- | --------- |
| Get RMA Information                | `get_rma_information/`                | PUT  | `servicemgmt/rma/rmainfo`                  | `GetRMAInfoRequest`              | **READ**  |
| Get Courtesy Refund Information    | `get_courtesy_refund_information/`    | PUT  | `servicemgmt/courtesyrefund/info`          | `GetCourtesyRefundInfo`          | **READ**  |
| Get Courtesy Refund Request Status | `get_courtesy_refund_request_status/` | PUT  | `servicemgmt/courtesyrefund/requeststatus` | `GetCourtesyRefundStatusRequest` | **READ**  |
| Submit RMA                         | `submit_rma/`                         | POST | `servicemgmt/rma/newrma`                   | `IssueRMARequest`                | **WRITE** |
| Edit RMA                           | `edit_rma/`                           | POST | `servicemgmt/rma/updaterma`                | `EditRMARequest`                 | **WRITE** |
| Process RMA (receive)              | `process_rma/`                        | POST | `servicemgmt/rma/updaterma`                | `ReceiveRMARequest`              | **WRITE** |
| Reject RMA                         | `reject_rma/`                         | POST | `servicemgmt/rma/updaterma`                | `RejectRMARequest`               | **WRITE** |
| Issue Courtesy Refund              | `issue_courtesy_refund/`              | POST | `servicemgmt/courtesyrefund/new`           | `IssueCourtesyRefund`            | **WRITE** |

Classification follows what each page says it does. The three reads are `PUT` with a request body - like
order info (§10) and Get Item Price (§15), the verb does not imply a write. The five writes create or
change RMAs / refunds (Issue Courtesy Refund is an asynchronous "request" that Get Courtesy Refund Request
Status then reports on; the index page warns a courtesy refund does NOT refund the commission). The three reads are
implemented in §18.1-18.4; the five writes are implemented (mocked tests only, never sent live) as
preview + apply pairs in §20, and are forbidden in the live suite by `npm run check:live-readonly`. Throttles on the write pages: Submit RMA 100/hour; Edit /
Process / Reject RMA and Issue Courtesy Refund 1,000/hour. Write `version`: 307 on Newegg.com, 305 on
Neweggbusiness.com / Newegg.ca (Issue Courtesy Refund has no `version`). The write bodies are
transcribed in §20.

Common to the reads:

- Auth, headers and the lowercase-URL rule are §1/§2; the request carries `sellerid` (original case) and,
  for Get RMA Information only, `version`. Request and response formats: XML or JSON; the SDK sends JSON.
- Request body is `{ OperationType, RequestBody: { … } }`. The optional `IssueUser` (a registered Seller
  Portal e-mail; defaults to the seller id) is **not sent** by the SDK. In every JSON sample the wire values
  are **strings** (`"PageIndex": "1"`, `"Status": "0"`); the SDK sends strings.
- Dates are Pacific time. The docs defer to "Acceptable Date Format"; the samples use `YYYY-MM-DD` and
  `YYYY-MM-DD HH:mm:ss`. **ASSUMPTION:** both forms are accepted on every criteria field; the SDK sends a
  string verbatim and renders a `Date` as Pacific `YYYY-MM-DD HH:mm:ss`.
- Currency: USD on Newegg.com and Neweggbusiness.com, CAD on Newegg.ca - every amount on every page.
- Error bodies: JSON array `[{"Code":"CE001","Message":"SellerID cannot be null or empty"}]` or the XML
  `<Errors><Error><Code>…` form (§1); `errors/parse-upstream.ts` normalizes both, plus plain text. The pages
  list only `CE001` and defer HTTP errors to the shared "Failed Response Error Code List". 429 follows §3.
- Responses carry the `NeweggAPIResponse` wrapper in the samples; the SDK accepts it or its absence, and
  throws `NeweggApiError` on `IsSuccess=false`.
- Lists are the usual object-OR-array quirk: `RMAInfoList > RMAInfo`, `RMATransactionList > RMATransaction`,
  `ReturnShippingLabel > Label`, `CourtesyRefundInfoList > CourtesyrefundInfo` (sic casing on the info page;
  the status page uses `CourtesyRefundInfo` - the SDK reads both), `ResponseList > ResponseInfo`.

### 18.1 Get RMA Information (READ)

`PUT {prefix}servicemgmt/rma/rmainfo?sellerid={sellerid}&version={version}` - **1,000 requests/hour**.

`version`: Newegg.com **307 · 309 · 320**; Neweggbusiness.com and Newegg.ca **305 · 309 · 320**. 309 adds
the seller's own RMA number and the replacement order number; 320 adds the return shipping label fields.
`SellerRMANumber` is returned from 307 (US) / 305 (B2B, CAN). The SDK defaults to **320** (newest on all
three) and rejects a version outside the platform's documented set before sending (`platform/rma.ts`).

Request body:

```json
{
  "OperationType": "GetRMAInfoRequest",
  "RequestBody": {
    "PageInfo": { "PageIndex": "1", "PageSize": "10" },
    "KeywordsType": "1",
    "KeywordsValue": "<rma number>",
    "Status": "0",
    "RMADateFrom": "2026-09-01",
    "RMADateTo": "2026-09-30",
    "RMAType": "0",
    "ProcessedBy": "0"
  }
}
```

All criteria are optional. `PageSize` max 100. The field table says `PageSize` defaults to 1 and `PageIndex`
"defaults to 100 if blank" - a doc slip (the two are swapped); the SDK always sends both explicitly (default
page 1, size 100). `PageInfo` nesting is from the samples; the field table lists `PageIndex`/`PageSize`
flat (**ASSUMPTION:** the nested form is the working one - both samples send it). Filters: `KeywordsType`
1 RMANumber · 2 OrderNumber · 3 CustomerName · 4 SellerRMANumber (omit = no keyword); `Status` 0 all
(default) · 1 Open · 2 Received · 3 Rejected · 4 Voided · 5 Closed · 6 Processing (Received RMAs are not
visible in Seller Portal); `RMAType` 0 all · 1 Replacement · 2 Refund; `ProcessedBy` 0 all · 1 Seller ·
2 Newegg. The page states no maximum date range (**ASSUMPTION:** none enforced).

Response (`OperationType` is `GetRMAInfo` in the samples; the field table says `IssueRMAResponse` - a
copy-paste slip, the SDK ignores it): `ResponseBody.PageInfo { TotalCount, TotalPageCount, PageIndex,
PageSize }` and `RMAInfoList > RMAInfo[]`, each with:

- Identity: `RMANumber`, `RMAType` (1 Replacement · 2 Refund) + `RMATypeDescription`, `SellerRMANumber`
  (alphanumeric ≤ 50), `ReplacementOrderNumber` (replacement RMAs, version ≥ 309), `IssueUser`, `RMADate`,
  `RMAStatus` (1 Open · 2 Received · 3 Rejected · 4 Voided · 5 Closed · 6 Processing) +
  `RMAStatusDescription`, `RMAProcessedBy` ("Newegg" | "Seller"), `RMAReceiveDate`, `RMANote`.
- Replacement shipping: `RMAShipMethod` 1-13 (Super Saver … Newegg Premier Next Day) + description; blank
  for refund RMAs.
- Order link and money: `OrderNumber`, `OrderDate`, `InvoiceNumber`, `OrderAmount`, `AvailableRefundAmount`
  (order total minus refunds including this RMA), `PriorRefundAmount`.
- Customer (**PII**): `CustomerName`, `CustomerPhoneNumber`, `CustomerEmailAddress` (Newegg's masked relay),
  `ShipToAddress1/2`, `ShipToCityName`, `ShipToStateCode`, `ShipToZipCode`, `ShipToCountryCode`,
  `ShipToLastName`, `ShipToFirstName`, `ShipToCompany`.
- Return label (version 320): `ReturnShippingLabel > Label { TrackingNumber, TrackingURL, LabelEstimateCost,
PaidBy }` in every sample; the field table lists the four fields flat. The SDK reads the nested form first,
  then the flat one.
- Items, `RMATransactionList > RMATransaction[]`: `SellerPartNumber`, `MfrPartNumber`, `NeweggItemNumber`,
  `Description`, `UnitPrice`, `ReturnQuantity`, `ReturnUnitPrice` and `RefundShippingPrice` (refund RMAs),
  `ShippedBy` (replacement RMAs: 0 SBS · 1 SBN), `RMAReason` 1 Item damage · 2 Defective · 3 Incompatible ·
  4 No longer needed · 5 Inaccurate description · 6 Ordered wrong item · 7 Sent wrong item · 8 Product
  dissatisfaction · 9 Other + `RMAReasonDescription`, and (USA/CAN only) `UnOpen`, `FileUrls`, `Memo`.

The samples show numbers and statuses as strings and an empty `ShippedBy`/`RMAShipMethod`; the parser treats
every field as optional. **VERIFIED live 2026-10-10 (CAN, read-only):** a populated list arrives as
`RMAInfoList: { RMAInfo: [ … ] }` with string `PageInfo` counts. An EMPTY servicemgmt list arrives as an empty
STRING (seen on `CourtesyRefundInfoList: ""` and `ResponseList: ""`), not as an empty array or a missing key.
The shared `listItems` reader keeps only objects as rows, so `""`/`null`/scalars never become a phantom row.
Before this fix, the live test caught one phantom refund with an empty id. The empty-RMA case itself is
still unobserved, because our account has RMAs; the same reader covers it.

### 18.2 Get Courtesy Refund Information (READ)

`PUT {prefix}servicemgmt/courtesyrefund/info?sellerid={sellerid}` - **30 requests per minute per client**
(the tightest budget in the section; the SDK has no local limiter for it, so avoid loops). No `version`.

```json
{
  "OperationType": "GetCourtesyRefundInfo",
  "RequestBody": {
    "PageInfo": { "PageIndex": "1", "PageSize": "10" },
    "KeywordsType": "0",
    "Status": "0",
    "DateFrom": "2026-09-01 00:00:00",
    "DateTo": "2026-09-30 23:59:59"
  }
}
```

Criteria (all optional): `PageSize` max 100 (default 100), `PageIndex` default 1; `KeywordsType` 0 all
(default; `KeywordsValue` then ignored) · 1 CourtesyRefundID · 2 OrderNumber · 3 CustomerName; `Status` 0 all
(default) · **1 Open · 2 Void · 3 Close** (request table); `DateFrom` / `DateTo` Pacific.

Response `OperationType: "GetCourtesyRefundResponse"`: `ResponseBody.PageInfo` (the JSON sample swaps
`PageSize` and `PageIndex`; values are taken as given) and `CourtesyRefundInfoList > CourtesyrefundInfo[]`
with `CourtesyRefundID` (a GUID), `SONumber`, `SOAmount`, `InvoiceNumber`, `RefundAmount`, `ReasonCode`
(1 Negative customer feedback · 2 Pricing error · 3 Wrong item information · 4 Shipping delay · 5 Package not
received · 6 Customer Courtesy) + `Reason`, `NoteToCustomer` (free text), `Status`, `IsNeweggRefund`
("true"/"false": issued by a Newegg agent), `InUserName`, `InDate`, `EditUserName`, `EditDate`. **Status
mismatch:** the response table lists digits **1 Open · 2 Close · 3 Void** - the reverse of the request
filter - while every sample returns the label `"Close"`. **ASSUMPTION:** each table is right for its own
direction; the SDK sends the request digits and accepts digits or labels in responses.

### 18.3 Get Courtesy Refund Request Status (READ)

`PUT {prefix}servicemgmt/courtesyrefund/requeststatus?sellerid={sellerid}` - **10,000 requests/hour**.

```json
{
  "OperationType": "GetCourtesyRefundStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": ["<request id>"] },
      "MaxCount": "100",
      "RequestStatus": "ALL"
    }
  }
}
```

`RequestID` is documented flat in the table but sent as an id list in the samples: when present, `MaxCount`,
`RequestStatus` and the date range are ignored. `MaxCount` default and cap 100. `RequestStatus`: `ALL`
(default) · `SUBMITTED` · `IN_PROGRESS` · `FINISHED` · `FAILED` · `CANCELLED`. `RequestDateFrom` /
`RequestDateTo` Pacific.

Response `OperationType: "GetCourtesyRefundRequestStatusResponse"`: `ResponseBody.ResponseList >
ResponseInfo[]` with `RequestId`, `RequestType` (`COURTESYREFUND`), `RequestDate`, `RequestStatus`,
`ProcessMemo` (the failure detail when FAILED) and, once FINISHED, `Result > CourtesyRefundInfo` with the
§18.2 fields (plus `Memo`). In the sample the request id equals the `CourtesyRefundID` (**ASSUMPTION:** the
id returned by Issue Courtesy Refund identifies both).

### 18.4 SDK mapping

All READS, none gated; the MCP tools register unconditionally. The writes are in §20.7.

| SDK                                   | Wire             | MCP tool               |
| ------------------------------------- | ---------------- | ---------------------- |
| `client.rma.list(input)`              | §18.1            | `newegg_rma_list`      |
| `client.rma.get/tryGet(rmaNumber)`    | §18.1, keyword 1 | `newegg_rma_get`       |
| `client.refunds.list(input)`          | §18.2            | `newegg_refund_list`   |
| `client.refunds.get/tryGet(id)`       | §18.2, keyword 1 | -                      |
| `client.refunds.listRequests(input)`  | §18.3            | `newegg_refund_status` |
| `client.refunds.getRequestStatus(id)` | §18.3            | -                      |

Platform differences (the `version` sets, currency) live in `packages/sdk/src/platform/rma.ts`. Numbers are
parsed from strings, `UnOpen` from `"0"/"1"`, dates through `platform/dates.ts` (`{ raw, iso }`), and unknown
status / reason / type codes degrade to `"unknown"` rather than throwing. `get`/`tryGet` match the returned
record's id exactly (a keyword search could in principle return neighbours).

**PII.** Get RMA Information returns the buyer's name, phone, masked e-mail and full ship-to address, plus
free-text notes and a return-label tracking number. The SDK returns them in its typed result (the caller is
the seller); the **MCP tools never do**: `serializeRma` / `serializeRefund` map fields explicitly and drop the
customer block, `RMANote`, item `Memo`, `NoteToCustomer`, `IssueUser` / `InUserName` / `EditUserName` (can be
an e-mail) and the label tracking number / URL (see `docs/mcp-security.md`).

**VERIFIED live 2026-10-10 on CAN (read-only live test `rma-read.live.test.ts`, 4/4):**

- `can/servicemgmt/rma/rmainfo` accepts version `320`, the nested `PageInfo` request form and `YYYY-MM-DD`
  criteria dates spanning 2020-01-01 to 2026-12-31.
- `can/servicemgmt/courtesyrefund/info` and `…/requeststatus` answer `IsSuccess: "true"`.
- Empty lists arrive as `""` (see §18.1).

**VERIFIED live 2026-10-16 on US and B2B (read-only, same live test, 4/4 on each; CAN re-run as control, 4/4):**

- `servicemgmt/rma/rmainfo` on US (no prefix) and `b2b/` accepts version `320`, the nested `PageInfo` form and
  `YYYY-MM-DD` criteria dates (2020-01-01 to 2026-12-31). The `servicemgmt` paths on B2B are real.
- The RMA lists on US and B2B were populated (a small non-empty page on each, `rma.get` round-tripped), the courtesy
  refund list and the request-status list were empty on US, B2B and CAN, and the normalized currency was
  `USD` on US and B2B. The RMA count was identical on all three platforms; that was observed, not explained
  (whether the seller account shares RMAs across platforms is not established).

**ASSUMPTIONs (retire when verified live):**

- `YYYY-MM-DD HH:mm:ss` criteria dates.
- The request-vs-response courtesy `Status` tables (no refunds on our account to compare).
- No date-range cap on any read.
- The courtesy refund request id equalling the refund id.
  The section was written from the docs alone, then checked on CAN with the live test (above). That test
  (`rma-read.live.test.ts`, read-only) asserts shapes only with identifiers discovered at runtime, and skips
  the identifier-dependent cases when the account has no RMAs.

## 19. Seller Management — seller status and category reference reads

Extracted 2026-10-15 from the official Seller Management pages, all under
`https://developer.newegg.com/newegg_marketplace_api/seller_management/` (the index lists nine functions;
the pages were last updated 2018-10-15, Seller Status Check 2020-12-30). The wire domain is `sellermgmt/`
(the standard prefix applies: none on Newegg.com, `b2b/`, `can/`). These are the reference lookups an
item-creation flow needs before it can build an `ITEM_DATA` feed (§13): which categories the seller may
list in, and which properties and allowed values each category takes. Every example below uses fictional
identifiers; the docs' own sample data is not reproduced beyond generic category names.

### 19.1 Operation inventory and classification

| Function                                 | Page (`seller_management/…`)                        | Platforms    | Verb | Path (after prefix)                     | Class    | In SDK |
| ---------------------------------------- | --------------------------------------------------- | ------------ | ---- | --------------------------------------- | -------- | ------ |
| Seller Status Check                      | `seller_status_check/`                              | US, B2B, CAN | GET  | `sellermgmt/seller/accountstatus`       | **READ** | yes    |
| Get Industry List                        | `get_industry_list/`                                | US, B2B, CAN | GET  | `sellermgmt/seller/industry`            | **READ** | yes    |
| Get Subcategory Status                   | `get_subcategory_status/`                           | US, B2B, CAN | PUT  | `sellermgmt/seller/subcategory`         | **READ** | yes    |
| Get Subcategory Status for Int'l Country | `get_subcategory_status_for_international_country/` | US only      | PUT  | `sellermgmt/seller/subcategory/V2`      | **READ** | yes    |
| Get Subcategory Properties               | `get_subcategory_properties/`                       | US, B2B, CAN | PUT  | `sellermgmt/seller/subcategoryproperty` | **READ** | yes    |
| Get Subcategory Property Values          | `get_subcategory_property_values/`                  | US, B2B, CAN | PUT  | `sellermgmt/seller/propertyvalue`       | **READ** | yes    |
| Get Warehouse List                       | `get-warehouse-list/` (see below)                   | -            | -    | -                                       | READ     | **no** |
| Get Subcategory Status v1.1              | `get-subcategory-status-v1-1/` (see below)          | -            | -    | -                                       | READ     | **no** |
| Download Feed Schema                     | `download_feed_schema/`                             | -            | -    | not fetched                             | READ     | no     |

Classification follows what each page says it does ("Get…", "Seller Status Check"); none changes seller
data. The four `PUT`s carry a request body and, like order info (§10), Get Item Price (§15) and the RMA
reads (§18), the verb does not imply a write.

**Left out, with the reason:**

- **Get Warehouse List.** The Seller Management index describes a function that "lists seller-fulfilled
  warehouses … location, status, and shipping destination" (Newegg.com only), but its page slug
  `seller_management/get-warehouse-list/` answers `301` to
  `sbn_shipped_by_newegg_management/get-warehouse-list/` (verified 2026-10-15), which documents a different
  function: Newegg's own SBN inbound warehouses (`PUT {prefix}sbnmgmt/inboundshipment/warehouse`, body
  `{ OperationType: "GetWarehouseRequest", RequestBody: { WarehouseCode } }`, US and B2B only, 1,000/min),
  whose JSON example `GET`s a different URL (`…/inboundshipment/shipmentlist`), so even its verb and path
  are inconsistent on the page. The seller-fulfilled variant has no retrievable page and is not implemented. The SBN
  one is implemented as `client.sbn.listWarehouses` (§21.5), with its verb and path marked **ASSUMPTION**
  because of that inconsistency. Seller Status Check (§19.2) already returns the
  seller's fulfillment-center countries and ship-to destinations.
- **Get Subcategory Status v1.1.** The index lists it ("search by category ID and website catalog name") and
  links `…/get-subcategory-status-v1-1/`, which answers `404` (2026-10-15, with and without the trailing
  slash). With no page there is no wire shape to contract; add it once the page is retrievable.
- **Download Feed Schema** is a read of the feed XSDs, not part of this PR's scope (not fetched).

**Live-verified 2026-10-15** against a real seller account on CAN (`can/`), B2B (`b2b/`) and
Newegg.com with the same credentials, read-only, by calling every read through the SDK. The per-read
sections below record what the wire actually does; anything not exercised is still marked
**ASSUMPTION**. Observations common to all five reads:

- Responses are bare JSON `{ IsSuccess, OperationType, SellerID, ResponseBody }` (no `NeweggAPIResponse`
  wrapper) with `IsSuccess` the boolean `true`. Ids, flags and `Membership` are JSON **numbers**
  (`"SubcategoryID": 3`, `"Enabled": 1`, `"IsRequired": 0`), not the strings the XML-derived samples
  suggest; the parsers accept both.
- An empty list is the JSON array `[]` (not `""`) on all five.
- Rate-limit headers (surfaced as `rateLimit`) reported a limit of 100 for Seller Status Check, 2,000 for
  Get Industry List and 20 for the four `PUT`s (shared across them), on all three platforms. These differ
  from the per-hour numbers on the pages (500 / 10,000 / 100); the header's window is not documented, so
  treat the headers, not the pages, as the effective budget and keep probes small.

Common to the five implemented reads:

- Auth, headers and the lowercase-URL rule are §1/§2; every request carries `sellerid` (original case).
  Request and response formats: XML or JSON; the SDK sends JSON. `GET`s have no body.
- `PUT` bodies are `{ OperationType, RequestBody: { … } }`. In every JSON sample the wire values are
  **strings** (`"SubcategoryID": "397"`, `"Enabled": "1"`); the SDK sends strings.
- Responses carry the `NeweggAPIResponse` wrapper in the XML samples and `{ IsSuccess, OperationType,
SellerID, ResponseBody }` in the JSON ones; `IsSuccess` is the string `"true"` in most JSON samples and
  the boolean `true` in Seller Status Check. The SDK accepts either wrapper form, either `IsSuccess`
  type, and throws `NeweggApiError` on `IsSuccess=false`.
- Lists are the usual object-OR-array quirk, and an empty list must be expected as `""` (§18.1, verified
  live there): `IndustryList > Industry`, `SubcategoryList > Subcategory`,
  `SubcategoryPropertyList > SubcategoryProperty`, `PropertyInfoList > PropertyInfo`,
  `PropertyValueList > PropertyValue`, `FufillmentCenterList > FufillmentCenter` (sic) and
  `ShippingDestinationList > ShipToCountry`. In the JSON samples these are arrays, and the two string
  lists (`ShippingDestinationList`, `PropertyValueList`) are arrays of bare strings.
- Error bodies: JSON array `[{"Code":"DF008","Message":"Invalid industry code ABC"}]` or the XML
  `<Errors><Error><Code>…` form (§1); `errors/parse-upstream.ts` normalizes both, plus plain text. The pages
  list `DF008` (invalid industry code; Get Industry List and Get Subcategory Status; see §19.3: not
  reproduced live, live returns 200 with an empty list) and `DF009` (invalid
  subcategory ID; Get Subcategory Properties / Property Values) and defer HTTP errors to the shared
  "Failed Response Error Code List". 429 follows §3. The SDK additionally throws `NeweggApiError` if a
  `200` body is itself a bare error list, so an error can never read as an empty result.

### 19.2 Seller Status Check (READ)

`GET {prefix}sellermgmt/seller/accountstatus?sellerid={sellerid}[&version=307]` - **500 requests/hour**.

`version` (required, only value **307**) is documented for **Newegg.com only**; the B2B and CAN URLs carry
no `version`. The page says the 307-marked response fields - `Membership`, `WarehouseLocation`,
`WarehouseType`, `ShipToCountry` - are "available version: 307". The SDK sends `version=307` on US only
(`platform/reference.ts`).

Response (JSON sample; XML nests the same under `NeweggAPIResponse > ResponseBody`):

```json
{
  "IsSuccess": true,
  "OperationType": "GetSellerAccountStatusResponse",
  "SellerID": "A006",
  "ResponseBody": {
    "Membership": 0,
    "FufillmentCenterList": [
      { "WarehouseLocation": "TUR", "WarehouseType": 0, "ShippingDestinationList": ["TUR", "USA"] },
      { "WarehouseLocation": "USA", "WarehouseType": 1, "ShippingDestinationList": ["AUS", "USA"] }
    ],
    "SellerName": "Test_MKTPLS",
    "Status": "Active"
  }
}
```

| Field                  | Notes                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `SellerName`           | Store name (a CDATA string in XML).                                                          |
| `Status`               | `Active` · `Suspended` · `InActive` · `Terminated` · `Closed`. Anything else -> `"unknown"`. |
| `Membership`           | Integer: 0 Non-Elite · 1 Professional · 2 Enterprise. Others -> `"unknown"`; absent -> none. |
| `WarehouseLocation`    | ISO alpha-3 country of the fulfillment center.                                               |
| `WarehouseType`        | Integer: 0 Ship by Seller (SBS) · 1 Ship by Newegg (SBN).                                    |
| `ShippingDestination…` | ISO alpha-3 destination countries of that center.                                            |

The container is spelled `FufillmentCenterList` / `FufillmentCenter` (sic) in every sample; the SDK also
reads the correct spelling. **Live-verified (CAN, B2B, Newegg.com, 2026-10-15):**
CAN and B2B answer the same envelope without the version-307 fields - `{ SellerName, Status: "Active" }`
only, no `Membership`, no `FufillmentCenterList` - so `membership: undefined` and `fulfillmentCenters: []`,
never an error. Newegg.com (`version=307`) adds `Membership` (observed as `0`) and, for an account with
no fulfillment centers, `FufillmentCenterList: []`. The populated `FufillmentCenterList` item shape
(`WarehouseLocation`, `WarehouseType`, `ShippingDestinationList`) is still **ASSUMPTION** (taken from the
page's sample; an account without centers cannot show it).

### 19.3 Get Industry List (READ)

`GET {prefix}sellermgmt/seller/industry?sellerid={sellerid}[&industrycode={code}]` - **10,000
requests/hour**. `industrycode` is optional; omitted, every industry is returned (33 observed, the same on
CAN and Newegg.com). Live: filtering by a real code returns just that industry; an unknown code
is answered `200` with `IndustryList: []`, **not** `DF008` as the page says, so the SDK returns an empty
list rather than throwing. (The page's request samples show the URL without `industrycode`, its Resource URL
with it; the SDK adds the lowercase `industrycode` query only when filtering.)

Response `OperationType: "GetSellerIndustryResponse"`, `ResponseBody.IndustryList > Industry[]` with
`IndustryCode` and `IndustryName`.

### 19.4 Get Subcategory Status (READ) and its international variant

`PUT {prefix}sellermgmt/seller/subcategory?sellerid={sellerid}` - **100 requests/hour**. Whether a
subcategory is enabled for the seller. **International variant (Newegg.com only):**
`PUT sellermgmt/seller/subcategory/V2?sellerid={sellerid}` adds a required `CountryCode` (ISO alpha-3) and
echoes it in the response; the page spells the path segment `V2` although it also states URLs are
lowercase - **live-verified (Newegg.com, 2026-10-15):** the `V2` casing is accepted and the response echoes
`CountryCode: "USA"` beside `SubcategoryList`. The SDK selects the V2
URL when the caller passes `countryCode` and throws `UnsupportedMarketplaceOperationError` (before sending)
on B2B/CAN.

Request body. The field tables list `SubcategoryID`, `IndustryCode` and `Enabled` flat, but every XML and
JSON sample nests them under `RequestBody > GetItemSubcategory` with list wrappers; the SDK follows the
samples:

```json
{
  "OperationType": "GetSellerSubcategoryRequest",
  "RequestBody": {
    "CountryCode": "USA",
    "GetItemSubcategory": {
      "SubcategoryIDList": { "SubcategoryID": "397" },
      "IndustryCodeList": { "IndustryCode": "CH" },
      "Enabled": "1"
    }
  }
}
```

`Enabled`: `0` not enabled · `1` enabled; left out, both are returned. **Live-verified (CAN, 2026-10-15):**
several ids or industry codes sent as a JSON array under the single wrapper key
(`{"SubcategoryID": ["3","5"]}`, `{"IndustryCode": ["CH","CP"]}`) are accepted and return the union; and
with no filters the SDK's empty `GetItemSubcategory: {}` is accepted and returns every subcategory (about 1.5k
rows across 33 industries on CAN; the catalogue is the same size on Newegg.com). `Enabled: "1"` filters as
documented. The same calls work on B2B (single-id filter exercised) and Newegg.com, where an account may
report every subcategory `Enabled: 0` (seen 2026-10-15).

Response `OperationType: "GetSellerSubcategoryResponse"`, `ResponseBody.SubcategoryList > Subcategory[]`
with `IndustryCode`, `IndustryName`, `SubcategoryID` (integer, a string in JSON), `SubcategoryName` and
`Enabled` (`1`/`0` live, `"0"`/`"1"` in the samples; an absent or unparseable value yields `enabled: undefined`, never `false`); the V2 response adds `ResponseBody.CountryCode`. The unfiltered list covers every
Newegg subcategory and can be large (the MCP tool caps it, §19.7).

### 19.5 Get Subcategory Properties (READ)

`PUT {prefix}sellermgmt/seller/subcategoryproperty?sellerid={sellerid}` - **100 requests/hour**.

```json
{
  "OperationType": "GetSellerSubcategoryPropertyRequest",
  "RequestBody": { "SubcategoryID": "1045" }
}
```

`SubcategoryID` is required and "obtained using the Get Subcategory Status request". Response
`OperationType: "GetSellerSubcategoryPropertyResponse"`, `ResponseBody.SubcategoryPropertyList >
SubcategoryProperty[]` with `SubcategoryID`, `SubcategoryName`, `PropertyName`, and the `0`/`1` flags
`IsAdvancedSearch` (shown in advanced-search navigation), `IsGroupBy` and `IsRequired`. An invalid id is
answered `400` with the JSON array `[{"Code":"DF009","Message":"Invalid subcategory ID [<id>]."}]`
(live-verified; the SDK throws `NeweggApiError` with `neweggErrorCode: "DF009"`). **Live-verified (CAN,
2026-10-15):** the rows add an integer `PropertyID` the pages do not list (the SDK ignores it), the flags
are JSON numbers `0`/`1`, and `SubcategoryName` is a compacted form (`"MemoryFlashMemory"`, no spaces or
punctuation) rather than the display name from Get Subcategory Status. Subcategories carry about 20-30
properties; only a few are `IsRequired`.

### 19.6 Get Subcategory Property Values (READ)

`PUT {prefix}sellermgmt/seller/propertyvalue?sellerid={sellerid}` - **100 requests/hour**.

```json
{
  "OperationType": "GetSellerPropertyValueRequest",
  "RequestBody": { "SubcategoryID": "1045", "PropertyName": "Costume_Gender" }
}
```

`PropertyName` is required ("obtained using the Get Subcategory Properties request"). **Correction
(live, 2026-10-15): `SubcategoryID` is required too.** The page calls it optional ("left blank, returns the
property information for all applied subcategories"), but a request with only `PropertyName` is answered
`400 CE003` ("The element 'RequestBody' has invalid child element 'PropertyName'. List of possible elements
expected: 'SubcategoryID'."). The SDK and the `newegg_property_values` tool therefore require
`subcategoryId` (a breaking change to `ListPropertyValuesInput`, which has not been released; the
cross-subcategory read is not available). Response `OperationType: "GetSellerPropertyValueResponse"`,
`ResponseBody.PropertyInfoList > PropertyInfo[]` with the §19.5 property fields plus `PropertyValueList`.
**Live, the request returns ONE `PropertyInfo` carrying the property's whole value list** (a single row with
a 407-element `PropertyValueList` of bare strings), not the one-row-per-value shape of the samples. The SDK
still merges rows with the same (subcategory, property) into one entry, de-duplicated, in first-seen order,
so both shapes work. A property with no allowed values comes back as one row with `PropertyValueList: []`
and yields `values: []`.

### 19.7 SDK mapping

All READS, none gated; the MCP tools register unconditionally.

| SDK                                              | Wire  | MCP tool                        |
| ------------------------------------------------ | ----- | ------------------------------- |
| `client.reference.getSellerStatus()`             | §19.2 | `newegg_seller_status`          |
| `client.reference.listIndustries(input)`         | §19.3 | `newegg_industries_list`        |
| `client.reference.listSubcategories(input)`      | §19.4 | `newegg_subcategories_list`     |
| `client.reference.listSubcategoryProperties(id)` | §19.5 | `newegg_subcategory_properties` |
| `client.reference.listPropertyValues(input)`     | §19.6 | `newegg_property_values`        |

Platform differences (the `version` query, the Newegg.com-only international variant) live in
`packages/sdk/src/platform/reference.ts`. Numbers are parsed from strings, flags from `"0"/"1"`, and unknown
`Status` / `Membership` / `WarehouseType` codes degrade rather than throw. Inputs are validated before any
request (positive-integer ids, industry codes `[A-Za-z0-9_-]{1,20}`, uppercase alpha-3 country, property
name 1-200 characters without control characters). Rate limits are Newegg's, enforced server-side (§3); the
SDK keeps one local rate-limit key per operation and honours the response headers.

The MCP tools map fields explicitly (no `raw`). The subcategory, property and value lists can run to
thousands of rows, so those tools take a `limit` (default 200, max 1,000) and report the full `totalCount`
(`valueCount` per property for values) and `truncated`; the SDK itself returns everything. Nothing in these
responses is buyer data; `SellerName` is the seller's own store name.

**Verification status (2026-10-15).** The five reads were exercised live, read-only, on CAN, B2B and
Newegg.com (about 55 requests in total, including the opt-in live test
`packages/sdk/test/live/reference-read.live.test.ts`, which asserts shapes only). Retired ASSUMPTIONs: the
CAN and B2B response shapes and that all five paths exist under `can/` and `b2b/`; the `V2` path casing;
multi-value filter lists and the empty `GetItemSubcategory` object; and that a bad subcategory id arrives
as HTTP `400` with a JSON error list (`DF009`; the SDK's handling of a `200` body that is itself an error
list stays as defence in depth). Corrected: `SubcategoryID` is required on Get Subcategory Property Values,
an unknown industry code returns an empty list rather than `DF008`, and the rate-limit headers disagree
with the pages' per-hour figures (see §19.1).

**Still ASSUMPTION:**

- The populated `FufillmentCenterList` item shape (not seen: the account probed had no fulfillment
  centers) and the `Membership` value mapping beyond `0`.
- That `DF008` is returned for an unknown industry code in the Get Subcategory Status filter (only the Get
  Industry List filter was probed, and it did not raise it).
- `IsSuccess=false` bodies on an HTTP `200` (not observed; the SDK handles both).
- That the 500/hour, 10,000/hour and 100/hour limits stated on the pages are the live ones (§3); the live
  headers say 100 / 2,000 / 20 with an undocumented window.
- Get Subcategory Properties / Property Values on B2B and Newegg.com were exercised only through the live
  test's shape assertions (non-empty property list, a value row with an array of values), not inspected
  field by field. On Newegg.com the probed account reported every subcategory disabled, so those two reads
  ran against a disabled subcategory; the field-by-field checks above are CAN only.

## 20. Service Management — RMA and courtesy refund WRITES

> Extracted 2026-10-15 from the official RMA Management pages under
> `https://developer.newegg.com/newegg_marketplace_api/rma_management/` (`submit_rma/`, `edit_rma/`,
> `process_rma/`, `reject_rma/`, `issue_courtesy_refund/`; the section index and every sub-page were last
> updated 2018-10-15). **Implemented in code and mocked tests only; no RMA or courtesy-refund write has EVER
> been sent to a real account, and none of this was probed** (repo rule 2; `check:live-readonly` forbids every
> method, the endpoints and the body elements in `test/live`). Everything below is therefore
> documented-shape, not live-verified. The five operations are classified in the §18 table; this section is
> the wire detail. All examples use fictional identifiers.

These operations **move money or change a customer's return**: an RMA refund credits the buyer, a courtesy
refund pays the buyer and **the commission is NOT refunded** (the index page says so), and a rejected RMA
tells the buyer the return was refused. They are never retried after an ambiguous failure (§20.6).

### 20.1 Wire summary

| Operation             | Verb | Path (after prefix)              | `version`                | Rate limit | `OperationType`       | Body element                        |
| --------------------- | ---- | -------------------------------- | ------------------------ | ---------- | --------------------- | ----------------------------------- |
| Submit RMA            | POST | `servicemgmt/rma/newrma`         | 307 (US), 305 (B2B, CAN) | 100/hour   | `IssueRMARequest`     | `RequestBody > IssueRMA`            |
| Edit RMA              | POST | `servicemgmt/rma/updaterma`      | 307 (US), 305 (B2B, CAN) | 1,000/hour | `EditRMARequest`      | `RequestBody > EditRMAInfo`         |
| Process (receive) RMA | POST | `servicemgmt/rma/updaterma`      | 307 (US), 305 (B2B, CAN) | 1,000/hour | `ReceiveRMARequest`   | `RequestBody > ReceiveRMAInfo`      |
| Reject RMA            | POST | `servicemgmt/rma/updaterma`      | 307 (US), 305 (B2B, CAN) | 1,000/hour | `RejectRMARequest`    | `RequestBody > RejectRMAInfo`       |
| Issue Courtesy Refund | POST | `servicemgmt/courtesyrefund/new` | none                     | 1,000/hour | `IssueCourtesyRefund` | `RequestBody > IssueCourtesyRefund` |

Platform prefix per §2 (none on Newegg.com, `b2b/`, `can/`); `?sellerid={SellerID}` as everywhere, plus
`&version={writeVersion}` on the four RMA writes (`platform/rma.ts` `writeVersion`). Edit, Process and Reject
share one URL and are told apart only by `OperationType` and the body element. Request and response formats:
XML or JSON; the SDK sends JSON with every value a **string** (`"ReturnQuantity": "1"`), as in the samples.
The optional `IssueUser` is not sent. Currency is USD (Newegg.com, Neweggbusiness.com) or CAD (Newegg.ca).
Error bodies and the `NeweggAPIResponse` wrapper: §18 "Common to the reads" (`errors/parse-upstream.ts`,
`servicemgmt/shared.ts`). Each write has its own local rate-limit key (`rma.submit`, `rma.edit`,
`rma.receive`, `rma.reject`, `refunds.issue`).

The Submit page lists its response fields flat and its JSON "response" sample is a copy of the request;
Edit / Process / Reject nest the RMA under `ResponseBody > RMAInfo`. The SDK reads `RMAInfo`, else the body,
else the root (`parseRmaWriteResponse`). All three RMA writes report status **6 = Processing** in their
samples (the Get RMA Information status table has no 6; the SDK maps it to `processing`, §18.1).

### 20.2 Submit RMA (`IssueRMARequest`)

Body (a refund RMA for one line; all values strings):

```json
{
  "OperationType": "IssueRMARequest",
  "RequestBody": {
    "IssueRMA": {
      "RMAType": "2",
      "SourceSONumber": "900000002",
      "SellerRMANumber": "SELLERRMA1",
      "AutoReceiveMark": "1",
      "RMANote": "text",
      "RMATransactionList": {
        "RMATransaction": {
          "SellerPartNumber": "SKU-PLACEHOLDER",
          "ReturnQuantity": "1",
          "ReturnUnitPrice": "40.00",
          "RefundShippingPrice": "0.00",
          "RMAReason": "2"
        }
      }
    }
  }
}
```

- `RMAType`: `1` replacement, `2` refund. `ReturnUnitPrice` and `RefundShippingPrice` are required for a
  refund and **not allowed** for a replacement (SDK: validation error). `RefundShippingPrice` `0.00` means no
  shipping refund.
- `RMAReason` (request side, 1-10): 1 item damaged, 2 defective, 3 incompatible, 4 no longer needed,
  5 not as described, 6 ordered wrong item, 7 sent wrong item, 8 unsatisfied, 9 extra item shipped, 10 item
  not received. Reasons **3, 4, 6, 8** additionally require `UnOpen` (`"0"`/`"1"`), 1-5 evidence image URLs
  (`FileUrls > ImgUrl`) and a `Memo`. `FileUrls` and `Memo` are documented **US and CAN only**; the SDK
  refuses them on B2B (`acceptsEvidenceFiles`).
- `AutoReceiveMark` `"1"` marks the RMA received on creation (refund only). **The SDK supports it but the MCP
  never exposes it** (auto-receiving is the step before a refund pays out).
- `SellerRMANumber`: 1-50 letters and digits. `RMANote`: free text.
- Money: two decimals, each unit price and shipping refund within 0-99,999.99; the SDK sends exactly what the
  caller gave (it rejects a third decimal, never rounds or clamps).
- Lists use the object-or-array quirk: one row is sent as an object, several as an array.
- Errors the page lists (`SE0xx`), mirrored locally from reads where possible: SE001/SE024 item not on the
  order, SE004 order not invoiced, SE009 quantity above the returnable quantity, SE011 unit refund above the
  unit price, SE012 shipping refund above the shipping charge, SE013 replacement not in stock / ship method,
  SE023 refund above the order total, SE026 replacement order, SE027 voided order, SE034 refund above the
  total minus prior refunds. Codes are surfaced from the upstream body unchanged.

### 20.3 Edit, Process and Reject RMA (`updaterma`)

Edit (`EditRMARequest`, `EditRMAInfo`) replaces an **open** RMA's note and lines: `RMANumber`, `RMAType`,
optional `SellerRMANumber`, `RMANote` (required) and a full `RMATransactionList` with the §20.2 line rules.

Process (`ReceiveRMARequest`, `ReceiveRMAInfo > RMANumber`) marks the returned goods received.

Reject (`RejectRMARequest`, `RejectRMAInfo`):

```json
{
  "OperationType": "RejectRMARequest",
  "RequestBody": {
    "RejectRMAInfo": {
      "RMANumber": "900000011",
      "RejectReason": "3",
      "ShipCarrier": "1",
      "ShipService": "Ground",
      "TrackingNumberList": { "TrackingNumber": "TRACKING0001" },
      "RejectReasonMemo": "text",
      "RejectReasonDescriptionImages": { "ImageUrl": ["https://example.invalid/a.jpg"] }
    }
  }
}
```

- `ShipCarrier`: 1 UPS, 2 FedEx, 3 DHL, 4 USPS, 5 other (then `OtherShipCarrier`, <= 10, is required). The
  rejected goods are shipped back, so carrier, service and 1+ tracking numbers are required.
- `RejectReason` codes 3-12 on every platform: 3 physical damage, 4 item missing, 5 wrong item returned,
  6 CPU pin damage, 7 missing retail box, 8 missing UPC code, 9 tampered serial number, 10 missing
  accessories, 11 consumable item, 12 motherboard socket pin damage. Newegg.com and Neweggbusiness.com add
  13 QA sent wrong item, 14 unlocked cellphone, 15 used item returned as new; Newegg.ca adds 16 customer
  request, 17 missing serial number, 18 software (`platform/rma.ts` `rejectReasonCodes`). Codes 4 and 6-12
  require a memo and 1-5 image URLs.
- Only an **open** RMA may be edited, received or rejected (SE028); the SDK blocks a non-open RMA from a
  read and warns when it is still `processing` (see ASSUMPTIONs).

### 20.4 Platform differences (`packages/sdk/src/platform/rma.ts`)

| Difference                 | Newegg.com (us) | Neweggbusiness.com (b2b) | Newegg.ca (ca) |
| -------------------------- | --------------- | ------------------------ | -------------- |
| Write `version`            | 307             | 305                      | 305            |
| Evidence images / memo     | accepted        | **refused by the SDK**   | accepted       |
| Reject reasons beyond 3-12 | 13, 14, 15      | 13, 14, 15               | 16, 17, 18     |
| Currency                   | USD             | USD                      | CAD            |

### 20.5 Issue Courtesy Refund (`IssueCourtesyRefund`)

```json
{
  "OperationType": "IssueCourtesyRefund",
  "RequestBody": {
    "IssueCourtesyRefund": {
      "SourceSONumber": "900000002",
      "RefundReason": "6",
      "TotalRefundAmount": "10.00",
      "NoteToCustomer": "text"
    }
  }
}
```

`RefundReason`: 1 negative customer feedback, 2 pricing error, 3 wrong item information, 4 shipping delay,
5 package not received, 6 customer courtesy. `TotalRefundAmount` is one positive 2-decimal total in the
marketplace currency, within 0-99,999.99, and must not exceed the order total minus prior refunds
(SE023/SE034). `NoteToCustomer` <= 500. Response: `ResponseBody > ResponseList > ResponseInfo { RequestId,
RequestDate, RequestStatus }` (the field table spells the keys `RequestID` / `RequestSatus` and lists a flat
`Memo`; the SDK reads every spelling and placement). The refund is an **asynchronous request**: follow it
with Get Courtesy Refund Request Status (§18.3, `client.refunds.getRequestStatus`).

### 20.6 Idempotency and indeterminate outcomes (ADR 0004)

None of the five writes is idempotent (a re-send creates a second RMA or pays a second refund) and none
accepts a client token. `sendServiceWrite` (`servicemgmt/write.ts`) therefore retries **only** transport
failures proven to have happened before any byte was sent; the first ambiguous failure (timeout or reset
after dispatch, a caller abort after the request was dispatched, HTTP 408 or ANY 5xx,
including a plain 500) throws `IndeterminateServiceWriteError` (`service_write_indeterminate`,
never `retryable`) carrying the operation, order and RMA number and the time it was submitted. The same
error is thrown when Newegg answers 2xx but the response does not identify the RMA (or, for a refund, has no
`RequestId`), or names a different RMA than the one edited. The guidance is to check `rma.list/get` or
`refunds.list/listRequests` before doing anything else. A `200` with `IsSuccess=false` is a definitive
`NeweggApiError`; upstream `SE0xx`/`CE0xx` 4xx errors pass through unchanged.

### 20.7 SDK and MCP mapping

All WRITES. Every method takes a normalized, strict (zod 4) input; unknown keys, a third decimal, a refund
price on a replacement, missing evidence and reasons not offered by the marketplace are rejected before any
request.

| SDK                                                   | Wire | MCP (writes enabled only)                                   |
| ----------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `client.rma.previewSubmit(input)` / `submit(input)`   | 20.2 | `newegg_rma_preview_submit` / `newegg_rma_apply_submit`     |
| `client.rma.previewEdit(input)` / `edit(input)`       | 20.3 | `newegg_rma_preview_edit` / `newegg_rma_apply_edit`         |
| `client.rma.previewProcess(input)` / `process(input)` | 20.3 | `newegg_rma_preview_process` / `newegg_rma_apply_process`   |
| `client.rma.previewReject(input)` / `reject(input)`   | 20.3 | `newegg_rma_preview_reject` / `newegg_rma_apply_reject`     |
| `client.refunds.previewIssue(input)` / `issue(input)` | 20.5 | `newegg_refund_preview_issue` / `newegg_refund_apply_issue` |

**Pre-write reads.** `preview*` is read-only: it calls Get Order Information, Get RMA Information and Get
Courtesy Refund Information (never a write) and returns `blockers` (the `SE0xx` rules above: unknown /
voided / uninvoiced / replacement order, a line not on the order or cancelled, quantity above the returnable
quantity, unit refund above the unit price, shipping above the charge, refund above the order total or the
total minus prior refunds, non-open RMA) and `warnings` (an existing RMA or courtesy refund on the order,
replacement stock, the commission note, RMA still processing). Prior refunds are summed from active RMAs plus
non-void courtesy refunds; a mismatch with the order's `RefundAmount` is a warning only. The checks **fail
closed**: an unknown order total, a partial read of the order's RMAs or courtesy refunds, and any prior
refund line with no readable price or amount (never counted as 0) are BLOCKERS, because the remaining
balance cannot be established. The write methods
**re-run the same checks and throw `NeweggValidationError` before any POST** when there is a blocker.

**MCP.** Both the preview and the apply tool of each pair register only when
`NEWEGG_MCP_ALLOW_WRITES=true` (ADR 0005 and the pricing precedent). A preview with blockers returns no
`previewId`; a clean one returns a single-use, TTL-bound, 256-bit `previewId`, and apply accepts only that
id, re-hashes the stored request (`preview_tampered`) and refuses a replay, an expired id or one of another
kind. The ceiling `NEWEGG_MCP_MAX_REFUND_AMOUNT` (default 500, in the marketplace currency) applies to
EVERY `refundTotal`: RMA submit, edit and process, and the courtesy refund. It is MCP-only and **per
operation**, not cumulative across previews: SDK callers are the operator, so the SDK enforces only the
schema maximum (99,999.99) and the order-balance blockers above. A refund above the ceiling is blocked at
preview time, and a refund-type write whose amount reads as 0 (unreadable
lines) is blocked too rather than passing the ceiling. The previewed refund total (cents) is stored with
the preview and covered by its hash. Process RMA releases whatever the RMA holds at that moment, so the
apply tool re-reads the RMA first and aborts (`preview_stale`, preview consumed, nothing sent) if it is
no longer open, its refund differs from the previewed total, or it exceeds the ceiling. Outputs map fields explicitly and omit the customer block, free-text notes,
memos, tracking numbers and label URLs (`docs/mcp-security.md`).

**Not built.** (1) Voiding / closing an RMA and any other RMA status change: the section documents no such
operation. (2) `IssueUser`: never sent (**ASSUMPTION:** optional). (3) `DiffShippedByPartyAction`: the Submit
RMA page lists it as REQUIRED for a Replacement RMA on an order that has both Shipped-by-Seller (SBS) and
Shipped-by-Newegg (SBN) items. The SDK does not send it (it cannot detect a mixed order) and instead adds a
WARNING to every replacement-RMA preview that Newegg may reject it. (4) Anything beyond the five documented
operations.

**ASSUMPTIONs (unverified, retire when an owner-authorized write is observed):**

- Every response shape above (the Submit "response" sample is a copy of the request) and that Edit / Process /
  Reject return the RMA under `ResponseBody > RMAInfo`.
- The `version` values 307 / 305 for writes (the pages give them for the write pages; neither was probed).
- That `servicemgmt/rma/newrma`, `updaterma` and `courtesyrefund/new` exist under `b2b/` and `can/`.
- That the courtesy `RequestId` equals the later `CourtesyRefundID` (as §18.3).
- That only the `SE0xx` rules listed are enforced and that the local mirrors match Newegg's arithmetic
  (the SDK is stricter than Newegg only where a read proves the write would fail).
- That Edit replaces the whole line set (the page shows a full `RMATransactionList`) rather than patching rows.
- That receiving a refund RMA is what lets Newegg pay the buyer's refund (the pages do not say so in terms).
- That a `processing` (status 6) RMA is not editable (SE028 says "open"); the SDK only warns about it.
- The wire values and semantics of `DiffShippedByPartyAction` (unread; not sent).
- That omitting `UnOpen` / `FileUrls` / `Memo` for reasons other than 3 / 4 / 6 / 8 is accepted.
- The 100/hour and 1,000/hour limits on the pages (the live headers on other reads disagree with their
  pages, §19.1).

## 21. SBN (Shipped by Newegg) — inbound shipment reads

Extracted 2026-10-15 from the official SBN pages, all under
`https://developer.newegg.com/newegg_marketplace_api/sbn_shipped_by_newegg_management/` (the section lists
seven functions; every page was last updated 2018-10-15). The wire domain is `sbnmgmt/inboundshipment/`
(the standard prefix applies: none on Newegg.com, `b2b/`). **Every page lists Newegg.com and
Neweggbusiness.com only; Canada is not listed**, so the SDK fails on CAN with
`UnsupportedMarketplaceOperationError` before sending (`platform/sbn.ts`, ADR 0002). Nothing here was called
live except as marked "Live-verified 2026-10-16": the shapes below are the pages' samples, which contradict
themselves in places (flagged below). Every example uses fictional identifiers.

**Live verification, 2026-10-16 (usa and b2b, READ-ONLY, same credentials as the other reads):** Get Inbound
Shipment List and Get Warehouse List were each called through the SDK on both platforms and returned HTTP 200
with `IsSuccess`, `OperationType`, `SellerID` and `ResponseBody` (list: `ShipmentList`, empty for this seller;
warehouses: `WarehouseList`, one record with `WarehouseCode`, `AllowBulkItem`, `AllowSmallItem` and the
address fields). No separate SBN enablement was needed for these two reads. Get Inbound Shipment Status
Request and Get Inbound Shipment Request Result were NOT called (no request id exists to look up). CAN fails
before sending, as designed. No SDK change was needed.

### 21.1 Operation inventory and classification

| Function                        | Page (`sbn_shipped_by_newegg_management/…`) | Verb (table)        | Path (after prefix)                                  | Rate limit | Class     | In SDK |
| ------------------------------- | ------------------------------------------- | ------------------- | ---------------------------------------------------- | ---------- | --------- | ------ |
| Get Inbound Shipment List       | `get_inbound_shipment_list/`                | PUT                 | `sbnmgmt/inboundshipment/shipmentlist`               | 500/hr     | **READ**  | yes    |
| Get Inbound Shipment Status Req | `get_inbound_shipment_status_request/`      | PUT                 | `sbnmgmt/inboundshipment/shipmentstatus`             | 1,000/min  | **READ**  | yes    |
| Get Inbound Shipment Req Result | `get_inbound_shipment_request_result/`      | GET                 | `sbnmgmt/inboundshipment/shipmentresult/{requestid}` | 500/hr     | **READ**  | yes    |
| Get Warehouse List              | `get-warehouse-list/`                       | PUT                 | `sbnmgmt/inboundshipment/warehouse`                  | 1,000/min  | **READ**  | yes    |
| Get Inbound Shipment Plan Sugg. | `get_inbound_shipment_plan_suggestion/`     | PUT                 | `sbnmgmt/inboundshipment/plansuggestion`             | 1,000/min  | unclear   | **no** |
| Submit Create Inbound Shipment  | `submit_create_inbound_shipment_request/`   | POST (examples PUT) | `sbnmgmt/inboundshipment/shipmentrequest`            | 100/min    | **WRITE** | **no** |
| Submit Void Inbound Shipment    | `submit_void_inbound_shipment_request/`     | POST (examples PUT) | `sbnmgmt/inboundshipment/shipmentrequest`            | 100/min    | **WRITE** | **no** |

Classification follows what each page says it does. The three `PUT` reads carry a request body and, like
order info (§10), Get Item Price (§15), the RMA reads (§18) and the reference reads (§19), the verb does not
imply a write. Create and Void share one URL and one `OperationType` (`SubmitShipmentRequest`); they are
WRITES and deliberately not implemented. They are classified in the live read-only guard
(`scripts/check-live-readonly.ts`, `scripts/live-readonly-ast.ts`) so they stay blocked in live tests.

**Skipped, with the reason:**

- **Get Inbound Shipment Plan Suggestion** (`PUT …/plansuggestion`, `OperationType: GetPlanSuggestionRequest`,
  body `PlanSuggestion > ItemList > Item { SellerPartNumber, PlannedQuantity, QuantityPerCarton? }`, errors
  `SBN002` invalid seller part number / `SBN003` item is Shipped-by-Seller). It reads like a pure
  computation, but the page never says it has no side effects (it is a `PUT`, its description is truncated,
  and the request/response examples disagree with each other: quantity 32 vs 30, `NumberofCartons` missing
  from some JSON rows, a warehouse code `12` outside the documented list). Not "clearly a read", so it is not
  built and is blocked in the live guard until an owner-authorized probe shows it is side-effect free.
- **Create / Void Inbound Shipment**: writes (see above).

### 21.2 Get Inbound Shipment List

`PUT {prefix}sbnmgmt/inboundshipment/shipmentlist?sellerid=…`. **Live-verified 2026-10-16 (usa/b2b):** the
verb is `PUT` with a body (the Resource table and XML example were right; the JSON example's `GET` request
line is wrong), and the path and the nested `RequestBody.PageInfo` shape are accepted. Verified with
`PageInfo` only (no keyword, status or date filters sent), which returned an empty `ShipmentList` for this
seller. **ASSUMPTION (still unverified):** the filter fields and date formats below, and the row shape (no
shipment existed to inspect). The JSON request sample nests paging; the field table lists it flat. The SDK
follows the sample:

```json
{
  "OperationType": "GetShipmentListRequest",
  "RequestBody": {
    "PageInfo": { "PageIndex": 1, "PageSize": 10 },
    "KeywordsType": 1,
    "KeywordsValue": "2740139",
    "Status": 0,
    "LastUpdateDateFrom": "01/01/2013",
    "LastUpdateDateTo": "07/07/2013"
  }
}
```

| Field                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageInfo.PageIndex` / `PageSize` | Required; page size max 100. The SDK always sends both (default 1 / 100).                                                                                                                                                                                                                                                                                                                                                           |
| `KeywordsType`                    | 0 All (default) · 1 Shipment ID · 2 Newegg Item Number · 3 Seller Part Number.                                                                                                                                                                                                                                                                                                                                                      |
| `KeywordsValue`                   | String matched per `KeywordsType`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Status`                          | 0 All (default) · 1 Preparing · 2 Shipped · 3 Received · 4 Partially Received · 5 Manually closed · 6 Voided.                                                                                                                                                                                                                                                                                                                       |
| `LastUpdateDateFrom` / `To`       | Pacific time. The "Acceptable Date Format" page lists `YYYY-MM-DD HH:MM:SS`, `MM/DD/YYYY`, … and states no zone rule. The page's own samples send `"01/01/2013"` / `"07/07/2013"` (JSON) and `"06/01/2013"` / `"06/07/2013"` (XML); `YYYY-MM-DD HH:mm:ss` is the SDK's choice from the Acceptable Date Format list (re-fetched 2026-10-15). Both empty = the last 30 days. The SDK renders a `Date` as that format in Pacific time. |

Response (JSON sample; XML nests `ShipmentList > Shipment`, `PackageList > Package`, `ItemList > Item`):

```json
{
  "IsSuccess": true,
  "OperationType": "GetShipmentListResponse",
  "SellerID": "A006",
  "ResponseBody": {
    "ShipmentList": [
      {
        "ShipmentID": "2740139",
        "Status": "Ready to ship",
        "CreateDate": "06/06/2013 17:02:31",
        "LastEditDate": "06/07/2013 11:31:00",
        "ShipFrom": "Test_Store",
        "ShipToWarehouseCode": "14",
        "ShipToAddress1": "…",
        "ShipToCityName": "…",
        "ShipToStateCode": "NJ",
        "ShipToZipCode": "…",
        "ShipToCountryCode": "USA",
        "ShippingMethodCode": 1,
        "ShippingCarrierCode": 99,
        "OtherCarrierName": "…",
        "PackageList": [
          {
            "TrackingNumber": "…",
            "PackageWeight": 0,
            "PackageLength": 0,
            "PackageHeight": 0,
            "PackageWidth": 0
          }
        ],
        "ItemList": [{ "SellerPartNumber": "…", "Quantity": 36, "NumberofPackage": 2 }]
      }
    ]
  }
}
```

`Status` text values: Creating, Preparing, Ready to ship, Shipped, Partially Received, Received, Void,
Manually closed (a shipment older than 3 months and still not received). `ShippingMethodCode`: 1 small parcel,
2 less-than-truckload (the JSON sample shows `0`; the SDK leaves any other value undefined).
`ShippingCarrierCode`: for method 1, 101 DHL · 102 FedEx · 103 UPS · 104 USPS · 105 Newegg partnered carrier
(UPS) · 99 other (named in `OtherCarrierName`); method 2 only 99. Warehouse codes listed: 06 Tennessee Bulk ·
07 California Small · 08 California Bulk Item · 10 New Jersey Bulk · 14 New Jersey Small. **The response has
no pagination fields** (no total, no page echo): a full page may have more, so the SDK echoes the requested
paging and callers page until a short page. The field table documents the package fields flat on the shipment;
the SDK reads `PackageList` and falls back to the flat fields.

### 21.3 Get Inbound Shipment Status Request

`PUT {prefix}sbnmgmt/inboundshipment/shipmentstatus?sellerid=…`. Status of the create/void SUBMISSIONS (not
of the shipments, which §21.2 lists). The JSON sample nests the filters (the field table lists them flat; the
SDK follows the sample, as the Feed Status read does, §7.5):

```json
{
  "OperationType": "GetShipmentStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": ["ABC123"] },
      "ActionCode": 1,
      "MaxCount": 100,
      "RequestStatus": "ALL",
      "RequestDateFrom": "…",
      "RequestDateTo": "…"
    }
  }
}
```

`RequestID` (when set, every other filter is ignored) · `ActionCode` 0 All (default) / 1 Create / 2 Void ·
`MaxCount` default 100, values above 100 still return 100 · `RequestStatus` ALL (default), SUBMITTED,
IN_PROGRESS, FINISHED, CANCELLED · `RequestDateFrom`/`To` Pacific time. **ASSUMPTION:** absent filters may be
omitted (the SDK sends only the filters given; the XML sample sends empty date elements).

Response: `ResponseBody > ResponseList[]` (XML `ResponseList > ResponseInfo`) of `{ RequestId, ActionCode,
RequestDate "MM/DD/YYYY HH:MM:SS", RequestStatus }` plus `Memo` (error detail; in the field table only). The
key is spelled `RequestId` in the response and `RequestID` in the request; the SDK reads both.

### 21.4 Get Inbound Shipment Request Result

`GET {prefix}sbnmgmt/inboundshipment/shipmentresult/{requestid}?sellerid=…`, no body. Response
(`IsSuccess` is the string `"true"` in the sample):

```json
{
  "IsSuccess": "true",
  "OperationType": "GetShipmentResultResponse",
  "SellerID": "A006",
  "ResponseBody": {
    "RequestID": "ABC123",
    "RequestDate": "07/14/2013 22:40:00",
    "ProcessedDate": "07/14/2013 22:41:25",
    "RequestStatus": "FINISHED",
    "Shipment": {
      "ShipmentID": 2740139,
      "Label": [
        { "LabelType": "ItemLabel", "LabelUrl": "ftp://…" },
        { "LabelType": "PackageLabel", "LabelUrl": "ftp://…" },
        { "LabelType": "PackingListLabel", "LabelUrl": "ftp://…" },
        { "LabelType": "ShippingLabel", "LabelUrl": "ftp://…" }
      ]
    }
  }
}
```

XML wraps the labels in `Shipment > LabelURLList > Label` and carries an (empty in the sample) `ErrorList`.
The field table spells the key `LabelURL` where the samples use `LabelUrl` (the SDK reads both) and lists
`ErrorDescription`. The page shows no failed or in-progress example and documents only `FINISHED`.

**Label URLs are treated as secrets. ASSUMPTION:** the samples show `ftp://` URLs, which for the report
files (§17.5) embed `user:password@`. The SDK therefore never returns, logs or puts a label URL in an error:
`SbnShipmentLabel` carries only `type`, `host` and `fileName`, `raw` is run through the report redactor, and
the MCP tool maps the same fields. Downloading label files is out of scope for this PR (it would need the
FTP downloader and a path check like the report files').
**ASSUMPTION:** where `ErrorList` / `ErrorDescription` carry text it is surfaced as `errors[]`; the entry
shape inside `ErrorList` is unknown (the SDK accepts bare strings or objects with
`ErrorDescription` / `Description` / `Message`, optionally under `Error`).

### 21.5 Get Warehouse List

`PUT {prefix}sbnmgmt/inboundshipment/warehouse?sellerid=…`. This is Newegg's own SBN inbound-warehouse list
(the page `seller_management/get-warehouse-list/` redirects to it, §19.1). **Live-verified 2026-10-16
(usa/b2b):** verb and path are as the Resource table and XML example say (`PUT …/warehouse`); the JSON
example's `GET …/shipmentlist` request line was the copy-paste from §21.2 it looked like. Body:
`{ "OperationType": "GetWarehouseRequest", "RequestBody": { "WarehouseCode": "10" } }`. `WarehouseCode` is
optional; an empty `RequestBody` is accepted and returned the response shape below (one warehouse record for
this seller on both platforms). **ASSUMPTION (still unverified):** that omitting it returns _every_
warehouse, and filtering by a code (not exercised). Response: `ResponseBody > WarehouseList[]` (XML `WarehouseList > Warehouse`) of
`{ WarehouseCode "10", AllowBulkItem 0|1, AllowSmallItem 0|1, ShipToAddress1/2, ShipToCityName,
ShipToStateCode, ShipToZipCode, ShipToCountryCode }`.

### 21.6 Wire quirks handled

Numbers as strings or numbers (`ShipmentID` is a quoted string in the list sample and a bare number in the
result sample); `IsSuccess` as boolean or string; single-element lists as objects with the XML inner key;
empty lists as `""`; dates `MM/DD/YYYY HH:MM:SS` Pacific wall-clock (`platform/dates.ts`); a 200 whose body
is a bare `[{ Code, Message }]` list becomes a `NeweggApiError`. Error bodies on non-2xx go through
`errors/parse-upstream.ts`. The pages' "Failed Response Error Code List" is the only error reference.

**Live-verified 2026-10-16 (usa/b2b):** verbs, paths and the nested request shape of Get Inbound Shipment
List and Get Warehouse List (§21.2, §21.5); that absent optional filters are accepted by both; the response
envelope (`IsSuccess`, `OperationType`, `SellerID`, `ResponseBody`); empty list handling. The shipment-list
rate-limit header read 100 per window against the page's 500/hr (the same page-vs-header disagreement as
§19.1); the warehouse read returned no rate-limit headers.

**ASSUMPTIONs (still unverified, retire with a live read):** the verb, path and nested request shape of Get
Inbound Shipment Status Request and Get Inbound Shipment Request Result (§21.3, §21.4), including that absent
optional filters are accepted there and the `ErrorList` entry shape; the list filters and dates (§21.2); the
non-empty shipment row shape; and that `ShippingMethodCode` takes only 1 or 2.
