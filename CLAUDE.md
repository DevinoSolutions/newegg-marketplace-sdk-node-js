# CLAUDE.md — agent instructions for this repo

TypeScript monorepo: `packages/sdk` (`@devino/newegg-marketplace-sdk`) + `packages/mcp-server`
(`@devino/newegg-marketplace-mcp`), npm workspaces, ESM/NodeNext, Node >= 22.12.

## Hard rules (safety — never break these)

1. **The live test suite is READ-ONLY.** Files in `packages/sdk/test/live/` hit the REAL
   Newegg seller account. Never add a mutating call (`updateItem`, `updateMany`,
   `submitInventoryFeed`, any `submitfeed` endpoint, any raw POST). Enforced by
   `npm run check:live-readonly` in CI — do not weaken that guard; extend it when the
   mutating surface grows (e.g. order ship/cancel, RMA, price updates).
2. **Never perform ANY write against the real Newegg account** (SDK call, curl, probe
   script, MCP tool) without the owner explicitly authorizing that specific write in the
   current session. Reads (service status, inventory get, order-info get) are fine.
3. **Secrets never leave `.env`.** Never print, log, commit, or hardcode credentials or
   values derived from them (real SKUs/order numbers discovered live stay out of the repo
   too). Enforced by `npm run check:secrets` (scans the WORKING TREE — keep it that way).
4. **Feed envelope `Overwrite` is hard-coded `"No"`** (`packages/sdk/src/platform/feed-envelope.ts`).
   `"Yes"` deactivates every listing not in the feed. Never expose it as an option.
5. **MCP write tools register only when `NEWEGG_MCP_ALLOW_WRITES=true`**, and writes go
   through the preview→apply flow (ADR 0005). New mutating tools follow the same gate.

## Binding contracts

- `docs/research/sdk-public-api.md` — the SDK's public surface (MCP consumes only this).
- `docs/research/newegg-api-contracts.md` — verified wire shapes; when adding endpoints,
  extend it from the official docs (cite page URL + date; mark gaps **ASSUMPTION**).
- ADRs in `docs/adr/` — platform adapters (0002), direct-vs-feed (0003), indeterminate
  submissions (0004), preview/apply (0005). Follow them; don't inline per-marketplace
  `if`s in API layers — that logic belongs in `packages/sdk/src/platform/`.

## Toolchain pins (do not upgrade without owner sign-off)

TypeScript `~6.0.3` · zod `^4` (zod-4 API — most online examples are zod-3) ·
`@modelcontextprotocol/sdk` `^1.29` · vitest `^4` · ESLint flat config.

## Conventions

- Strict TS everywhere (`noUncheckedIndexedAccess` — index access yields `T | undefined`).
- `any` is banned (`@typescript-eslint/no-explicit-any: error`); use `unknown` + narrowing.
- Relative imports in `src/` carry `.js` extensions (ESM NodeNext).
- No `console.*` in `packages/*/src` except `console.error` (stdout belongs to the MCP
  stdio transport). Tests/scripts/examples may log.
- Newegg wire quirks are the norm, not the exception: numbers arrive as strings,
  booleans as `"0"`/`"1"`/`"true"`, any list may be object-OR-array, datetimes are
  Pacific Time without offsets, error bodies may be JSON object, JSON array, XML, or
  plain text. Reuse `platform/dates.ts`, `schemas/wire.ts`, `errors/parse-upstream.ts` —
  never hand-roll parsing.
- HTTP verbs don't imply safety here: order-info is a READ via PUT; the US inventory URL
  is read-on-PUT / write-on-POST. Classify operations by the contracts doc, not the verb.

## Commands

```bash
npm run build            # sdk then mcp-server (tsc)
npm run typecheck        # scripts + all workspaces
npm run lint / format:check
npm test                 # mocked suites only (154+); no credentials needed
npm run check:secrets    # working-tree secret scan
npm run check:live-readonly
npm run verify:exports   # requires a fresh build
NEWEGG_LIVE_TESTS=true npm run test:live   # READ-ONLY live suite (needs .env creds)
```

All of these must exit 0 before claiming work is done. Trust exit codes, not output
prettiness (an output proxy may collapse vitest output to `PASS (n) FAIL (n)`).

## Environment gotchas (primary dev machine: Windows + OneDrive)

- OneDrive can silently roll `dist/` back to stale artifacts and once injected NUL bytes
  into a source file. After `npm run build`, confirm dist mtimes are newer than src
  before trusting dist-dependent checks; bizarre `tsc` parse errors at 1:1 → check for
  NUL bytes.
- Long commands: prefer the Bash tool. A killed long-running command can wedge the
  PowerShell tool session (every later command times out) — switch backends, don't retry.
- The repo may have few/no commits; `check:secrets` deliberately scans the working tree
  so it stays honest either way.
