# Newegg Marketplace SDK + MCP server

A TypeScript monorepo providing a transport-independent **Newegg Marketplace SDK** and a
narrowly-scoped **Model Context Protocol (MCP) server** on top of it, with first-class,
safety-first inventory management across Newegg's US, B2B, and Canada marketplaces.

- **`@devino/newegg-marketplace-sdk`** — the SDK. One runtime dependency (`zod`), no MCP
  baggage, no I/O at import time. Usable from queues, cron jobs, HTTP services, or the CLI.
- **`@devino/newegg-marketplace-mcp`** — an MCP server exposing Newegg read tools (inventory,
  prices, orders, reports, RMAs, catalog, reference data) over stdio and Streamable HTTP. Write
  tools exist only with `NEWEGG_MCP_ALLOW_WRITES=true` and always go through preview → apply.

> The `@devino` scope is a placeholder chosen to be easy to find-and-replace. See
> [`docs/publishing.md`](docs/publishing.md#rename-the-devino-scope) to rename it.

## Contents

- [What's in here](#whats-in-here)
- [Requirements](#requirements)
- [Installation](#installation)
- [SDK quick start](#sdk-quick-start)
- [Reading inventory](#reading-inventory)
- [SDK surface](#sdk-surface)
- [MCP tools](#mcp-tools)
- [MCP server — stdio](#mcp-server--stdio)
- [MCP server — Streamable HTTP](#mcp-server--streamable-http)
- [Environment variables](#environment-variables)
- [Security model](#security-model)
- [Preview & apply workflow](#preview--apply-workflow)
- [Direct vs feed strategy](#direct-vs-feed-strategy)
- [Platform differences](#platform-differences)
- [Feed lifecycle](#feed-lifecycle)
- [Rate limits](#rate-limits)
- [Error handling](#error-handling)
- [Testing](#testing)
- [Development](#development)
- [Publishing](#publishing)
- [Current limitations](#current-limitations)
- [License](#license)

---

## What's in here

```
newegg-marketplace-sdk-node-js/
├─ packages/
│  ├─ sdk/          @devino/newegg-marketplace-sdk — transport-independent TS SDK
│  └─ mcp-server/   @devino/newegg-marketplace-mcp — MCP server (stdio + Streamable HTTP)
├─ examples/        runnable examples (npm workspaces):
│  ├─ sdk-basic/              read + preview with the SDK
│  ├─ sdk-batch-inventory/    batch updates, dedup, feed chunking
│  ├─ sdk-orders-and-reports/ read-only: unshipped orders + settlement summary
│  ├─ sdk-pricing-preview/    price read + previewUpdate only (never writes)
│  ├─ mcp-stdio/              MCP client over stdio
│  └─ mcp-http/               MCP client over Streamable HTTP
├─ docs/
│  ├─ adr/          architecture decision records (0001–0005)
│  └─ research/     verified Newegg wire contracts + the binding SDK API contract
├─ scripts/         TypeScript checks run via tsx (check-secrets, check-live-readonly,
│                   verify-exports), typechecked by tsconfig.scripts.json
└─ .github/workflows/ci.yml   one job per check (lint, format, secrets, live-readonly,
                              dead-code, build, typecheck, tests, exports, docs, pack)
```

Deep-dive docs:

- [`docs/inventory-strategies.md`](docs/inventory-strategies.md) — direct vs feed vs auto,
  dedup, chunking, polling, result anatomy.
- [`docs/platform-differences.md`](docs/platform-differences.md) — US vs B2B vs CA wire
  differences.
- [`docs/error-handling.md`](docs/error-handling.md) — error classes, retries, recovery.
- [`docs/mcp-security.md`](docs/mcp-security.md) — MCP threat model and mitigations.
- [`docs/publishing.md`](docs/publishing.md) — release and scope-rename procedure.
- `docs/research/` — the verified Newegg wire contracts
  ([`newegg-api-contracts.md`](docs/research/newegg-api-contracts.md)) and the binding SDK
  public-API contract ([`sdk-public-api.md`](docs/research/sdk-public-api.md)) these packages
  implement.

---

## Requirements

- **Node.js ≥ 22.12.0** (CI runs Node 22.x and 24.x).
- **ESM only** — both packages are `"type": "module"`; there is no CommonJS build.
- **TypeScript** consumers get strict types out of the box (the SDK ships `.d.ts`).

---

## Installation

Install whichever package you need:

```bash
# the SDK, for your own services
npm install @devino/newegg-marketplace-sdk

# the MCP server, for LLM clients
npm install @devino/newegg-marketplace-mcp
```

The MCP server can also be run without installing via `npx -y @devino/newegg-marketplace-mcp`
(see [MCP server — stdio](#mcp-server--stdio)).

---

## SDK quick start

Preview an inventory update, review the plan, then apply it — letting the SDK choose direct
vs feed automatically and waiting for any feed to finish:

```ts
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";

const client = createNeweggClient({
  sellerId: process.env.NEWEGG_SELLER_ID!,
  apiKey: process.env.NEWEGG_API_KEY!,
  secretKey: process.env.NEWEGG_SECRET_KEY!,
  marketplace: "us",
});

const preview = await client.inventory.previewUpdate([
  {
    identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
    warehouseLocation: "USA",
    quantity: 12,
  },
]);
console.log(preview);

const result = await client.inventory.updateMany(preview.normalizedUpdates, {
  strategy: "auto",
  waitForFeedCompletion: true,
});
console.log(result);
```

`createNeweggClient` validates its config synchronously (no network, no credentials read
from the environment on your behalf) and throws `NeweggConfigurationError` if anything is
wrong. `warehouseLocation` is an uppercase ISO 3166-1 alpha-3 code and is required for US
operations.

---

## Reading inventory

```ts
// One item
const snapshot = await client.inventory.getItem({
  identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
  warehouses: ["USA"], // US only; ignored on B2B/CA
});
console.log(snapshot.totalAvailableQuantity, snapshot.warehouses);

// Many items (SDK chunks large lists at 100 identifiers/request)
const batch = await client.inventory.getMany({
  identifiers: [
    { type: "sellerPartNumber", value: "SKU-1" },
    { type: "neweggItemNumber", value: "9SIA0060884598" },
  ],
});
console.log(batch.items); // InventoryItemSnapshot[]
console.log(batch.missingIdentifiers); // requested but not returned by Newegg
```

Snapshots normalize Newegg's platform-specific, mixed-type wire shapes into a single form:
`totalAvailableQuantity`, a per-`location` `warehouses[]` breakdown with normalized
`fulfillment` (`"seller"` / `"newegg"`), and `active` (B2B/CA only).

## Reading prices

```ts
const price = await client.pricing.get({
  identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
  countries: ["USA"], // US only; ignored on B2B/CA
});
console.log(price.prices); // US: one entry per destination country; B2B/CA: one entry
```

`client.pricing.get/tryGet/getMany` are reads (Get Item Price): selling price, MSRP/MAP,
free-shipping flag, promotion locks, and the active flag. B2B/CA responses carry no currency, so
it is inferred from the marketplace and flagged `currencyInferred`. `getMany` fans out single
reads (1–100 identifiers) because the batch-price pages are not documented readably. The matching
MCP tool is `newegg_pricing_get`.

`client.pricing.previewUpdate(updates)` (read-only) risk-checks selling-price changes, and
`client.pricing.update(updates)` **writes** them: price only (never MAP, MSRP, shipping or
activation), absolute, validated (> 0, ≤ 2 decimals, never rounded), and read back so a silently
ignored update on a deactivated item shows as `unverified` instead of success. The MCP pair
`newegg_pricing_preview_update` / `newegg_pricing_apply_update` exists only with
`NEWEGG_MCP_ALLOW_WRITES=true`. The US write path follows the docs but is not live-verified.

## RMAs and courtesy refunds

```ts
const open = await client.rma.list({ status: "open", pageSize: 20 });
for (const rma of open.rmas)
  console.log(rma.rmaNumber, rma.type, rma.status, rma.availableRefundAmount);

const rma = await client.rma.tryGet("<rma number>"); // undefined when it does not exist
const refunds = await client.refunds.list({ status: "closed", dateFrom: "2026-09-01" });
const request = await client.refunds.getRequestStatus("<courtesy refund request id>");
```

These wrap Get RMA Information and the two courtesy refund reads (contracts §18). They are `PUT`
requests but only read, so the SDK and the MCP tools (`newegg_rma_list`, `newegg_rma_get`,
`newegg_refund_list`, `newegg_refund_status`) are always available. The MCP tools return business fields only - never the buyer's name, phone, e-mail or address. Amounts are
USD on Newegg.com / Neweggbusiness.com and CAD on Newegg.ca; Get Courtesy Refund Information is
limited to 30 requests per minute.

### RMA and courtesy refund writes (money-moving)

```ts
const plan = await client.rma.previewSubmit({
  orderNumber: "<order number>",
  type: "refund",
  items: [
    {
      sellerPartNumber: "<sku>",
      returnQuantity: 1,
      reason: "defective",
      returnUnitPrice: 40.0,
      refundShippingPrice: 0,
    },
  ],
}); // read-only: blockers + warnings
if (plan.blockers.length === 0) await client.rma.submit(plan.normalized);

await client.refunds.issue({
  orderNumber: "<order number>",
  reason: "customerCourtesy",
  amount: 10,
});
```

`rma.submit/edit/process/reject` and `refunds.issue` (contracts §20) each have a read-only
`preview*` twin; the write re-runs the same checks and throws `NeweggValidationError` on any
blocker before sending. Money is positive, at most 2 decimals, and never rounded or clamped. The
writes are not idempotent: an ambiguous failure (timeout or reset after dispatch, 408/5xx, or a
2xx that does not identify the RMA / refund request) throws `IndeterminateServiceWriteError` and is
never auto-retried; check `rma.list/get` or `refunds.list/listRequests` first. A courtesy refund
does NOT refund the commission. The MCP pairs `newegg_rma_preview_submit|edit|process|reject` /
`newegg_rma_apply_*` and `newegg_refund_preview_issue` / `newegg_refund_apply_issue` exist only
with `NEWEGG_MCP_ALLOW_WRITES=true` (courtesy refunds are capped by `NEWEGG_MCP_MAX_REFUND_AMOUNT`).
The write paths follow the docs but have never been sent to a real account. Void / close RMA is
not implemented (no documented operation).

## Seller status and category reference (read-only)

```ts
const status = await client.reference.getSellerStatus(); // active / suspended / ...
const { industries } = await client.reference.listIndustries();
const { subcategories } = await client.reference.listSubcategories({
  industryCodes: ["AP"],
  enabled: true,
});
const { properties } = await client.reference.listSubcategoryProperties(1045);
const { properties: values } = await client.reference.listPropertyValues({
  propertyName: "Costume_Gender",
  subcategoryId: 1045,
});
```

These are the lookups item creation needs first: which categories the seller may list in, and which
properties and allowed values each takes (Seller Status Check, Get Industry List, Get Subcategory
Status, Get Subcategory Properties / Property Values; contracts §19). The subcategory, property and
value reads are `PUT` requests but only read; the SDK and the MCP tools (`newegg_seller_status`,
`newegg_industries_list`, `newegg_subcategories_list`, `newegg_subcategory_properties`,
`newegg_property_values`) are always available. `countryCode` on `listSubcategories` (the
international variant) is Newegg.com only. Get Warehouse List and Get Subcategory Status v1.1 are not
implemented (their documentation pages are unusable; see contracts §19.1). Get Subcategory Status, Properties and
Property Values share one small request budget, and the live rate-limit header reports less than
the docs state (contracts §19.1), so cache the results.

## Reports (settlement, daily inventory, daily price)

```ts
const summary = await client.reports.settlementSummary.waitForResult({
  dateFrom: "2026-09-01", // Pacific Time; a Date is rendered as its Pacific calendar date
  dateTo: "2026-09-30",
});
console.log(summary.rows[0]?.totalSettlement); // numbers, not strings; absent = not reported

const lines = await client.reports.settlementTransactions.waitForResult({
  settlementDateFrom: "2026-09-01",
  settlementDateTo: "2026-09-30",
  transactionType: "order",
});

const stock = await client.reports.dailyInventory.waitForResult({}); // FTP file, parsed for you
console.log(stock.totalRows, stock.rows[0]?.inventory);
```

Reports are asynchronous Newegg jobs (submit → poll → result; 100 submissions/hour). Settlement reports can take about 3 minutes, so `waitFor*` waits up to 300 s for them (120 s for the daily file reports; override with `timeoutMs`). Report
submission is a `POST` that creates a report job only - it changes nothing on the account, so
the reports API and its MCP tools (`newegg_reports_settlement_summary`,
`newegg_reports_settlement_transactions`, `newegg_reports_daily_inventory`,
`newegg_reports_daily_price`, `newegg_reports_status`) are always available and read-only. If a
wait times out, `ReportTimeoutError.requestId` lets you continue with `waitForRequest`. The
daily reports return an FTP URL with embedded credentials; the SDK downloads the file itself and
never exposes or logs that URL. Daily Price exists on Newegg.com only; on B2B/CA use the Daily
Inventory report, which carries price and activation columns. Details: contracts §17.

To enumerate every listing (there is no synchronous "list my products" call) use the Item Basic
Information report; Order List and RMA List are the asynchronous variants of the order / RMA reads
(MCP: `newegg_reports_item_basic_info`, `newegg_reports_order_list`, `newegg_reports_rma_list`,
also reachable through `newegg_reports_status`). They take 2-4 minutes, so the MCP tools answer
`pending` + `requestId` after `waitSeconds`. The order and RMA tools never return customer data.

```ts
const listings = await client.reports.itemBasicInfo.waitForResult({ status: "active" });
console.log(listings.totalRows, listings.rows[0]?.sellerPartNumber); // SKU, no price/stock
```

---

## SDK surface

`createNeweggClient(config)` returns a `NeweggClient`. The binding contract is
[`docs/research/sdk-public-api.md`](docs/research/sdk-public-api.md); `packages/sdk/src/types.ts`
is the source of truth for signatures. **Write** methods change the real seller account; every
other method only reads (several reads are HTTP `PUT`/`POST` upstream, so classify by this table,
not by verb).

| Namespace                    | Reads                                                                                                                                                   | Writes                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `client.inventory`           | `getItem`, `tryGetItem`, `getMany`, `previewUpdate`                                                                                                     | `updateItem`, `updateMany`                            |
| `client.pricing`             | `get`, `tryGet`, `getMany`, `previewUpdate`                                                                                                             | `update`                                              |
| `client.orders`              | `list`, `get`, `tryGet`, `getStatus`, `tryGetStatus`, `listAdditionalInfo`, `getAdditionalInfo`, `tryGetAdditionalInfo`                                 | `ship`, `cancel`, `confirmDownload`, `removeItems`    |
| `client.listings`            | `previewCreate` (offline)                                                                                                                               | `create` (offers on existing Newegg items only)       |
| `client.catalog`             | `resolve`, `submitLookup`, `lookupStatus`, `lookupResult` (Item Lookup Report)                                                                          | —                                                     |
| `client.reports`             | `settlementSummary`, `settlementTransactions`, `dailyInventory`, `dailyPrice`, `itemBasicInfo`, `orderList`, `rmaList`, `status(id)`                    | — (submitting a report only creates a job)            |
| `client.reference`           | `getSellerStatus`, `listIndustries`, `listSubcategories`, `listSubcategoryProperties`, `listPropertyValues` (needs `subcategoryId`)                     | —                                                     |
| `client.sbn`                 | `listShipments`, `getRequestStatus`, `getRequestResult`, `listWarehouses` (Shipped-by-Newegg inbound shipments; `us`/`b2b` only; create/void not built) | —                                                     |
| `client.rma`                 | `list`, `get`, `tryGet`, `previewSubmit`, `previewEdit`, `previewProcess`, `previewReject`                                                              | `submit`, `edit`, `process`, `reject`                 |
| `client.refunds`             | `list`, `get`, `tryGet`, `listRequests`, `getRequestStatus`, `previewIssue`                                                                             | `issue` (courtesy refund; commission is not refunded) |
| `client.feeds`               | `getStatus`, `getResult`, `waitForResult`                                                                                                               | `submitInventoryFeed`                                 |
| `client.service`             | `getStatus`                                                                                                                                             | —                                                     |
| `client.storefront`          | `getOffers` (unofficial public buy-box reader; `us`/`ca` only)                                                                                          | —                                                     |
| `client.verifyCredentials()` | one service-status GET; throws on 401/403                                                                                                               | —                                                     |

Also exported: `createNeweggClient`, the typed `NeweggError` hierarchy, `InMemoryRateLimitStore`,
`InMemoryOperationStore`, `SDK_VERSION`, and the chunk-size constants. Test helpers live at
`@devino/newegg-marketplace-sdk/testing`.

Runnable examples (read-only or preview-only unless stated in their README): `examples/` (each has its own README).

---

## MCP tools

Read tools are always registered. Write tools (marked **W**) are registered only when
`NEWEGG_MCP_ALLOW_WRITES=true`; each `…_apply_…` tool takes only a `previewId` from its
`…_preview_…` twin (ADR 0005). Full inputs and notes:
[`packages/mcp-server/README.md`](packages/mcp-server/README.md).

| Area      | Read tools (always)                                                                                                                      | Write tools (gated)                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Inventory | `newegg_inventory_get`, `newegg_inventory_preview_update`                                                                                | **W** `newegg_inventory_apply_update`                                                                                    |
| Pricing   | `newegg_pricing_get`                                                                                                                     | **W** `newegg_pricing_preview_update`, `newegg_pricing_apply_update`                                                     |
| Listings  | `newegg_listing_preview_create`                                                                                                          | **W** `newegg_listing_apply_create`                                                                                      |
| RMA       | `newegg_rma_list`, `newegg_rma_get`                                                                                                      | **W** `newegg_rma_preview_{submit,edit,process,reject}`, `newegg_rma_apply_{submit,edit,process,reject}`                 |
| Refunds   | `newegg_refund_list`, `newegg_refund_status`                                                                                             | **W** `newegg_refund_preview_issue`, `newegg_refund_apply_issue` (capped by `NEWEGG_MCP_MAX_REFUND_AMOUNT`, default 500) |
| Orders    | `newegg_orders_list`, `newegg_orders_get`, `newegg_orders_get_status`, `newegg_orders_get_additional_info`                               | none (order ship/cancel is SDK-only)                                                                                     |
| Reports   | `newegg_reports_{settlement_summary,settlement_transactions,daily_inventory,daily_price,item_basic_info,order_list,rma_list,status}`     | —                                                                                                                        |
| Catalog   | `newegg_catalog_resolve`, `newegg_catalog_lookup_status`                                                                                 | —                                                                                                                        |
| Reference | `newegg_seller_status`, `newegg_industries_list`, `newegg_subcategories_list`, `newegg_subcategory_properties`, `newegg_property_values` | —                                                                                                                        |
| SBN       | `newegg_sbn_shipments_list`, `newegg_sbn_request_status`, `newegg_sbn_request_result`, `newegg_sbn_warehouses_list`                      | — (inbound shipment create/void is not built)                                                                            |
| Platform  | `newegg_feed_status`, `newegg_feed_result`, `newegg_service_status`                                                                      | —                                                                                                                        |

The server also serves the resources `newegg://capabilities`, `newegg://configuration/public` and
`newegg://feeds/{requestId}`.

---

## MCP server — stdio

Stdio is the default transport: the MCP client launches the server as a subprocess. Add it
to any MCP-compatible client. **Replace the `${…}` placeholders with real values** (or inject
them via your client's secret mechanism) — never commit real credentials.

Generic MCP client (`mcpServers` config), run via `npx`:

```json
{
  "mcpServers": {
    "newegg-marketplace": {
      "command": "npx",
      "args": ["-y", "@devino/newegg-marketplace-mcp"],
      "env": {
        "NEWEGG_SELLER_ID": "${NEWEGG_SELLER_ID}",
        "NEWEGG_API_KEY": "${NEWEGG_API_KEY}",
        "NEWEGG_SECRET_KEY": "${NEWEGG_SECRET_KEY}",
        "NEWEGG_MARKETPLACE": "us"
      }
    }
  }
}
```

Claude Desktop style (same shape; run the built CLI directly from a local checkout):

```json
{
  "mcpServers": {
    "newegg-marketplace": {
      "command": "node",
      "args": ["packages/mcp-server/dist/cli.js"],
      "env": {
        "NEWEGG_SELLER_ID": "${NEWEGG_SELLER_ID}",
        "NEWEGG_API_KEY": "${NEWEGG_API_KEY}",
        "NEWEGG_SECRET_KEY": "${NEWEGG_SECRET_KEY}",
        "NEWEGG_MARKETPLACE": "us",
        "NEWEGG_MCP_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Writes are **disabled by default** — no write tool is registered unless
`NEWEGG_MCP_ALLOW_WRITES=true`. On stdio, the server logs strictly to stderr; stdout carries
only the JSON-RPC protocol.

---

## MCP server — Streamable HTTP

For network deployments, start the HTTP transport:

```bash
newegg-marketplace-mcp --transport http
```

By default it binds `127.0.0.1:3919`. It **refuses to bind a non-loopback host unless
`NEWEGG_MCP_HTTP_BEARER_TOKEN` is set**, and validates `Host` and `Origin` headers (CORS is
never treated as authentication).

MCP clients connect to the Streamable HTTP endpoint at **`POST http://127.0.0.1:3919/mcp`**;
the session id is returned in the `Mcp-Session-Id` response header and must be echoed on
subsequent `GET`/`DELETE` requests. Guards run in order on `/mcp`: `Origin` allowlist →
`Host` allowlist → bearer token. When a bearer token is configured, clients must present it:

```
Authorization: Bearer ${NEWEGG_MCP_HTTP_BEARER_TOKEN}
```

`GET /healthz` is a separate, unauthenticated liveness probe that reveals no secrets:

```bash
curl -s http://127.0.0.1:3919/healthz
```

See [Security model](#security-model) and [`docs/mcp-security.md`](docs/mcp-security.md)
before exposing the server beyond loopback.

---

## Environment variables

Canonical names and defaults from [`.env.example`](.env.example). Credentials are
**platform-specific**: a US key is not valid for B2B or CA. For `401` errors (a wrong Seller ID or a
key from another platform is the usual cause), see
[`docs/platform-differences.md`](docs/platform-differences.md#credentials-are-platform-specific).

### SDK / credentials

| Variable              | Default           | Meaning                                                                                                        |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `NEWEGG_SELLER_ID`    | — (required)      | Seller ID; sent as the `?sellerid=` query parameter.                                                           |
| `NEWEGG_API_KEY`      | — (required)      | API key; sent as the `Authorization` header value.                                                             |
| `NEWEGG_SECRET_KEY`   | — (required)      | Secret key; sent as the `SecretKey` header value.                                                              |
| `NEWEGG_MARKETPLACE`  | `us`              | Platform: `us` \| `b2b` \| `ca`.                                                                               |
| `NEWEGG_API_BASE_URL` | official endpoint | Trusted override for tests/proxies. Defaults to `https://api.newegg.com/marketplace/`. Never settable via MCP. |

### MCP server

| Variable                              | Default                  | Meaning                                                                                                                                   |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `NEWEGG_MCP_ALLOW_WRITES`             | `false`                  | When `true`, registers the write tools (inventory, pricing, listings, RMA, courtesy refund). Otherwise they are absent from `tools/list`. |
| `NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT` | `50`                     | Largest absolute % change one price update may make vs the current price; bigger is blocked at preview.                                   |
| `NEWEGG_MCP_MAX_REFUND_AMOUNT`        | `500`                    | Largest courtesy refund (or refund-RMA total) one preview may plan, in the marketplace currency.                                          |
| `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION`  | `500`                    | Hard cap on items per preview/apply.                                                                                                      |
| `NEWEGG_MCP_PREVIEW_TTL_SECONDS`      | `600`                    | Lifetime of a stored preview before it expires.                                                                                           |
| `NEWEGG_MCP_ALLOW_ZERO_QUANTITY`      | `true`                   | Whether quantity `0` (out-of-stock) writes are allowed.                                                                                   |
| `NEWEGG_MCP_ALLOWED_WAREHOUSES`       | empty = all              | Comma-separated warehouse allowlist.                                                                                                      |
| `NEWEGG_MCP_ALLOWED_MARKETPLACES`     | empty = all              | Comma-separated marketplace allowlist.                                                                                                    |
| `NEWEGG_MCP_HTTP_HOST`                | `127.0.0.1`              | HTTP transport bind host.                                                                                                                 |
| `NEWEGG_MCP_HTTP_PORT`                | `3919`                   | HTTP transport bind port.                                                                                                                 |
| `NEWEGG_MCP_HTTP_BEARER_TOKEN`        | empty                    | Bearer token; **required** before binding a non-loopback host.                                                                            |
| `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS`     | empty = same-origin only | Comma-separated allowed browser `Origin` values.                                                                                          |
| `NEWEGG_MCP_HTTP_ALLOWED_HOSTS`       | empty                    | Comma-separated allowed `Host` values (`host[:port]`); loopback always allowed.                                                           |

### Live tests (opt-in; never in CI)

| Variable                              | Default | Meaning                                            |
| ------------------------------------- | ------- | -------------------------------------------------- |
| `NEWEGG_LIVE_TESTS`                   | `false` | Master switch for the live smoke suite.            |
| `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER` | empty   | A dedicated **test** listing's Seller Part Number. |
| `NEWEGG_LIVE_TEST_WAREHOUSE`          | empty   | Warehouse/location for the live test.              |

---

## Security model

The MCP server assumes tool descriptions are hints, not security, and enforces every
constraint in code:

- **Read-only by default.** Write tools are registered only when
  `NEWEGG_MCP_ALLOW_WRITES=true`.
- **Preview → apply.** Writes require a two-step flow; apply takes only a single-use,
  TTL-bounded `previewId` and cannot alter the previewed plan. Price changes and refunds are
  also capped (`NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT`, `NEWEGG_MCP_MAX_REFUND_AMOUNT`).
- **No credentials via MCP.** Callers can never supply credentials, base URLs, hostnames, or
  `Overwrite` values; raw upstream bodies never cross the MCP boundary.
- **`Overwrite: "Yes"` is impossible** — the feed envelope hard-codes `"No"`, so catalog-wide
  deactivation is unreachable.
- **The live test suite is read-only**, guarded in CI by `npm run check:live-readonly`.
- **Network-safe HTTP** — loopback default, bearer requirement for non-loopback, host/origin
  validation, secret-free `/healthz`.

Full threat model and deployment checklists: [`docs/mcp-security.md`](docs/mcp-security.md).

---

## Preview & apply workflow

Consequential writes are two steps, both in the SDK and (enforced) in the MCP server. Inventory
is shown here; pricing, listings, RMA and courtesy refunds follow the same shape
(`previewUpdate` / `previewCreate` / `previewSubmit` / `previewIssue`, then the matching write):

1. **Preview** — `inventory.previewUpdate(...)` (SDK) or `newegg_inventory_preview_update`
   (MCP) validates, deduplicates (last-write-wins), decides direct vs feed, and surfaces
   `zeroQuantityCount` and warnings. In the MCP server this returns a cryptographically
   random `previewId` bound to a hash of the normalized plan.
2. **Apply** — pass the reviewed plan to `inventory.updateMany(...)`, or call
   `newegg_inventory_apply_update` with only the `previewId`. The MCP apply step consumes the
   preview atomically (single use, replay-proof), rejects expired previews, and cannot change
   the previewed values.

This makes a model show its plan before anything mutates Newegg, and makes stale or replayed
approvals structurally impossible (ADR 0005).

---

## Direct vs feed strategy

`updateMany` takes `strategy: "direct" | "feed" | "auto"` (default `auto`):

- **`auto`** — after validation and dedup, ≤ `autoFeedThreshold` items (**default 8**, an SDK
  policy configurable via `NeweggClientConfig.strategy.autoFeedThreshold`) go out as direct
  updates with bounded concurrency; more go through feed(s). Items without a Seller Part
  Number fall back to direct.
- **`direct`** — one write per item, synchronous.
- **`feed`** — asynchronous bulk files (up to 10,000 records each); items lacking a Seller
  Part Number raise `NeweggValidationError` (nothing is silently dropped).

Details, dedup worked example, chunking math, and polling curves:
[`docs/inventory-strategies.md`](docs/inventory-strategies.md).

---

## Platform differences

One host, three marketplaces, many differences — including **the same US URL where `PUT`
reads and `POST` writes**, a `version=304` parameter on the B2B/CA single read, different
feed document versions (US `2.0` / B2B-CA `1.0`), and US multi-warehouse ISO codes vs B2B/CA
default-warehouse semantics. Full comparison table and per-platform wire snippets:
[`docs/platform-differences.md`](docs/platform-differences.md).

---

## Feed lifecycle

A submitted feed moves through:

```
SUBMITTED → IN_PROGRESS → FINISHED
                        ↘ CANCELLED
```

**Acceptance of a feed is not per-item success.** After `FINISHED`, fetch the processing
report (`feeds.getResult`) to see which records succeeded, warned, or failed. `waitForResult`
polls with bounded exponential backoff and returns a `finished`, `cancelled`, or `timeout`
outcome — a `timeout` preserves the `requestId` so you can resume later rather than losing
the work.

---

## Rate limits

Newegg meters per seller, per function, in one-minute windows, with extra hourly and
per-file limits on feeds:

| Operation               | Limit                |
| ----------------------- | -------------------- |
| Direct inventory writes | 10,000 requests/hour |
| Feed submissions        | 10 per minute        |
| Feed records            | 100,000 records/hour |
| Feed file size          | 10,000 records/file  |

Newegg's `X-RateLimit-*` and `X-RecordCount-*` headers are normalized into `RateLimitInfo`
on results; the SDK budgets feed submissions locally and raises `NeweggRateLimitError` (with
reset hints) on `429` / `DF012`.

---

## Error handling

Every failure is a `NeweggError` subclass carrying a stable `code`, a `retryable` flag, a
`correlationId`, and (when present) the upstream `neweggErrorCode`. The SDK parses Newegg's
inconsistent error bodies — JSON object, JSON array, XML, and plain text — into one shape,
and never leaks credentials into errors or logs. Direct operations retry safely on transient
failures; feed submissions never blindly retry after an ambiguous send (they raise
`IndeterminateFeedSubmissionError` with a recovery path). Full hierarchy and recipes:
[`docs/error-handling.md`](docs/error-handling.md).

---

## Testing

- **`npm test`** runs the unit and integration suites with **no credentials required**
  (`vitest run`). This is what CI runs.
- **Live smoke tests are opt-in and never run in CI.** They hit a real account. The suite is
  **read-only** (there is no live write test). It requires `NEWEGG_LIVE_TESTS=true` and valid
  platform credentials; inventory reads also need `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER` (and
  `NEWEGG_LIVE_TEST_WAREHOUSE` on US) and skip cleanly without them. Run with
  `NEWEGG_LIVE_TESTS=true npm run test:live`.
- **The live suite is guarded READ-ONLY.** `npm run check:live-readonly` (its own CI job)
  scans `packages/sdk/test/live/` and fails if a mutating call is ever added there, so the
  opt-in live suite is structurally prevented from writing to a real account. It is an
  allowlist, not just a denylist: comments are stripped before matching; the live files may
  import only `vitest`, `../../src/index.js`, `./helpers.js` and a few `node:` built-ins (never
  SDK internals); a namespace with write methods (`inventory`, `pricing`, `feeds`, `orders`,
  `listings`, `rma`, `refunds`) may only be used as `client.<namespace>.<documented read>(...)`
  (no aliasing, destructuring in any position, or naming a write method on any receiver);
  computed member access with a non-literal key, `Object.*` reflection and `Reflect` are
  banned; and every `NeweggClient` namespace and write-namespace method must be classified in
  `scripts/live-readonly-ast.ts`, so a new write surface fails the guard until it is. The
  guard's `MUST_FLAG` / `MUST_PASS` self-test runs on every invocation.

---

## Development

Root scripts (npm workspaces):

| Script                                    | Purpose                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                           | Build both packages (SDK, then MCP).                                                                                                     |
| `npm run typecheck`                       | `tsc --noEmit` across all workspaces.                                                                                                    |
| `npm run lint` / `npm run lint:fix`       | ESLint.                                                                                                                                  |
| `npm run format` / `npm run format:check` | Prettier write / check.                                                                                                                  |
| `npm test`                                | Unit + integration tests (no credentials).                                                                                               |
| `npm run test:coverage`                   | Tests with V8 coverage.                                                                                                                  |
| `npm run test:live`                       | Opt-in live smoke suite (see [Testing](#testing)).                                                                                       |
| `npm run docs:api`                        | Generate API docs with TypeDoc (`treatWarningsAsErrors`).                                                                                |
| `npm run verify:exports`                  | Verify built packages expose their expected exports (needs a build); also fails if an `examples/*` workspace lacks a `typecheck` script. |
| `npm run check:secrets`                   | Scan the **working tree** and fail if any credential/secret is present.                                                                  |
| `npm run check:live-readonly`             | Fail if the live suite gains a mutating call — keeps it READ-ONLY.                                                                       |
| `npm run check:deadcode`                  | knip: fail on unused files, exports, or dependencies.                                                                                    |
| `npm run pack:dry`                        | `npm pack --dry-run` for both packages; review tarball contents.                                                                         |

Each check is its own CI job (`.github/workflows/ci.yml`), so a failure points at exactly one
red box. The `scripts/` are TypeScript, typechecked via `tsconfig.scripts.json` and run with
`tsx` (no separate build step). Before claiming work done, run the full gate locally — every
command must exit `0`:

```bash
npm run format:check && npm run typecheck && npm run lint && npm run build \
  && npm test && npm run verify:exports && npm run check:secrets \
  && npm run check:live-readonly && npm run check:deadcode && npm run docs:api
```

---

## Publishing

Release the SDK before the MCP server, gated by `check:secrets`, `verify:exports`, and a
`pack:dry` review; provenance is added when publishing from CI. Full procedure — including
how to rename the `@devino` scope to your own — is in
[`docs/publishing.md`](docs/publishing.md).

---

## Current limitations

- **Narrow write surface, by design.** Inventory writes send quantity only; price writes send
  the selling price only (never MAP, MSRP, shipping or activation). The feed envelope
  `Overwrite` is hard-coded `"No"`. Listing creation targets existing Newegg items only.
- **Not every write path is live-verified.** Order, RMA, courtesy-refund, pricing and listing
  writes follow the official docs but have not all been sent to a real account.
- **Not implemented:** Void / Close RMA, Item Ranking, the China-only Tax Setting report, Get
  Warehouse List, Subcategory Status v1.1, SBN, shipping labels and ads.
- **Feed-status date filters are not implemented.** Feed status is queried by request ID
  only; Newegg's documented date-range filter field names did not render in extraction and
  were intentionally left out (see [`docs/platform-differences.md`](docs/platform-differences.md)).
- **Documented assumptions.** The item condition-code mapping (`1`=New … `6`=Used-Acceptable),
  the batch-read chunk size of 100 identifiers/request, and the treatment of all Newegg
  datetimes as Pacific Time are documented assumptions, each isolated behind a named module
  so a correction is a one-file change.

---

## License

[MIT](LICENSE).
