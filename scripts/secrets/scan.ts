// Matching of .env secret values against file bytes (used by check-secrets.ts).
//
// Every file is scanned as raw bytes — binary files are never skipped (a secret can sit in an
// image's metadata, a zip, a PowerShell `>` redirect that wrote UTF-16LE, ...). A needle is
// looked for as:
//   * UTF-8 text,
//   * UTF-16/UTF-32 text: the file with NUL bytes removed (covers LE/BE, any alignment, BOM) and,
//     for values of 8+ characters, the exact UTF-16LE/BE byte sequence (non-Latin-1 values),
//   * base64 / base64url of the value (12+ characters only, so the encoded needle is 13+ chars),
//   * URL-encoded (encodeURIComponent, upper- and lower-case hex) when that differs from the value.
// Findings carry the file, line, .env KEY NAME and encoding — never the value.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Needle } from "./env.js";

export interface Finding {
  file: string;
  /** 1-based line in the scanned file; absent when the match was found in raw bytes. */
  line?: number;
  kind: "env-value" | "api-key-pattern" | "secret-key-pattern" | "unreadable";
  /** .env key whose value matched (kind "env-value"). */
  key?: string;
  encoding?: "utf-8" | "utf-16/32" | "base64" | "url";
  /** First 2 characters of an unknown-provenance key-looking value (generic patterns only). */
  maskedPrefix?: string;
}

/** Documented dummy credentials used in Newegg's public examples (safe in docs/fixtures). */
const DOC_DUMMIES: ReadonlySet<string> = new Set([
  "720ddc067f4d115bd544aff46bc75634",
  "727ddc067f4d115bd544aff46bc15634",
  "21EC2020-3AEA-1069-A2DD-08002B30309D",
  "1B6B1383-01D1-4A1E-BA53-05DECE9BD765",
]);

const MIN_UNBOUNDED = 12;
const MIN_BASE64 = 12;
const MIN_RAW_UTF16 = 8;
const RETRY_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES", "UNKNOWN"]);
const RETRY_DELAYS_MS = [50, 200] as const;
const ALNUM = /[A-Za-z0-9]/;

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
};

/** Index of `needle` in `text`; values under 12 chars must not touch other letters/digits. */
function indexOfValue(text: string, needle: string): number {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (needle.length >= MIN_UNBOUNDED) return at;
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + needle.length] ?? "";
    if (!ALNUM.test(before) && !ALNUM.test(after)) return at;
  }
  return -1;
}

/** The 3 byte-alignments of `value` in base64 + base64url, keeping only fully determined chars. */
function base64Needles(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const out: string[] = [];
  for (const [pad, skip] of [
    [0, 0],
    [1, 2],
    [2, 3],
  ] as const) {
    const enc = Buffer.concat([Buffer.alloc(pad), bytes]).toString("base64");
    const complete = Math.floor((pad + bytes.length) / 3) * 4;
    const needle = enc.slice(skip, complete);
    if (needle.length >= MIN_BASE64) {
      out.push(needle, needle.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return out;
}

/** A needle with its derived encodings computed once (not per file). */
interface PreparedNeedle extends Needle {
  b64: string[];
  url: string[];
}

function prepare(needle: Needle): PreparedNeedle {
  const { value } = needle;
  const encoded = encodeURIComponent(value);
  const url =
    encoded === value
      ? []
      : [encoded, encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())].filter(
          (v, i, all) => all.indexOf(v) === i,
        );
  return { ...needle, b64: value.length >= MIN_BASE64 ? base64Needles(value) : [], url };
}

function rawUtf16Hit(buf: Buffer, value: string): boolean {
  const le = Buffer.from(value, "utf16le");
  return buf.includes(le) || buf.includes(Buffer.from(le).swap16());
}

/** First hit of one needle in one file, or undefined. */
function findNeedle(
  needle: PreparedNeedle,
  buf: Buffer,
  text: string,
  stripped: string | undefined,
): Pick<Finding, "line" | "encoding"> | undefined {
  const { value } = needle;
  let at = indexOfValue(text, value);
  if (at !== -1) return { line: lineAt(text, at), encoding: "utf-8" };
  if (stripped !== undefined) {
    at = indexOfValue(stripped, value);
    if (at !== -1) return { line: lineAt(stripped, at), encoding: "utf-16/32" };
    if (value.length >= MIN_RAW_UTF16 && rawUtf16Hit(buf, value)) return { encoding: "utf-16/32" };
  }
  for (const b64 of needle.b64) {
    for (const view of [text, stripped]) {
      at = view?.indexOf(b64) ?? -1;
      if (at !== -1 && view !== undefined) return { line: lineAt(view, at), encoding: "base64" };
    }
  }
  for (const encoded of needle.url) {
    at = indexOfValue(text, encoded);
    if (at !== -1) return { line: lineAt(text, at), encoding: "url" };
  }
  return undefined;
}

const API_KEY =
  /(?:Authorization|apiKey|NEWEGG_(?:(?:US|B2B|CA)_)?API_KEY)["'\s:=]+([0-9a-f]{32})\b/gi;
const SECRET_KEY =
  /(?:SecretKey|secretKey|NEWEGG_(?:(?:US|B2B|CA)_)?SECRET_KEY)["'\s:=]+([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\b/g;

function patternFindings(file: string, view: string): Finding[] {
  const out: Finding[] = [];
  for (const m of view.matchAll(API_KEY)) {
    const value = m[1];
    if (value !== undefined && !DOC_DUMMIES.has(value))
      out.push({
        file,
        line: lineAt(view, m.index),
        kind: "api-key-pattern",
        maskedPrefix: value.slice(0, 2),
      });
  }
  for (const m of view.matchAll(SECRET_KEY)) {
    const value = m[1];
    if (value !== undefined && !DOC_DUMMIES.has(value.toUpperCase()))
      out.push({
        file,
        line: lineAt(view, m.index),
        kind: "secret-key-pattern",
        maskedPrefix: value.slice(0, 2),
      });
  }
  return out;
}

/** Scans one file's bytes: every needle (once each) plus the generic credential patterns. */
function scanBuffer(file: string, buf: Buffer, needles: readonly PreparedNeedle[]): Finding[] {
  const text = buf.toString("utf8");
  const stripped = buf.includes(0) ? buf.toString("latin1").replace(/\0/g, "") : undefined;
  const findings: Finding[] = [];
  for (const needle of needles) {
    const hit = findNeedle(needle, buf, text, stripped);
    if (hit) findings.push({ file, kind: "env-value", key: needle.key, ...hit });
  }
  findings.push(...patternFindings(file, text));
  if (stripped !== undefined) findings.push(...patternFindings(file, stripped));
  return findings;
}

/** One report line. Names the file, line and .env KEY only — never the matched value. */
export function formatFinding(f: Finding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  if (f.kind === "unreadable") return `${f.file} could not be read (${f.key ?? "error"})`;
  if (f.kind === "env-value")
    return `${where} contains the value of .env key ${f.key ?? "?"} (${f.encoding ?? "?"})`;
  const label = f.kind === "api-key-pattern" ? "an API-key-looking" : "a secret-key-looking";
  return `${where} contains ${label} value: ${f.maskedPrefix ?? ""}…`;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Reads a file, retrying briefly on transient lock errors (OneDrive / antivirus). */
function readWithRetry(path: string): Buffer {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readFileSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const delay = RETRY_DELAYS_MS[attempt];
      if (!RETRY_CODES.has(code) || delay === undefined) throw error;
      sleepSync(delay);
    }
  }
}

/**
 * Scans `files` (paths relative to `root`, exact names — callers must pass `git ls-files -z`
 * output, not the C-quoted form). A file that cannot be read is a finding, not a skip. Only
 * ENOENT is ignored: a tracked-but-deleted file or dangling symlink has no content that could
 * reach a commit.
 */
export function scanFiles(
  root: string,
  files: readonly string[],
  needles: readonly Needle[],
): Finding[] {
  const prepared = needles.map(prepare);
  const findings: Finding[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readWithRetry(join(root, file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") continue; // gone / submodule directory
      findings.push({ file, kind: "unreadable", key: code });
      continue;
    }
    findings.push(...scanBuffer(file, bytes, prepared));
  }
  return findings;
}
