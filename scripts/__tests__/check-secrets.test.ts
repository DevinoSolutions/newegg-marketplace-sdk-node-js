// Unit tests for scripts/check-secrets.ts (secrets/env.ts + secrets/scan.ts). Everything runs in a
// temp dir with a FAKE .env and fake files; the repo's real .env is never read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEnvFile, parseEnv, selectNeedles } from "../secrets/env.js";
import { formatFinding, scanFiles } from "../secrets/scan.js";

const FAKE = "Zq7rT2mPw9LxK4vB8nHd"; // fake 20-char token
const FAKE_SHORT = "K9X2"; // fake 4-char seller id

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-secrets-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const needlesFor = (env: string | Buffer) =>
  selectNeedles(parseEnv(decodeEnvFile(Buffer.from(env))));

/** Writes `files` into the temp dir, scans them against `env`, returns the formatted report. */
function report(env: string | Buffer, files: Record<string, string | Buffer>): string[] {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return scanFiles(dir, Object.keys(files), needlesFor(env)).map(formatFinding);
}

const utf16le = (s: string, bom = true): Buffer =>
  Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);

describe("check-secrets: matching", () => {
  it("flags a UTF-8 hit with file, line and KEY name, and clears when removed", () => {
    const env = `FOO_TOKEN=${FAKE}\n`;
    const hit = report(env, { "docs/a.md": `line one\ntoken: ${FAKE}\n` });
    expect(hit).toEqual(["docs/a.md:2 contains the value of .env key FOO_TOKEN (utf-8)"]);
    expect(report(env, { "docs/b.md": "nothing here\n" })).toEqual([]);
  });

  it("checks every secret-shaped value, not just NEWEGG_* (named and token-shaped unnamed keys)", () => {
    const env = [
      "EBAY_USER_ACCESS_TOKEN=v1.ebayFakeTokenValue12345",
      "WALMART_CLIENT_SECRET=walmartFakeSecret9876",
      "BESTBUY_API_KEY=bbyFakeKey1234567890",
      "NEWEGG_MCP_HTTP_BEARER_TOKEN=bearerFake00112233",
      "SOME_OPAQUE_VALUE=abc123def456ghi789jk",
    ].join("\n");
    const names = report(env, {
      "a.txt": "v1.ebayFakeTokenValue12345 walmartFakeSecret9876 bbyFakeKey1234567890",
      "b.txt": "bearerFake00112233 abc123def456ghi789jk",
    }).map((l) => /key (\S+)/.exec(l)?.[1]);
    expect(names).toEqual([
      "EBAY_USER_ACCESS_TOKEN",
      "WALMART_CLIENT_SECRET",
      "BESTBUY_API_KEY",
      "NEWEGG_MCP_HTTP_BEARER_TOKEN",
      "SOME_OPAQUE_VALUE",
    ]);
  });

  it.each([
    ["UTF-16LE with BOM", utf16le(`secret=${FAKE}\r\n`)],
    ["UTF-16LE without BOM", utf16le(`secret=${FAKE}\r\n`, false)],
    ["UTF-16BE", Buffer.from(utf16le(`secret=${FAKE}`, false)).swap16()],
  ])("flags a %s file", (_name, content) => {
    const out = report(`FOO_TOKEN=${FAKE}`, { "out.txt": content });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("FOO_TOKEN");
    expect(out[0]).toContain("utf-16/32");
  });

  it("flags a non-Latin-1 secret written as UTF-16LE", () => {
    const secret = "пароль-секрет-12345";
    const out = report(`FOO_PASSWORD=${secret}`, { "out.txt": utf16le(`x ${secret} y`) });
    expect(out).toEqual(["out.txt contains the value of .env key FOO_PASSWORD (utf-16/32)"]);
  });

  it("scans binary files instead of skipping them", () => {
    const blob = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]),
      Buffer.from(FAKE),
      Buffer.from([0x00, 0xff, 0x00, 0x80, 0x00]),
    ]);
    const out = report(`FOO_TOKEN=${FAKE}`, { "img/x.png": blob });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("FOO_TOKEN");
  });

  it("flags base64 and base64url of a secret at any byte alignment", () => {
    for (const prefix of ["", "a", "ab"]) {
      const b64 = Buffer.from(`${prefix}${FAKE}`).toString("base64");
      const url = b64.replace(/\+/g, "-").replace(/\//g, "_");
      for (const encoded of [b64, url]) {
        const out = report(`FOO_TOKEN=${FAKE}`, { "enc.txt": `Authorization: ${encoded}\n` });
        expect(out, `prefix "${prefix}"`).toEqual([
          "enc.txt:1 contains the value of .env key FOO_TOKEN (base64)",
        ]);
      }
    }
  });

  it("matches short values (4-7 chars, letter+digit) on word boundaries only", () => {
    const env = `NEWEGG_SELLER_ID=${FAKE_SHORT}\n`;
    expect(report(env, { "a.txt": `seller ${FAKE_SHORT} ok` })).toHaveLength(1);
    expect(report(env, { "b.txt": `A${FAKE_SHORT}B embedded` })).toEqual([]);
  });

  it("keeps the generic credential patterns and masks them to 2 characters", () => {
    const hex = "ab".repeat(16);
    const out = report("", { "c.txt": `apiKey: ${hex}\n` });
    expect(out).toEqual(["c.txt:1 contains an API-key-looking value: ab…"]);
    expect(report("", { "d.txt": "apiKey: 720ddc067f4d115bd544aff46bc75634\n" })).toEqual([]);
    // also inside a UTF-16 file
    expect(report("", { "e.txt": utf16le(`apiKey: ${hex}`) })).toHaveLength(1);
  });

  it("never puts a secret value in a report line", () => {
    const values = [FAKE, FAKE_SHORT, "ab".repeat(16)];
    const lines = report(`FOO_TOKEN=${FAKE}\nNEWEGG_SELLER_ID=${FAKE_SHORT}`, {
      "1.txt": `${FAKE} ${FAKE_SHORT}`,
      "2.txt": utf16le(FAKE),
      "3.txt": Buffer.from(FAKE).toString("base64"),
      "4.txt": `apiKey: ${"ab".repeat(16)}`,
    });
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) for (const v of values) expect(line).not.toContain(v);
  });

  it("does not fail on a directory entry", () => {
    mkdirSync(join(dir, "sub"));
    expect(scanFiles(dir, ["sub"], needlesFor(`FOO_TOKEN=${FAKE}`))).toEqual([]);
  });
});

describe("check-secrets: .env parsing", () => {
  const value = (env: string, key: string) =>
    parseEnv(env)
      .filter((e) => e.key === key)
      .map((e) => e.value);

  it("accepts an export prefix and strips inline comments (keeping the raw reading too)", () => {
    expect(value("export X_API_KEY=abc123def456 # prod\n", "X_API_KEY")).toEqual([
      "abc123def456",
      "abc123def456 # prod",
    ]);
    const out = report("export NEWEGG_API_KEY=abc123def456 # prod", { "a.txt": "abc123def456" });
    expect(out).toEqual(["a.txt:1 contains the value of .env key NEWEGG_API_KEY (utf-8)"]);
  });

  it("handles quotes, # inside quotes, CRLF, BOM and comment lines", () => {
    const env =
      "\uFEFF# comment\r\n" +
      'A_KEY="v#lue 1234" # c\r\n' +
      "B_KEY='sing#le9999'\r\n" +
      "export C_KEY = plain1234\r\n";
    expect(value(env, "A_KEY")).toEqual(["v#lue 1234"]);
    expect(value(env, "B_KEY")).toEqual(["sing#le9999"]);
    expect(value(env, "C_KEY")).toEqual(["plain1234"]);
  });

  it("expands double-quote escapes, supports multi-line values, survives an unterminated quote", () => {
    expect(value('D_KEY="a\\nb"\n', "D_KEY")).toEqual(["a\nb", "a\\nb"]);
    const pem = 'PEM_KEY="-----BEGIN-----\nline-two-1234\n-----END-----"\nNEXT_KEY=after1234';
    expect(value(pem, "PEM_KEY")[0]).toContain("line-two-1234");
    expect(value(pem, "NEXT_KEY")).toEqual(["after1234"]);
    const bad = 'BAD_KEY="oops1234\nOK_KEY=fine1234\n';
    expect(value(bad, "OK_KEY")).toEqual(["fine1234"]);
    expect(value(bad, "BAD_KEY")).toContain("oops1234");
  });

  it("decodes a UTF-16LE .env file (PowerShell redirect)", () => {
    const needles = needlesFor(utf16le(`FOO_TOKEN=${FAKE}\r\n`));
    expect(needles.map((n) => [n.key, n.value])).toEqual([["FOO_TOKEN", FAKE]]);
  });

  it("selects nothing from an absent/empty .env", () => {
    expect(needlesFor("")).toEqual([]);
  });
});

describe("check-secrets: what is NOT a secret", () => {
  const picked = (env: string) => needlesFor(env).map((n) => n.key);

  it("ignores booleans, numbers, URLs, hosts, paths, plain words, marketplace codes, short junk", () => {
    const env = [
      "NEWEGG_MCP_ALLOW_WRITES=false",
      "NEWEGG_MCP_MAX_ITEMS_PER_OPERATION=500",
      "PORT=3919",
      "NEWEGG_MARKETPLACE=us",
      "NEWEGG_API_BASE_URL=https://api.newegg.com/marketplace/",
      "EBAY_OAUTH_URL=https://auth.ebay.com/oauth2/authorize?response_type=code",
      "NEWEGG_MCP_HTTP_HOST=127.0.0.1",
      "SOME_HOST=api.sandbox.ebay-us-1.example.com",
      "ALLOWED_ORIGINS=http://localhost:3000,https://app.example.com",
      "DATA_DIR=C:\\Users\\someone\\data-1234567890",
      "ANOTHER_DIR=./some/relative/path-12345678",
      "EBAY_ENVIRONMENT=production",
      "SHORT_NOTE=abc12",
      "SPACED_NOTE=this is a normal sentence with 12 words",
      "EMPTY_TOKEN=",
      "WORD_PASSWORD=hunter",
      "NUM_KEY=1234",
      "BOOL_KEY=true",
    ].join("\n");
    expect(picked(env)).toEqual([]);
  });

  it("ignores placeholders in the .env.example style", () => {
    const env = [
      "NEWEGG_SELLER_ID=YOUR_SELLER_ID",
      "NEWEGG_API_KEY=YOUR_API_KEY",
      "NEWEGG_SECRET_KEY=YOUR_SECRET_KEY",
      "A_TOKEN=<your-token-here>",
      "B_TOKEN=${OTHER_TOKEN}",
      "C_TOKEN=changeme",
      "D_TOKEN=xxxxxxxxxxxx",
      "E_TOKEN=paste_token_HERE",
    ].join("\n");
    expect(picked(env)).toEqual([]);
    // ...and a file carrying the placeholder text is therefore clean
    expect(report(env, { ".env.example": "NEWEGG_API_KEY=YOUR_API_KEY\n" })).toEqual([]);
  });

  it("still flags a URL that embeds credentials", () => {
    const env =
      "DB_URL=https://user:pw0rd1234567@host.example.com/x\n" +
      "F_URL=https://h.example.com/p?api_key=abcd1234efgh";
    expect(picked(env)).toEqual(["DB_URL", "F_URL"]);
  });

  it("does not match placeholder or ordinary repo text against real-looking values", () => {
    const env = `FOO_TOKEN=${FAKE}\nNEWEGG_API_KEY=YOUR_API_KEY\nNEWEGG_MARKETPLACE=us\n`;
    expect(
      report(env, { "README.md": "Set NEWEGG_API_KEY=YOUR_API_KEY and NEWEGG_MARKETPLACE=us\n" }),
    ).toEqual([]);
  });
});
