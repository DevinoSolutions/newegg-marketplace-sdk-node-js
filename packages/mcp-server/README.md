# @devino/newegg-marketplace-mcp

A Model Context Protocol (MCP) server exposing safe, narrowly-scoped Newegg Marketplace
inventory tools over **stdio** and **Streamable HTTP**. Built on
[`@devino/newegg-marketplace-sdk`](../sdk/README.md), it is designed for language-model callers acting
on a real seller account: tool descriptions are treated as hints, not security, and every
constraint is enforced in handler code.

- **Read-only by default.** The mutating apply tool is registered only when
  `NEWEGG_MCP_ALLOW_WRITES=true`.
- **Preview → apply writes.** A model must produce a reviewable plan and a single-use,
  TTL-bounded `previewId`; apply cannot change quantities.
- **No credentials via MCP.** Callers can never supply credentials, base URLs, hostnames, or
  `Overwrite` values; raw upstream Newegg bodies never cross the boundary.

> The `@devino` scope is a placeholder chosen to be easy to find-and-replace before publishing.

## Requirements

- Node.js >= 22.12.0, ESM only.
- Targets the stable MCP SDK line (`@modelcontextprotocol/sdk@^1.29.0`), spec revision
  2025-11-25. The v2 SDK (beta) is deliberately not used.

## Installation

```bash
npm install @devino/newegg-marketplace-mcp
# or run without installing:
npx -y @devino/newegg-marketplace-mcp
```

## Running

### stdio (default)

The MCP client launches the server as a subprocess. Example client configuration:

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

Replace the `${...}` placeholders with real values (or inject them via your client's secret
mechanism) — never commit real credentials. On stdio the server logs strictly to **stderr**;
stdout carries only the JSON-RPC protocol.

### Streamable HTTP

```bash
newegg-marketplace-mcp --transport http
```

- Binds `127.0.0.1:3919` by default and **refuses to bind a non-loopback host unless
  `NEWEGG_MCP_HTTP_BEARER_TOKEN` is set**.
- MCP requests are served at **`POST /mcp`** (Streamable HTTP; the session id is returned in
  the `Mcp-Session-Id` response header and must be echoed on subsequent `GET`/`DELETE`).
- Guards run in order on `/mcp`: `Origin` allowlist → `Host` allowlist → bearer token. CORS is
  never treated as authentication.
- `GET /healthz` is an unauthenticated liveness probe that reveals no secrets:

```bash
curl -s http://127.0.0.1:3919/healthz
# {"status":"ok","server":"newegg-marketplace-mcp","version":"0.1.0"}
```

## Tools

Underscore names, per MCP naming rules. All reads are annotated `readOnlyHint: true`.

| Tool                              | Input                                                                                                        | Notes                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newegg_inventory_get`            | `{ identifiers: Identifier[] (1–100), warehouses?: string[] }`                                               | Read current inventory. `warehouses` is a US-only filter.                                                                                                                 |
| `newegg_inventory_preview_update` | `{ updates: Update[] (1–maxItems), strategy?: "direct"\|"feed"\|"auto", includeCurrentInventory?: boolean }` | Read-only. Validates, enforces server policies, dedups, plans direct-vs-feed, and returns a `previewId`. No write.                                                        |
| `newegg_inventory_apply_update`   | `{ previewId: string }`                                                                                      | **Write.** Registered only when `NEWEGG_MCP_ALLOW_WRITES=true`. Consumes the preview atomically (single-use, replay/expiry rejected); quantities cannot be supplied here. |
| `newegg_feed_status`              | `{ requestId: string (1–64, alphanumeric) }`                                                                 | Poll a submitted feed's status.                                                                                                                                           |
| `newegg_feed_result`              | `{ requestId: string (1–64, alphanumeric) }`                                                                 | Per-record processing report for a FINISHED feed; at most 500 records (`recordsTruncated` flags the cap).                                                                 |
| `newegg_service_status`           | `{ domain?: ServiceDomain }`                                                                                 | Newegg service availability; defaults to `contentmgmt`.                                                                                                                   |

Where:

- **`Identifier`** = `{ type: "sellerPartNumber" | "neweggItemNumber" | "upc"; value: string (1–64); condition?: Condition }`.
- **`Update`** = `{ identifier: Identifier; quantity: integer >= 0; warehouseLocation?: string; fulfillmentOption?: "Seller" }`.
- **`Condition`** ∈ `new | refurbished | usedLikeNew | usedVeryGood | usedGood | usedAcceptable`.
- **`ServiceDomain`** ∈ `contentmgmt | ordermgmt | datafeedmgmt | servicemgmt | reportmgmt | sellermgmt | sbnmgmt | shippingservice`.

The preview `updates` array is bound to `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION` (default 500) at
registration time via a Zod `.max(...)`, so an oversized request is rejected by the tool's own
input schema.

**Preview semantics.** The stored preview records the **requested** strategy (`direct` |
`feed` | `auto`) so apply replays exactly what was planned, while the preview's returned
`strategy` field is the SDK's **resolved** decision (`direct` | `feed` | `mixed`).
`includeCurrentInventory` is accepted and forwarded to the SDK (reads only, never a write) but
is not surfaced in the tool's output.

## Resources

- `newegg://capabilities` — server identity, registered tools, marketplace, configured limits.
- `newegg://configuration/public` — non-sensitive effective configuration and Newegg limits.
- `newegg://feeds/{requestId}` — feed status for a request id (same payload as `newegg_feed_status`).

## Environment variables

| Variable                             | Default                  | Meaning                                                                                                              |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `NEWEGG_SELLER_ID`                   | — (required)             | Seller ID.                                                                                                           |
| `NEWEGG_API_KEY`                     | — (required)             | API key (`Authorization` header).                                                                                    |
| `NEWEGG_SECRET_KEY`                  | — (required)             | Secret key (`SecretKey` header).                                                                                     |
| `NEWEGG_MARKETPLACE`                 | `us`                     | `us` \| `b2b` \| `ca`. Credentials are platform-specific.                                                            |
| `NEWEGG_MCP_ALLOW_WRITES`            | `false`                  | Registers `newegg_inventory_apply_update` when `true`.                                                               |
| `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION` | `500`                    | Max items per preview/apply.                                                                                         |
| `NEWEGG_MCP_PREVIEW_TTL_SECONDS`     | `600`                    | Preview lifetime before expiry.                                                                                      |
| `NEWEGG_MCP_ALLOW_ZERO_QUANTITY`     | `true`                   | Allow quantity `0` (out-of-stock) writes.                                                                            |
| `NEWEGG_MCP_ALLOWED_WAREHOUSES`      | empty = all              | Comma-separated warehouse allowlist.                                                                                 |
| `NEWEGG_MCP_ALLOWED_MARKETPLACES`    | empty = all              | Comma-separated marketplace allowlist. If set, `NEWEGG_MARKETPLACE` must be included or the server refuses to start. |
| `NEWEGG_MCP_HTTP_HOST`               | `127.0.0.1`              | HTTP bind host.                                                                                                      |
| `NEWEGG_MCP_HTTP_PORT`               | `3919`                   | HTTP bind port.                                                                                                      |
| `NEWEGG_MCP_HTTP_BEARER_TOKEN`       | empty                    | Bearer token; required to bind a non-loopback host.                                                                  |
| `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS`    | empty = same-origin only | Comma-separated allowed `Origin` values.                                                                             |
| `NEWEGG_MCP_HTTP_ALLOWED_HOSTS`      | empty                    | Comma-separated allowed `Host` values; loopback always allowed.                                                      |

## Security

Full threat model, mitigations, and deployment checklists (including the multi-instance
`PreviewStore` note for Redis/DB backing) are in the repository at `docs/mcp-security.md`.

## License

[MIT](../../LICENSE)
