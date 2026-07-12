/**
 * Pacific-time date handling. Every Newegg timestamp is Pacific Time (with DST), and
 * many arrive without an explicit offset, so wall-clock forms are resolved against
 * `America/Los_Angeles` using `Intl.DateTimeFormat` to compute the correct UTC instant.
 */

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset in ms such that `wallClockAsUtc - offset === actualUtc` for the given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    map.hour ?? 0,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return asUtc - utcMs;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseWallClock(value: string): WallClock | undefined {
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (mdy) {
    return {
      month: Number(mdy[1]),
      day: Number(mdy[2]),
      year: Number(mdy[3]),
      hour: Number(mdy[4]),
      minute: Number(mdy[5]),
      second: Number(mdy[6] ?? "0"),
    };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4]),
      minute: Number(iso[5]),
      second: Number(iso[6] ?? "0"),
    };
  }
  return undefined;
}

function pacificWallToUtc(wall: WallClock): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const firstOffset = zoneOffsetMs(guess, PACIFIC_TIME_ZONE);
  let utc = guess - firstOffset;
  const secondOffset = zoneOffsetMs(utc, PACIFIC_TIME_ZONE);
  if (secondOffset !== firstOffset) utc = guess - secondOffset;
  return new Date(utc);
}

/**
 * Parses a Newegg timestamp into a UTC `Date`. Supports ISO 8601 (with offset/Z), epoch
 * seconds or millis, `M/D/YYYY H:mm[:ss]`, and `YYYY-MM-DD HH:mm[:ss]`; the latter two are
 * interpreted as Pacific wall-clock time. Returns `undefined` for anything unparseable.
 */
export function parsePacificTimestamp(raw: string | undefined | null): Date | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value === "") return undefined;

  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const ms = n >= 1e12 ? n : n * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  if (/[Tt].*([Zz]|[+-]\d{2}:?\d{2})$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const wall = parseWallClock(value);
  if (wall) return pacificWallToUtc(wall);

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}

/** ISO 8601 string for a `Date`. */
function toIso(date: Date): string {
  return date.toISOString();
}

/** Wraps a raw Newegg timestamp into the `{ raw, iso? }` shape surfaced on the public API. */
export function toTimestamp(
  raw: string | undefined | null,
): { raw: string; iso?: string } | undefined {
  if (raw == null) return undefined;
  const value = String(raw);
  if (value.trim() === "") return undefined;
  const date = parsePacificTimestamp(value);
  return date ? { raw: value, iso: toIso(date) } : { raw: value };
}
