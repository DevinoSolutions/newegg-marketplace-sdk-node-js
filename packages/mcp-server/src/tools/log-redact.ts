/**
 * Redaction for anything the MCP server writes to its logs. Unexpected errors (a failed `fetch`,
 * a library bug) can carry full URLs in their message or stack: credentials in the userinfo, or a
 * query string such as `?sellerid=...`. Both are removed before the text reaches a log sink that
 * may be shipped to a log service or pasted into a ticket.
 */
import { redactUrlCredentials } from "@devino/newegg-marketplace-sdk";

/** `http(s)://host/path?query#frag` -> `http(s)://host/path?[redacted]#frag`. */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi;

/** Removes URL credentials and URL query strings from `text`. Never throws. */
export function redactLogText(text: string): string {
  return redactUrlCredentials(text).replace(URL_QUERY, "$1?[redacted]");
}

const MAX_DEPTH = 6;

/** Deep-copies log `fields`, passing every string through {@link redactLogText}. */
export function redactLogFields(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (typeof value !== "object" || value === null || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((inner: unknown) => redactLogFields(inner, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = redactLogFields(inner, depth + 1);
  return out;
}
