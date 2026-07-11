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
in `packages/sdk/src/schemas/condition.ts`.

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
