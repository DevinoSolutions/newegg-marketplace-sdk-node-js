// Guards against committing credentials:
// 1. .gitignore must exclude .env
// 2. If a local .env exists, none of its secret values may appear in any scanned file.
// 3. Generic scan for credential-looking values next to Authorization/SecretKey
//    markers, excluding Newegg's documented dummy examples.
//
// IMPORTANT: the scan list is the WORKING TREE (`git ls-files -co --exclude-standard`,
// i.e. tracked + untracked-but-not-ignored files). Do NOT narrow this back to plain
// `git ls-files`: in a repo with nothing committed/staged that scans zero files and
// the check passes hollowly while secrets sit in soon-to-be-committed files.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

// Documented dummy credentials used in Newegg's public examples (safe to appear in docs/fixtures).
const DOC_DUMMIES: ReadonlySet<string> = new Set([
  "720ddc067f4d115bd544aff46bc75634",
  "727ddc067f4d115bd544aff46bc15634",
  "21EC2020-3AEA-1069-A2DD-08002B30309D",
  "1B6B1383-01D1-4A1E-BA53-05DECE9BD765",
]);

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

const localSecrets: string[] = [];
if (existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*NEWEGG_(SELLER_ID|API_KEY|SECRET_KEY)\s*=\s*(.+?)\s*$/);
    const value = m?.[2];
    if (value !== undefined && value.length >= 4) {
      localSecrets.push(value.replace(/^["']|["']$/g, ""));
    }
  }
}

for (const file of scanned) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue; // binary
  }
  for (const secret of localSecrets) {
    if (text.includes(secret)) fail(`${file} contains a value from your local .env`);
  }
  for (const m of text.matchAll(
    /(?:Authorization|apiKey|NEWEGG_API_KEY)["'\s:=]+([0-9a-f]{32})\b/gi,
  )) {
    const value = m[1];
    if (value !== undefined && !DOC_DUMMIES.has(value))
      fail(`${file} contains an API-key-looking value: ${value.slice(0, 6)}…`);
  }
  for (const m of text.matchAll(
    /(?:SecretKey|secretKey|NEWEGG_SECRET_KEY)["'\s:=]+([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\b/g,
  )) {
    const value = m[1];
    if (value !== undefined && !DOC_DUMMIES.has(value.toUpperCase()))
      fail(`${file} contains a secret-key-looking value: ${value.slice(0, 6)}…`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} secret check(s) failed`);
  process.exit(1);
}
console.log(`Secret checks passed (${scanned.length} files scanned)`);
