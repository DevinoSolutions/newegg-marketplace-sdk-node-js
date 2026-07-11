# ADR 0001 — Core SDK / MCP server separation

**Status**: accepted · 2026-07-10

## Context

We ship both a reusable Newegg Marketplace SDK and an MCP server exposing it. MCP SDK
v1.x is stable today (`@modelcontextprotocol/sdk@1.29.0`); v2 exists only as a beta and
must not be used. A future v2 migration must not ripple into the Newegg SDK.

## Decision

- npm workspaces monorepo. `@devino/newegg-marketplace-sdk` is transport-independent:
  its only runtime dependency is `zod`; it never imports MCP code, never reads env vars,
  never performs I/O at import time.
- `@devino/newegg-marketplace-mcp` depends on the SDK's public surface only
  (`docs/research/sdk-public-api.md` is the binding contract).
- Everything that touches `@modelcontextprotocol/sdk` types lives in
  `packages/mcp-server/src/server/` (registration, transports) — tool _logic_ lives in
  `packages/mcp-server/src/tools/` as plain functions returning plain data, so an MCP v2
  migration replaces only the `server/` layer.

## Consequences

Tool handlers are unit-testable without an MCP client; the SDK can be consumed by any
runtime (queues, cron, HTTP services) with zero MCP baggage; MCP v2 migration is scoped
to one directory.
