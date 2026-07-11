# MCP server security model

`@devino/newegg-marketplace-mcp` exposes Newegg inventory operations to language-model
clients. Those clients act on a **real seller account**, so the server is built on the
premise that tool descriptions and annotations are _hints, not security_ — every constraint
is enforced in handler code and transport configuration. This document states the threat
model, maps each threat to the concrete mechanism that mitigates it, lists what the server
will never do, and gives deployment checklists for both transports.

The write-safety design is ADR 0005; the SDK safety guarantees it builds on are in
`docs/research/sdk-public-api.md` and `error-handling.md`.

---

## Tools and resources exposed

Tools (underscore names, per MCP naming rules):

| Tool                              | Kind               | Notes                                                                                                                                         |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `newegg_inventory_get`            | read               | Current inventory for one or many identifiers.                                                                                                |
| `newegg_inventory_preview_update` | read-only planning | Validates, normalizes, dedups, chooses direct-vs-feed, surfaces zero-quantity counts and warnings, and returns a `previewId`. Writes nothing. |
| `newegg_inventory_apply_update`   | **write**          | Executes a stored preview by `previewId`. **Registered only when `NEWEGG_MCP_ALLOW_WRITES=true`.**                                            |
| `newegg_feed_status`              | read               | Feed status by request ID.                                                                                                                    |
| `newegg_feed_result`              | read               | Feed processing report by request ID.                                                                                                         |
| `newegg_service_status`           | read               | Newegg service-domain availability.                                                                                                           |

Resources:

- `newegg://capabilities` — what this server instance can do (marketplace, whether writes
  are enabled, active guard limits).
- `newegg://configuration/public` — the **non-secret** effective configuration.
- `newegg://feeds/{requestId}` — status/result view of a feed by request ID.

When writes are disabled (the default), `newegg_inventory_apply_update` is not registered and
never appears in `tools/list` — the deployment is read-only by construction, not by policy.

---

## Threat model

| #   | Threat                                | Scenario                                                                                                                                     |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **LLM-driven destructive write**      | A model is prompted (or manipulated via injected content) into zeroing stock or otherwise mutating inventory without human intent.           |
| T2  | **Catalog deactivation**              | An attacker tries to trigger `Overwrite: "Yes"` on a B2B/CA feed, which Newegg documents as deactivating every item not in the feed.         |
| T3  | **Replay / stale approval**           | A previously approved plan is applied twice, or an old approval is reused after circumstances changed.                                       |
| T4  | **Credential exfiltration**           | A model is coaxed into leaking the API key, secret key, seller ID, or base URL through tool arguments or output.                             |
| T5  | **Network exposure**                  | The HTTP transport is reachable from an untrusted network; DNS rebinding or a browser origin drives requests against a locally bound server. |
| T6  | **Upstream data leakage / injection** | Raw Newegg response bodies (or headers) cross the MCP boundary, leaking internal fields or smuggling content into the model.                 |

---

## Mitigations mapped to mechanisms

| Threat | Mechanism                         | How it works                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1     | **Registration-gating**           | The write tool is registered only when `NEWEGG_MCP_ALLOW_WRITES=true`; otherwise it is absent from `tools/list`. Default posture is read-only.                                                                                                                                  |
| T1     | **Preview → apply**               | Writes are two steps. `newegg_inventory_preview_update` produces a human-readable plan and a `previewId`; `newegg_inventory_apply_update` accepts _only_ a `previewId` and executes exactly the stored normalized operation. A human can read the plan before anything mutates. |
| T1     | **Quantities immutable at apply** | Apply cannot alter quantities, identifiers, or warehouses — it runs the stored plan verbatim.                                                                                                                                                                                   |
| T1     | **Guard limits (env)**            | `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION` (default 500), `NEWEGG_MCP_ALLOW_ZERO_QUANTITY` (default `true`), `NEWEGG_MCP_ALLOWED_WAREHOUSES`, `NEWEGG_MCP_ALLOWED_MARKETPLACES` — all enforced in handler code, not in tool descriptions.                                             |
| T2     | **`Overwrite` hard-coded `"No"`** | Callers cannot supply an `Overwrite` value; the SDK hard-codes `"No"` for B2B/CA feeds. Catalog-wide deactivation is unreachable through this codebase.                                                                                                                         |
| T3     | **TTL expiry**                    | Previews expire (default 600 s, `NEWEGG_MCP_PREVIEW_TTL_SECONDS`). A stale approval cannot be applied.                                                                                                                                                                          |
| T3     | **Single-use + replay-proof**     | Apply atomically **consumes** the preview; a second apply of the same `previewId` is rejected. The `previewId` is 256-bit (`crypto.randomBytes(32)`, base64url) and unguessable, and the stored plan carries a sha-256 of its canonical payload.                                |
| T4     | **No credentials via MCP**        | Tool callers can never supply credentials, base URLs, hostnames, or a `fetch` override. Credentials come only from the server's environment.                                                                                                                                    |
| T4     | **Redaction in the SDK**          | Credential values never appear in errors, logs, `raw`, or serialized output (`error-handling.md`).                                                                                                                                                                              |
| T5     | **Loopback default**              | The HTTP transport binds `127.0.0.1:3919` by default and **refuses to bind a non-loopback host unless `NEWEGG_MCP_HTTP_BEARER_TOKEN` is set.**                                                                                                                                  |
| T5     | **Bearer auth**                   | When set, `NEWEGG_MCP_HTTP_BEARER_TOKEN` is required on requests to the HTTP endpoint.                                                                                                                                                                                          |
| T5     | **Host + origin validation**      | `NEWEGG_MCP_HTTP_ALLOWED_HOSTS` validates the `Host` header (loopback hosts always allowed) and `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS` validates `Origin` — defenses against DNS rebinding and hostile browser origins. **CORS is never treated as authentication.**                 |
| T5     | **`/healthz` reveals no secrets** | The liveness endpoint returns no configuration or credential material.                                                                                                                                                                                                          |
| T6     | **Structured errors only**        | Raw upstream Newegg bodies are never returned through MCP; only structured, sanitized error/result shapes cross the boundary.                                                                                                                                                   |
| T6     | **stdout discipline (stdio)**     | On the stdio transport, logs go strictly to **stderr**; stdout is reserved for JSON-RPC frames, so nothing can corrupt or inject into the protocol stream.                                                                                                                      |

---

## What the server will never do

- Never accept credentials, base URLs, hostnames, or a `fetch`/transport override from a
  tool caller.
- Never send `Overwrite: "Yes"` — it is hard-coded `"No"` for B2B/CA feeds.
- Never write to SBN (Shipped-by-Newegg) inventory.
- Never return raw upstream Newegg response bodies or response headers.
- Never change quantities, identifiers, or warehouses between preview and apply.
- Never register `newegg_inventory_apply_update` unless `NEWEGG_MCP_ALLOW_WRITES=true`.
- Never apply an expired, consumed, or unknown `previewId`.
- Never write logs to stdout on the stdio transport.
- Never bind a non-loopback interface without a bearer token.
- Never expose secrets through `/healthz` or error messages.

---

## MCP protocol version

This server targets the **stable v1 line of `@modelcontextprotocol/sdk` (`^1.29.0`)**,
implementing MCP spec revision **2025-11-25**. A v2 SDK exists only as a beta and is
deliberately **not** used. Per ADR 0001, all code that touches `@modelcontextprotocol/sdk`
types is isolated in `packages/mcp-server/src/server/` (registration + transports) while
tool _logic_ lives in `packages/mcp-server/src/tools/` as plain functions, so a future v2
migration is scoped to the `server/` layer and does not touch tool behaviour or the SDK.

---

## Deployment checklist — stdio

Stdio is the default transport (a subprocess launched by the MCP client).

- [ ] Provide credentials in the process environment: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`,
      `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`. Remember credentials are platform-specific.
- [ ] Leave `NEWEGG_MCP_ALLOW_WRITES=false` unless you intend writes; set it to `true` only
      for deployments that must mutate inventory.
- [ ] Set guard limits appropriate to the account: `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION`,
      `NEWEGG_MCP_ALLOW_ZERO_QUANTITY`, `NEWEGG_MCP_ALLOWED_WAREHOUSES`,
      `NEWEGG_MCP_ALLOWED_MARKETPLACES`.
- [ ] Ensure nothing else in the process writes to **stdout** (the JSON-RPC channel); your
      own logging must go to stderr.
- [ ] Understand that previews live in an in-memory `PreviewStore` — fine for a single
      stdio process, since the same process both previews and applies.

## Deployment checklist — Streamable HTTP

- [ ] Keep the default bind `127.0.0.1:3919` unless remote access is genuinely required.
- [ ] To bind a non-loopback host, you **must** set `NEWEGG_MCP_HTTP_BEARER_TOKEN`; the
      server refuses to bind otherwise. Use a high-entropy token and rotate it.
- [ ] Set `NEWEGG_MCP_HTTP_ALLOWED_HOSTS` (expected `Host` header values) and
      `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS` (expected browser `Origin`s). Do not rely on CORS
      for authentication.
- [ ] Terminate TLS at a trusted reverse proxy and keep the server's own bind private.
- [ ] MCP requests are served at `POST /mcp` (Streamable HTTP; the session id is returned in
      the `Mcp-Session-Id` response header). On `/mcp` the guards run in order: `Origin`
      allowlist → `Host` allowlist → bearer token. Any other path returns `404`.
- [ ] Probe liveness at `GET /healthz` (unauthenticated; returns no secrets).
- [ ] **Multi-instance:** the in-memory `PreviewStore` is per-process, so a preview created
      on instance A cannot be applied on instance B (apply would see an unknown `previewId`).
      Behind a load balancer, provide a shared `PreviewStore` implementing `get` / `put` /
      `consume` with TTL, backed by Redis or a database (interface documented in ADR 0005).
      For the same reason, share the SDK's `OperationStore` and `RateLimitStore` across
      instances so feed dedup and rate budgets remain correct.
