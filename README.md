# Newegg Marketplace SDK + MCP server

A TypeScript monorepo providing a transport-independent **Newegg Marketplace SDK** and a
narrowly-scoped **Model Context Protocol (MCP) server** on top of it, with first-class,
safety-first inventory management across Newegg's US, B2B, and Canada marketplaces.

- **`@devino/newegg-marketplace-sdk`** — the SDK. One runtime dependency (`zod`), no MCP
  baggage, no I/O at import time. Usable from queues, cron jobs, HTTP services, or the CLI.
- **`@devino/newegg-marketplace-mcp`** — an MCP server exposing safe inventory tools over
  stdio and Streamable HTTP, with writes gated behind a preview → apply flow.

> The `@devino` scope is a placeholder chosen to be easy to find-and-replace. See
> [`docs/publishing.md`](docs/publishing.md#rename-the-devino-scope) to rename it.

## Contents

- [What's in here](#whats-in-here)
- [Requirements](#requirements)
- [Installation](#installation)
- [SDK quick start](#sdk-quick-start)
- [Reading inventory](#reading-inventory)
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
│  ├─ sdk-basic/            read + preview with the SDK
│  ├─ sdk-batch-inventory/  batch updates, dedup, feed chunking
│  ├─ mcp-stdio/            MCP client over stdio
│  └─ mcp-http/             MCP client over Streamable HTTP
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

Writes are **disabled by default** — the apply tool is not even registered unless
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
**platform-specific**: a US key is not valid for B2B or CA.

### SDK / credentials

| Variable              | Default           | Meaning                                                                                                        |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `NEWEGG_SELLER_ID`    | — (required)      | Seller ID; sent as the `?sellerid=` query parameter.                                                           |
| `NEWEGG_API_KEY`      | — (required)      | API key; sent as the `Authorization` header value.                                                             |
| `NEWEGG_SECRET_KEY`   | — (required)      | Secret key; sent as the `SecretKey` header value.                                                              |
| `NEWEGG_MARKETPLACE`  | `us`              | Platform: `us` \| `b2b` \| `ca`.                                                                               |
| `NEWEGG_API_BASE_URL` | official endpoint | Trusted override for tests/proxies. Defaults to `https://api.newegg.com/marketplace/`. Never settable via MCP. |

### MCP server

| Variable                             | Default                  | Meaning                                                                                                       |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `NEWEGG_MCP_ALLOW_WRITES`            | `false`                  | When `true`, registers `newegg_inventory_apply_update`. Otherwise the write tool is absent from `tools/list`. |
| `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION` | `500`                    | Hard cap on items per preview/apply.                                                                          |
| `NEWEGG_MCP_PREVIEW_TTL_SECONDS`     | `600`                    | Lifetime of a stored preview before it expires.                                                               |
| `NEWEGG_MCP_ALLOW_ZERO_QUANTITY`     | `true`                   | Whether quantity `0` (out-of-stock) writes are allowed.                                                       |
| `NEWEGG_MCP_ALLOWED_WAREHOUSES`      | empty = all              | Comma-separated warehouse allowlist.                                                                          |
| `NEWEGG_MCP_ALLOWED_MARKETPLACES`    | empty = all              | Comma-separated marketplace allowlist.                                                                        |
| `NEWEGG_MCP_HTTP_HOST`               | `127.0.0.1`              | HTTP transport bind host.                                                                                     |
| `NEWEGG_MCP_HTTP_PORT`               | `3919`                   | HTTP transport bind port.                                                                                     |
| `NEWEGG_MCP_HTTP_BEARER_TOKEN`       | empty                    | Bearer token; **required** before binding a non-loopback host.                                                |
| `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS`    | empty = same-origin only | Comma-separated allowed browser `Origin` values.                                                              |
| `NEWEGG_MCP_HTTP_ALLOWED_HOSTS`      | empty                    | Comma-separated allowed `Host` values (`host[:port]`); loopback always allowed.                               |

### Live tests (opt-in; never in CI)

| Variable                                                     | Default | Meaning                                            |
| ------------------------------------------------------------ | ------- | -------------------------------------------------- |
| `NEWEGG_LIVE_TESTS`                                          | `false` | Master switch for the live smoke suite.            |
| `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER`                        | empty   | A dedicated **test** listing's Seller Part Number. |
| `NEWEGG_LIVE_TEST_WAREHOUSE`                                 | empty   | Warehouse/location for the live test.              |
| `NEWEGG_LIVE_TESTS_I_UNDERSTAND_THIS_TOUCHES_A_REAL_ACCOUNT` | empty   | Must equal `yes` to arm the live suite.            |

---

## Security model

The MCP server assumes tool descriptions are hints, not security, and enforces every
constraint in code:

- **Read-only by default.** The write tool is registered only when
  `NEWEGG_MCP_ALLOW_WRITES=true`.
- **Preview → apply.** Writes require a two-step flow; apply takes only a single-use,
  TTL-bounded `previewId` and cannot alter quantities.
- **No credentials via MCP.** Callers can never supply credentials, base URLs, hostnames, or
  `Overwrite` values; raw upstream bodies never cross the MCP boundary.
- **`Overwrite: "Yes"` is impossible** — hard-coded `"No"` for B2B/CA feeds, so catalog-wide
  deactivation is unreachable.
- **Network-safe HTTP** — loopback default, bearer requirement for non-loopback, host/origin
  validation, secret-free `/healthz`.

Full threat model and deployment checklists: [`docs/mcp-security.md`](docs/mcp-security.md).

---

## Preview & apply workflow

Consequential writes are two steps, both in the SDK and (enforced) in the MCP server:

1. **Preview** — `inventory.previewUpdate(...)` (SDK) or `newegg_inventory_preview_update`
   (MCP) validates, deduplicates (last-write-wins), decides direct vs feed, and surfaces
   `zeroQuantityCount` and warnings. In the MCP server this returns a cryptographically
   random `previewId` bound to a hash of the normalized plan.
2. **Apply** — pass the reviewed plan to `inventory.updateMany(...)`, or call
   `newegg_inventory_apply_update` with only the `previewId`. The MCP apply step consumes the
   preview atomically (single use, replay-proof), rejects expired previews, and cannot change
   quantities.

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
- **Live smoke tests are opt-in and never run in CI.** They hit a real account. Read tests
  require `NEWEGG_LIVE_TESTS=true`, valid platform credentials,
  `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER`, and `NEWEGG_LIVE_TEST_WAREHOUSE`; the mutating write
  test additionally requires `NEWEGG_LIVE_TESTS_I_UNDERSTAND_THIS_TOUCHES_A_REAL_ACCOUNT`
  set to exactly `yes`. Run them with `npm run test:live`, and **use a dedicated test
  listing, not a production SKU.**
- **The live suite is guarded READ-ONLY.** `npm run check:live-readonly` (its own CI job)
  scans `packages/sdk/test/live/` and fails if a mutating call is ever added there, so the
  opt-in live suite is structurally prevented from writing to a real account.

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

- **Inventory only, by design.** No price, MAP, shipping, or activation fields are ever
  written. On B2B/CA the "Inventory and Price" endpoints and feeds are used with an
  inventory-only body, and the feed envelope `Overwrite` is hard-coded `"No"`.
- **Feed-status date filters are not implemented.** Feed status is queried by request ID
  only; Newegg's documented date-range filter field names did not render in extraction and
  were intentionally left out (see [`docs/platform-differences.md`](docs/platform-differences.md)).
- **Documented assumptions.** The item condition-code mapping (`1`=New … `6`=Used-Acceptable),
  the batch-read chunk size of 100 identifiers/request, and the treatment of all Newegg
  datetimes as Pacific Time are documented assumptions, each isolated behind a named module
  so a correction is a one-file change.
- **Live credential acceptance is unverified.** Endpoints and header format are verified
  against Newegg's official docs, but read-only probes on 2026-07-10 returned
  `HTTP 401 Gateway: Seller Auth failed.` on all platforms with the credentials available at
  the time (see `docs/research/newegg-api-contracts.md` §9).

---

## License

[MIT](LICENSE).
