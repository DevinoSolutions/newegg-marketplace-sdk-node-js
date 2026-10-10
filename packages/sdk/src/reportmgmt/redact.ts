/**
 * Redaction of the credential-bearing FTP download URLs that file-style reports return in
 * `ResponseBody.ReportFileURL` (contracts §17.5): `ftp://{user}:{password}@ftp03.newegg.com/...`.
 * The raw URL is a secret - it must never be logged, returned, or placed in an error.
 */
import { asArray, asString, getField, isRecord } from "../schemas/wire.js";

const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@"'<>]*@/gi;

/** Replaces the `user:password@` part of any URL inside `text` with `***@`. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_CREDENTIALS, "$1://***@");
}

/**
 * Deep-copies a JSON-ish value with every string run through {@link redactUrlCredentials}.
 * Used for every `raw` payload surfaced by the reports API so `includeRaw` can never leak
 * the download URL's embedded credentials.
 */
export function sanitizeRaw(value: unknown): unknown {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (Array.isArray(value)) return value.map(sanitizeRaw);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = sanitizeRaw(inner);
    return out;
  }
  return value;
}

/** Parsed description of a report file URL. */
export interface ReportFileLocation {
  /** Original URL string. SECRET - hold it only long enough to download; never log/return it. */
  readonly url: string;
  readonly host: string;
  /** Last path segment, e.g. `InternationalInventoryReport_2PQC13C7UYDPQ.zip`. */
  readonly fileName?: string;
}

/** Locates `ReportFileURL` in a result body (`NeweggAPIResponse.ResponseBody` or `ResponseBody`). */
export function findReportFileUrl(json: unknown): string | undefined {
  const wrapped = getField(json, "NeweggAPIResponse");
  const root = isRecord(wrapped) ? wrapped : json;
  const body = getField(root, "ResponseBody");
  const direct = asString(getField(body, "ReportFileURL"));
  if (direct !== undefined && direct !== "") return direct;
  // Defensive: some shapes may nest it under a list.
  for (const entry of asArray(getField(body, "ResponseList"))) {
    const nested = asString(getField(entry, "ReportFileURL"));
    if (nested !== undefined && nested !== "") return nested;
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Splits a report file URL into host + file name (returns undefined for an unparseable URL). */
export function describeReportFile(url: string): ReportFileLocation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const lastSegment = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .pop();
  const fileName = lastSegment === undefined ? undefined : safeDecode(lastSegment);
  return { url, host: parsed.hostname, ...(fileName !== undefined ? { fileName } : {}) };
}
