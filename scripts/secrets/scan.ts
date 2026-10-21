// Matching of .env secret values against file bytes (used by check-secrets.ts).
//
// Every file is scanned as raw bytes — binary files are never skipped (a secret can sit in an
// image's metadata, a zip, a PowerShell `>` redirect that wrote UTF-16LE, ...). A needle is
// looked for as:
//   * UTF-8 text,
//   * UTF-16/UTF-32 text: the file with NUL bytes removed (covers LE/BE, any alignment, BOM) and,
//     for values of 8+ characters, the exact UTF-16LE/BE byte sequence (non-Latin-1 values),
//   * base64 / base64url of the value (12+ characters only, so the encoded needle is 13+ chars).
// Findings carry the file, line, .env KEY NAME and encoding — never the value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Needle } from "./env.js";

export interface Finding {
  file: string;
  /** 1-based line in the scanned file; absent when the match was found in raw bytes. */
  line?: number;
  kind: "env-value" | "api-key-pattern" | "secret-key-pattern" | "unreadable";
  /** .env key whose value matched (kind "env-value"). */
  key?: string;
  encoding?: "utf-8" | "utf-16/32" | "base64";
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

function rawUtf16Hit(buf: Buffer, value: string): boolean {
  const le = Buffer.from(value, "utf16le");
  return buf.includes(le) || buf.includes(Buffer.from(le).swap16());
}

/** First hit of one needle in one file, or undefined. */
function findNeedle(
  needle: Needle,
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
  if (value.length >= MIN_BASE64) {
    for (const b64 of base64Needles(value)) {
      for (const view of [text, stripped]) {
        at = view?.indexOf(b64) ?? -1;
        if (at !== -1 && view !== undefined) return { line: lineAt(view, at), encoding: "base64" };
      }
    }
  }
  return undefined;
}

const API_KEY = /(?:Authorization|apiKey|NEWEGG_API_KEY)["'\s:=]+([0-9a-f]{32})\b/gi;
const SECRET_KEY =
  /(?:SecretKey|secretKey|NEWEGG_SECRET_KEY)["'\s:=]+([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\b/g;

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
function scanBuffer(file: string, buf: Buffer, needles: readonly Needle[]): Finding[] {
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

/** Scans `files` (paths relative to `root`); a file that cannot be read is a finding, not a skip. */
export function scanFiles(
  root: string,
  files: readonly string[],
  needles: readonly Needle[],
): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      // Directories (submodule entries) are not files; anything else must not be skipped silently.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EISDIR") findings.push({ file, kind: "unreadable", key: code });
      continue;
    }
    findings.push(...scanBuffer(file, bytes, needles));
  }
  return findings;
}
