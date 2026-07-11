# ADR 0005 — MCP write safety: preview → apply

**Status**: accepted · 2026-07-10

## Context

MCP tools are invoked by language models against a real seller account. Inventory writes
(especially zero-quantity) are impactful; `Overwrite: Yes` on B2B/CAN feeds can
deactivate a whole catalog. Tool descriptions and annotations are hints, not security.

## Decision

- Writes are a **two-step** flow: `newegg_inventory_preview_update` validates,
  normalizes, dedups, decides direct-vs-feed, surfaces zero-quantity counts and warnings,
  and stores the normalized operation under a cryptographically random `previewId`
  (256-bit, `crypto.randomBytes(32)` base64url) together with a sha-256 hash of the
  canonical payload and an expiry (default 600 s, `NEWEGG_MCP_PREVIEW_TTL_SECONDS`).
- `newegg_inventory_apply_update` accepts only a `previewId`: it executes **exactly** the
  stored normalized operation (quantities cannot be altered at apply time), atomically
  consumes the preview (single use; replay rejected), rejects expired previews, and
  records the outcome.
- The apply tool is **registered only when `NEWEGG_MCP_ALLOW_WRITES=true`** (omitted
  otherwise, so it never appears in `tools/list`). Additional guards:
  `NEWEGG_MCP_MAX_ITEMS_PER_OPERATION` (enforced **declaratively** — the preview tool's
  `updates` array carries `.max(maxItemsPerOperation)`, default 500, so an oversized request
  is rejected by the input schema itself), `NEWEGG_MCP_ALLOW_ZERO_QUANTITY`,
  `NEWEGG_MCP_ALLOWED_WAREHOUSES`, `NEWEGG_MCP_ALLOWED_MARKETPLACES` — enforced in handler
  code (or, for max-items, the schema), not in descriptions.
- The stored preview records the **requested** strategy (`direct` | `feed` | `auto`) so apply
  replays exactly what was planned; the preview's **output** reports the SDK's **resolved**
  decision (`direct` | `feed` | `mixed`). `includeCurrentInventory` is accepted and forwarded
  to the SDK (reads only, still zero writes) but is not surfaced in the tool output.
- `PreviewStore` is an interface; in-memory implementation ships for stdio/dev, and the
  interface (get/put/consume with TTL) is documented for Redis/DB in multi-instance
  deployments.
- MCP callers can never supply credentials, base URLs, hostnames, or `Overwrite` values.
  Raw upstream bodies are never returned through MCP.

## Consequences

A model must show its plan (and the human can read it) before anything mutates Newegg;
replays and stale approvals are structurally impossible; read-only deployments are the
default posture.
