# ADR 0002 — Platform adapters for US / B2B / CA

**Status**: accepted · 2026-07-10

## Context

The three Newegg platforms differ in more than the base path: different read/write
endpoints, different HTTP methods on the _same_ URL (US international inventory:
PUT=read, POST=write), different feed request types and envelope versions
(US `INVENTORY_DATA` + DocumentVersion 2.0 vs B2B/CAN `INVENTORY_AND_PRICE_DATA` +
DocumentVersion 1.0 + envelope-level `Overwrite`), warehouse semantics (US multi-region
ISO codes vs B2B/CAN default warehouse), and a `version=304` query parameter on the
B2B/CAN single-item read. Docs are old; some shapes are only evidenced by samples.

## Decision

One `PlatformAdapter` per marketplace (`platform/us.ts`, `platform/b2b.ts`,
`platform/ca.ts`) behind a common interface that owns: base path, endpoint builders
(URL/method/query), request serializers (normalized types → exact wire JSON), response
normalizers (tolerant string/number coercion via zod), capability flags, and feed
envelope construction. Documented assumptions (condition-code mapping, batch-read chunk
size of 100) are isolated in named modules (`schemas/condition.ts`,
`inventory/constants.ts`) so a doc correction is a one-file change. URL building uses
`URL`/`URLSearchParams` exclusively; paths are lowercase constants; only the seller ID
value keeps its case. `baseUrl` override exists solely in trusted client config.

## Consequences

Marketplace differences are testable in isolation; unsupported operations throw
`UnsupportedMarketplaceOperationError` instead of guessing; assumptions are auditable.
