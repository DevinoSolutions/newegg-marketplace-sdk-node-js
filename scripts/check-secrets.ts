// Guards against committing credentials:
// 1. .gitignore must exclude .env
// 2. If a local .env exists, none of its secret-shaped values may appear in any scanned file —
//    as UTF-8, UTF-16/32 (e.g. a PowerShell `>` redirect) or base64, binary files included.
//    What counts as a secret is defined in secrets/env.ts; matching is in secrets/scan.ts.
// 3. Generic scan for credential-looking values next to Authorization/SecretKey
//    markers, excluding Newegg's documented dummy examples.
//
// Output never contains a secret value: findings name the file, line and .env KEY only.
// CHECK_SECRETS_ENV_FILE overrides where .env is read from (the scanned tree is still this repo);
// CI has no .env, in which case checks 1 and 3 still run and check 2 is skipped.
//
// IMPORTANT: the scan list is the WORKING TREE (`git ls-files -co --exclude-standard`,
// i.e. tracked + untracked-but-not-ignored files). Do NOT narrow this back to plain
// `git ls-files`: in a repo with nothing committed/staged that scans zero files and
// the check passes hollowly while secrets sit in soon-to-be-committed files.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { decodeEnvFile, parseEnv, selectNeedles } from "./secrets/env.js";
import { formatFinding, scanFiles } from "./secrets/scan.js";

const root = resolve(import.meta.dirname, "..");
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

const gitignore = existsSync(join(root, ".gitignore"))
  ? readFileSync(join(root, ".gitignore"), "utf8")
  : "";
if (!/^\.env$/m.test(gitignore)) fail(".gitignore does not exclude .env");

// Tracked + untracked-unignored — the set of files that could ever reach a commit.
const scanned = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((f) => f && !f.startsWith("package-lock"));

const envFile = process.env["CHECK_SECRETS_ENV_FILE"] ?? join(root, ".env");
const needles = existsSync(envFile)
  ? selectNeedles(parseEnv(decodeEnvFile(readFileSync(envFile))))
  : [];

for (const finding of scanFiles(root, scanned, needles)) fail(formatFinding(finding));

if (failures > 0) {
  console.error(`\n${failures} secret check(s) failed`);
  process.exit(1);
}
console.log(
  `Secret checks passed (${scanned.length} files scanned, ${needles.length} .env value(s) checked)`,
);
