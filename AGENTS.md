# AGENTS.md

Full agent instructions live in **[CLAUDE.md](./CLAUDE.md)** — read it before changing code.

Non-negotiables (duplicated here so no tool misses them):

1. `packages/sdk/test/live/` is READ-ONLY against a REAL seller account — never add
   writes there (`npm run check:live-readonly` enforces this in CI).
2. Never write to the real Newegg account in any form without the owner explicitly
   authorizing that specific write in the current session.
3. Never print/commit credentials or live-discovered identifiers; `npm run check:secrets`
   scans the working tree and must stay that way.
4. Feed envelope `Overwrite` stays hard-coded `"No"`.
5. MCP write tools stay gated behind `NEWEGG_MCP_ALLOW_WRITES=true` + preview→apply.

Before claiming done: `npm run format:check && npm run typecheck && npm run lint &&
npm run build && npm test && npm run verify:exports && npm run check:secrets &&
npm run check:live-readonly` — all exit 0.
