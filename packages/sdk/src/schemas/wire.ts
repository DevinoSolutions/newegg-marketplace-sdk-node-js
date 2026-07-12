/**
 * Tolerant readers for Newegg wire responses. Newegg's XML-to-JSON conversion makes
 * scalars arrive as strings or numbers, booleans as "true"/"0"/"1", and objects as a
 * single value or an array interchangeably. These helpers coerce defensively and never
 * throw — callers wrap genuinely unusable payloads in `NeweggApiError`.
 */
import { isRecord } from "../util.js";

export { isRecord };

/** Wraps a single value as a one-element array; `undefined`/`null` become an empty array. */
export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  return undefined;
}

/** Reads a single field from a record-like value, tolerating non-objects. */
export function getField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Navigates a nested path, tolerating missing intermediate objects. */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Coerces every string value of a record into a `Record<string, string>` (skips objects/arrays). */
export function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const str = asString(raw);
    if (str !== undefined) out[key] = str;
  }
  return out;
}
