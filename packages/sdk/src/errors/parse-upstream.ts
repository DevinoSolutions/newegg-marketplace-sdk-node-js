import type { RateLimitInfo } from "../types.js";
import { parsePacificTimestamp } from "../platform/dates.js";
import { isRecord } from "../util.js";
import {
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggAuthorizationError,
  type NeweggError,
  NeweggRateLimitError,
} from "./index.js";

/** A single upstream error, normalized across Newegg's JSON/XML/plain-text shapes. */
interface UpstreamErrorEntry {
  code?: string;
  message?: string;
}

const MAX_MESSAGE_LEN = 500;

function clip(value: string): string {
  return value.length > MAX_MESSAGE_LEN ? `${value.slice(0, MAX_MESSAGE_LEN)}…` : value;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function entryFromRecord(record: Record<string, unknown>): UpstreamErrorEntry {
  const code = record.Code ?? record.code;
  const message = record.Message ?? record.message;
  return {
    code: typeof code === "string" ? code : code == null ? undefined : String(code),
    message: typeof message === "string" ? message : message == null ? undefined : String(message),
  };
}

function normalizeJsonError(json: unknown): UpstreamErrorEntry[] {
  if (Array.isArray(json)) {
    return json.filter(isRecord).map(entryFromRecord);
  }
  if (isRecord(json)) {
    if ("Code" in json || "Message" in json || "code" in json || "message" in json) {
      return [entryFromRecord(json)];
    }
  }
  return [];
}

function parseXmlErrors(text: string): UpstreamErrorEntry[] {
  const codes = [...text.matchAll(/<Code>([\s\S]*?)<\/Code>/gi)].map((m) =>
    decodeXmlEntities((m[1] ?? "").trim()),
  );
  const messages = [...text.matchAll(/<Message>([\s\S]*?)<\/Message>/gi)].map((m) =>
    decodeXmlEntities((m[1] ?? "").trim()),
  );
  const count = Math.max(codes.length, messages.length);
  const out: UpstreamErrorEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ code: codes[i] || undefined, message: messages[i] || undefined });
  }
  return out;
}

/** Parses any Newegg error body (JSON object, JSON array, XML, or plain text) into entries. */
export function parseUpstreamBody(bodyText: string | undefined): UpstreamErrorEntry[] {
  const text = (bodyText ?? "").trim();
  if (text === "") return [];
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return normalizeJsonError(JSON.parse(text));
    } catch {
      // Not valid JSON despite the leading brace — fall through to other parsers.
    }
  }
  if (text.startsWith("<")) {
    const xml = parseXmlErrors(text);
    if (xml.length > 0) return xml;
  }
  return [{ message: clip(text) }];
}

function extractFeedRequestId(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const m = /request id:\s*([A-Za-z0-9]+)/i.exec(message);
  return m?.[1];
}

/** Parses the "submit your feed again after <Pacific timestamp>" hint from a DF012 body. */
function parseDf012RetryAfterMs(message: string | undefined, now: number): number | undefined {
  if (!message) return undefined;
  const m = /submit your feed again after\s+([0-9\-/: ]+)/i.exec(message);
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  const resetAt = parsePacificTimestamp(raw);
  if (!resetAt) return undefined;
  const ms = resetAt.getTime() - now;
  return ms > 0 ? ms : 0;
}

interface UpstreamErrorContext {
  correlationId?: string;
  rateLimit?: RateLimitInfo;
  /** Cap applied to reset-derived retry delays (defaults to 5 minutes). */
  maxRetryAfterMs?: number;
}

/**
 * Maps an upstream non-2xx response to the correct SDK error subclass. Never includes
 * credential material — only Newegg's own `Code`/`Message` values reach `details`.
 */
export function parseUpstreamError(
  status: number,
  bodyText: string | undefined,
  _headers: Headers,
  ctx: UpstreamErrorContext = {},
): NeweggError {
  const entries = parseUpstreamBody(bodyText);
  const first = entries[0] ?? {};
  const code = first.code;
  const message = first.message;
  const details = { status, entries };
  const base = {
    httpStatus: status,
    neweggErrorCode: code,
    correlationId: ctx.correlationId,
    details,
  };
  const lowerMessage = (message ?? "").toLowerCase();

  if (status === 401 || code === "InvalidConsumerKey" || code === "InvalidToken") {
    return new NeweggAuthenticationError(
      `Newegg authentication failed (HTTP ${status}${code ? `, ${code}` : ""}).`,
      { ...base, retryable: false },
    );
  }

  if (
    status === 403 ||
    lowerMessage.includes("do not have authorization") ||
    lowerMessage.includes("has been deactivated")
  ) {
    return new NeweggAuthorizationError(
      `Newegg authorization denied (HTTP ${status}${code ? `, ${code}` : ""}).`,
      { ...base, retryable: false },
    );
  }

  if (status === 429 || code === "429" || code === "DF012") {
    const cap = ctx.maxRetryAfterMs ?? 5 * 60_000;
    const now = Date.now();
    let retryAfterMs = parseDf012RetryAfterMs(message, now);
    if (retryAfterMs === undefined && ctx.rateLimit?.requestResetAt) {
      const ms = ctx.rateLimit.requestResetAt.getTime() - now;
      if (ms > 0) retryAfterMs = ms;
    }
    if (retryAfterMs !== undefined) retryAfterMs = Math.min(retryAfterMs, cap);
    return new NeweggRateLimitError(
      `Newegg rate limit exceeded (HTTP ${status}${code ? `, ${code}` : ""}).`,
      {
        ...base,
        rateLimit: ctx.rateLimit,
        retryAfterMs,
        neweggRequestId: extractFeedRequestId(message),
        retryable: true,
      },
    );
  }

  const retryable =
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    // Newegg's transient 500: code "InternalError" with a body that asks for a retry
    // ("currently unavailable … Please try again", observed live on reportmgmt). A bare
    // 500 without that signal stays non-retryable.
    (status === 500 &&
      (code === "InternalError" ||
        lowerMessage.includes("please try again") ||
        lowerMessage.includes("currently unavailable")));
  return new NeweggApiError(
    `Newegg API request failed (HTTP ${status}${code ? `, ${code}` : ""}).`,
    { ...base, retryable },
  );
}
