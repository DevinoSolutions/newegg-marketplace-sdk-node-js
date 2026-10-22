/**
 * Redaction for anything the MCP server writes to its logs. Unexpected errors (a failed `fetch`,
 * a library bug) can carry full URLs in their message or stack: credentials in the userinfo, or a
 * query string such as `?sellerid=...`. Both are removed before the text reaches a log sink that
 * may be shipped to a log service or pasted into a ticket.
 */
import { redactUrlCredentials } from "@devino/newegg-marketplace-sdk";

/** Ends the part of a URL before its query: whitespace, another `?`, a fragment, a quote or a bracket. */
const URL_PART_END = /[\s?#"'<>]/;
/** Ends a query string. */
const QUERY_END = /[\s#"'<>]/;

/**
 * `http(s)://host/path?query#frag` -> `http(s)://host/path?[redacted]#frag`. One forward pass with
 * `indexOf` (no backtracking regex), so a pathological input such as `a://` repeated cannot make
 * it quadratic: each scanned stretch starts where the previous one ended. There is no cap on how
 * far the part before the `?` may run, so a very long path cannot keep its query in a log.
 */
function redactQueryStrings(text: string): string {
  if (!text.includes("?")) return text;
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const separator = text.indexOf("://", from);
    if (separator < 0) break;
    const start = separator + 3;
    let end = start;
    while (end < text.length && !URL_PART_END.test(text.charAt(end))) end += 1;
    if (end < text.length && text.charAt(end) === "?") {
      let queryEnd = end + 1;
      while (queryEnd < text.length && !QUERY_END.test(text.charAt(queryEnd))) queryEnd += 1;
      out += `${text.slice(copied, end + 1)}[redacted]`;
      copied = queryEnd;
      from = queryEnd;
    } else {
      from = end;
    }
  }
  return out + text.slice(copied);
}

/** Removes URL credentials and URL query strings from `text`. Never throws. */
export function redactLogText(text: string): string {
  return redactQueryStrings(redactUrlCredentials(text));
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
