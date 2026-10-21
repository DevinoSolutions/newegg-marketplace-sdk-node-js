# ADR 0006 — Credential/marketplace binding

**Status**: accepted · 2026-10-21 · supersedes the "a US key is not valid on `/b2b/` or `/can/`" claim

## Context

Live read-only probes (T-5911; evidence: private evidence repo commit `1346a9fa`, folder T-5906)
showed that Newegg's gateway authenticates on `sellerid` + API key + secret key only. The URL prefix
(none / `b2b/` / `can/`) changes the request schema and response shape but is never checked against
the key: the data is always the account the key resolves to. With the account's one key pair (issued
under the Newegg.ca tab) every read on `us` and `b2b` returned the CA account's own data (the same
30 CAD orders, the same RMAs) labelled with the other marketplace, and no error. A write path would
have hit the CA account the same way. Only a few catalog-bound routes (batch inventory, volume
discount, B2B price) react to the prefix; the response carries no marketplace signal except the order
currency.

## Decision

- **Primary, fail-closed: bind credentials to a marketplace.** `NeweggClientConfig.credentialMarketplace`
  names the marketplace the key pair was issued under. `createNeweggClient` throws
  `NeweggMarketplaceMismatchError` (a `NeweggConfigurationError`, `code: "configuration"`, no new code,
  names only, no credential values) when it differs from `marketplace`, before any request. The field is
  optional so existing SDK callers keep working, but omitting it keeps the unsafe behaviour (documented
  in the JSDoc, README and `sdk-public-api.md`).
- **MCP server never guesses.** `loadMcpConfigFromEnv` resolves credentials for the selected
  `NEWEGG_MARKETPLACE` only: the complete `NEWEGG_<MP>_{SELLER_ID,API_KEY,SECRET_KEY}` set when any of
  the three is set (all three then required, one aggregated error), otherwise the legacy unprefixed
  variables are accepted only with `NEWEGG_CREDENTIALS_MARKETPLACE` equal to `NEWEGG_MARKETPLACE`. It
  never falls back to another marketplace's set and always passes `credentialMarketplace` to the SDK.
  This breaks existing setups (version 0.1.0, acceptable).
- **Defense in depth, owned by the platform adapter (ADR 0002).** `PlatformAdapter.expectedOrderCurrencies`
  (ca: CAD; us and b2b: USD, an ASSUMPTION until a real US/Business key exists) feeds
  `platform/order-currency.ts`, which `orders.list` (and so `get`/`tryGet`) calls after parsing. It throws
  `NeweggMarketplaceMismatchError` only when a non-empty page has a defined currency on every order and none
  is expected; empty, mixed and currency-less pages pass. The error holds no order numbers. US price lists are
  not guarded (per-destination CAD/CAN is legitimate there). API layers carry no per-marketplace `if`s.
- The guard cannot cover inventory, RMA, seller status, report status or ads (no marketplace signal), which
  is why binding at construction is the primary control and the currency guard only a backstop for clients
  built without `credentialMarketplace`.

## Consequences

A key pair can no longer be pointed at the wrong marketplace by accident through the MCP server, nor
through the SDK when `credentialMarketplace` is supplied. Deployments with the unprefixed variables must
add `NEWEGG_CREDENTIALS_MARKETPLACE` (or switch to the prefixed names). The live test suite is bound too:
us/b2b live tests skip as a whole (no us/b2b credentials) instead of reading the CA account under the wrong
label. **Unproven** until real Newegg.com / Business keys exist: that a US key on `/` returns USD orders,
that Business orders are USD, the reverse direction (a US key on `/can/`), and `IsInternal` semantics.
