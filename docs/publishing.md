# Publishing

How to release `@joinmarka/newegg` and `@joinmarka/newegg-mcp` to npm,
the versioning policy, and the pre-publish verification gates.

Both packages declare `"publishConfig": { "access": "public", "provenance": true }`, so scoped
public publication with provenance works out of the box.

---

## Package names

The packages are published under the `@joinmarka` npm organization:

| Workspace             | npm package             |
| --------------------- | ----------------------- |
| `packages/sdk`        | `@joinmarka/newegg`     |
| `packages/mcp-server` | `@joinmarka/newegg-mcp` |

The MCP server depends on the SDK by name with a real semver range (`^0.1.0`), so it installs
from npm. Keep both names in the same scope.

Pushing a `v*` tag runs `.github/workflows/release.yml`: it checks the tag against the SDK
version, runs the full gate, then publishes the SDK and the MCP server (SDK first), each skipped
independently if that version is already on npm.

---

## Versioning policy

- **Semantic versioning.** Both packages start at `0.1.0`.
- The SDK's **public API contract** is `docs/research/sdk-public-api.md`. A breaking change
  to that surface is a **major** bump; additive, backward-compatible changes are **minor**;
  fixes are **patch**. During `0.x`, treat minor bumps as potentially breaking per the semver
  `0.y.z` convention, and say so in release notes.
- The MCP server depends on the SDK via a caret range (`"@joinmarka/newegg":
"^0.1.0"`). Bump that range whenever you rely on a newly added SDK feature, and prefer
  releasing the two packages **in lockstep** so a given MCP version has a known-good SDK.
- Node engine support is `>=22.12.0`; CI validates on Node 22.x and 24.x
  (`.github/workflows/ci.yml`). Dropping a Node line is a breaking change.

---

## Pre-publish verification

Run the full gate from a clean checkout. These are the same checks CI runs, plus the
publish-specific `pack:dry`:

```bash
npm ci                    # clean, locked install
npm run check:secrets     # no credentials committed (see below)
npm run build             # tsc build of both packages
npm run typecheck         # tsc --noEmit across workspaces
npm run lint              # eslint
npm run format:check      # prettier --check
npm run test:coverage     # vitest with coverage (no credentials needed)
npm run verify:exports    # built entry points expose expected exports
npm run pack:dry          # inspect the tarball file lists
```

- **`check:secrets`** (`scripts/check-secrets.mjs`) fails the release if `.gitignore` does
  not exclude `.env`, if any value from a local `.env` appears in a tracked file, or if a
  credential-shaped value sits next to an `Authorization`/`SecretKey`/`NEWEGG_API_KEY`
  (or `NEWEGG_{US,B2B,CA}_API_KEY` / `_SECRET_KEY`) marker (Newegg's documented dummy examples are allowlisted). Exit code 1 on any finding.
- **`verify:exports`** (`scripts/verify-exports.mjs`) imports each built package and checks
  that its expected named exports are present and that every `exports` target file — the
  root entry and the SDK's `./testing` subpath — exists on disk. Run it **after** `build`.

### Review the `pack:dry` output

`npm run pack:dry` runs `npm pack --dry-run` for both packages. Confirm the tarball contents
match each package's `files` allowlist (`["dist", "README.md", "LICENSE"]`) — you should see the built
`dist/`, the README and the LICENSE, and **must not** see `src/`, tests, `.env`, tsconfig, or coverage.
Anything unexpected means a stray file would ship to npm.

---

## Publish

Build first, then publish the **SDK before the MCP server** (the MCP package depends on the
SDK being resolvable on the registry):

```bash
npm run build

npm publish --access public -w @joinmarka/newegg
npm publish --access public -w @joinmarka/newegg-mcp
```

`--access public` is explicit even though `publishConfig.access` already sets it — harmless
and clear. Add npm **provenance** when publishing from trusted CI (npm ≥ 9.5 with OIDC),
which attaches a verifiable build attestation:

```bash
npm publish --provenance --access public -w @joinmarka/newegg
npm publish --provenance --access public -w @joinmarka/newegg-mcp
```

`--provenance` requires a supported CI environment (e.g. GitHub Actions with `id-token:
write`); it will fail on a local machine.

---

## Tag and release notes

After a successful publish:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Create a GitHub release for the tag with notes that cover:

- **API changes** relative to `docs/research/sdk-public-api.md` (new/changed/removed surface),
  flagged as major/minor/patch.
- **Platform or wire-contract corrections** (e.g. a resolved assumption from
  `docs/platform-differences.md`).
- **MCP tool/resource changes** and any change to default safety posture
  (`NEWEGG_MCP_ALLOW_WRITES`, TTLs, guard limits).
- **Known limitations** carried forward (no price updates, feed date filters, unresolved
  assumptions).

---

## Release checklist

- [ ] Clean working tree, on `main`, CI green.
- [ ] Version bumped in `packages/sdk/package.json` and `packages/mcp-server/package.json`
      (and the SDK dependency range in the MCP package if needed).
- [ ] `npm ci`
- [ ] `npm run check:secrets`
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm run lint && npm run format:check`
- [ ] `npm run test:coverage`
- [ ] `npm run verify:exports`
- [ ] `npm run pack:dry` — file lists reviewed (`dist`, `README.md`, `LICENSE` only).
- [ ] `npm publish` SDK, then MCP (`--access public`, `--provenance` in CI).
- [ ] `git tag` + push + GitHub release notes.
- [ ] Smoke test: `npx -y @joinmarka/newegg-mcp` (stdio boots) and
      `npm i @joinmarka/newegg` in a scratch project (types resolve).
