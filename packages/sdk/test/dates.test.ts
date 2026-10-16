import { describe, expect, it } from "vitest";
import {
  formatPacificWallClock,
  parsePacificTimestamp,
  toTimestamp,
} from "../src/platform/dates.js";

describe("parsePacificTimestamp", () => {
  it("interprets M/D/YYYY H:mm:ss as Pacific Standard Time (winter, -08:00)", () => {
    const date = parsePacificTimestamp("2/22/2012 17:24:35");
    expect(date?.toISOString()).toBe("2012-02-23T01:24:35.000Z");
  });

  it("interprets a summer wall-clock as Pacific Daylight Time (-07:00)", () => {
    const date = parsePacificTimestamp("7/15/2012 12:00:00");
    expect(date?.toISOString()).toBe("2012-07-15T19:00:00.000Z");
  });

  it("interprets YYYY-MM-DD HH:mm:ss as Pacific time", () => {
    const date = parsePacificTimestamp("2016-12-16 11:05:00");
    // December → PST (-08:00)
    expect(date?.toISOString()).toBe("2016-12-16T19:05:00.000Z");
  });

  it("passes through ISO 8601 with an explicit offset", () => {
    const date = parsePacificTimestamp("2022-04-20T23:46:41.7786361-07:00");
    expect(date?.toISOString()).toBe("2022-04-21T06:46:41.778Z");
  });

  it("parses epoch seconds and millis", () => {
    expect(parsePacificTimestamp("1000000000")?.toISOString()).toBe("2001-09-09T01:46:40.000Z");
    expect(parsePacificTimestamp("1000000000000")?.toISOString()).toBe("2001-09-09T01:46:40.000Z");
  });

  it("returns undefined for garbage", () => {
    expect(parsePacificTimestamp("not a date")).toBeUndefined();
    expect(parsePacificTimestamp("")).toBeUndefined();
    expect(parsePacificTimestamp(undefined)).toBeUndefined();
  });
});

describe("toTimestamp", () => {
  it("returns raw plus iso when parseable", () => {
    expect(toTimestamp("2/22/2012 17:24:35")).toEqual({
      raw: "2/22/2012 17:24:35",
      iso: "2012-02-23T01:24:35.000Z",
    });
  });

  it("returns raw only when unparseable", () => {
    expect(toTimestamp("garbage")).toEqual({ raw: "garbage" });
  });

  it("returns undefined for empty input", () => {
    expect(toTimestamp("")).toBeUndefined();
    expect(toTimestamp(undefined)).toBeUndefined();
  });
});

describe("Pacific DST edges", () => {
  const iso = (raw: string): string | undefined => toTimestamp(raw)?.iso;

  // Wall-clock parsing goes through Intl with America/Los_Angeles, so none of these depend
  // on the host timezone (verified under TZ unset, UTC and Asia/Tokyo).
  describe("fall-back 2026-11-01 (01:00-02:00 occurs twice)", () => {
    // Observed behaviour: the repeated hour resolves to the FIRST (PDT, -07:00)
    // occurrence, i.e. 01:30 PDT = 08:30Z, not 01:30 PST = 09:30Z.
    it("resolves the ambiguous M/D/YYYY wall time to the first (PDT) occurrence", () => {
      expect(iso("11/01/2026 01:30:00")).toBe("2026-11-01T08:30:00.000Z");
    });

    it("resolves the ambiguous YYYY-MM-DD wall time to the first (PDT) occurrence", () => {
      expect(iso("2026-11-01 01:30:00")).toBe("2026-11-01T08:30:00.000Z");
    });

    it("applies PDT up to 00:59:59 and PST from 02:00:00", () => {
      expect(iso("2026-11-01 00:59:59")).toBe("2026-11-01T07:59:59.000Z");
      expect(iso("2026-11-01 02:00:00")).toBe("2026-11-01T10:00:00.000Z");
    });
  });

  describe("spring-forward 2026-03-08 (02:00-03:00 does not exist)", () => {
    // Observed behaviour: a nonexistent wall time is resolved with the PDT (-07:00) offset,
    // so 02:30 maps to 09:30Z (which renders as 01:30 PST on the wall).
    it("maps the nonexistent 02:30 using the PDT offset", () => {
      expect(iso("2026-03-08 02:30:00")).toBe("2026-03-08T09:30:00.000Z");
    });

    it("applies PST up to 01:59:59 and PDT from 03:00:00", () => {
      expect(iso("2026-03-08 01:59:59")).toBe("2026-03-08T09:59:59.000Z");
      expect(iso("2026-03-08 03:00:00")).toBe("2026-03-08T10:00:00.000Z");
    });
  });

  describe("accepted input formats", () => {
    it("parses M/D/YYYY H:mm without seconds", () => {
      expect(iso("3/8/2026 2:30")).toBe("2026-03-08T09:30:00.000Z");
    });

    it("parses a T-separated offset-less ISO wall time as Pacific", () => {
      expect(iso("2026-03-08T02:30:00")).toBe("2026-03-08T09:30:00.000Z");
    });

    it("keeps ISO 8601 with Z or an explicit offset as-is", () => {
      expect(iso("2026-11-01T01:30:00Z")).toBe("2026-11-01T01:30:00.000Z");
      expect(iso("2026-11-01T01:30:00-07:00")).toBe("2026-11-01T08:30:00.000Z");
    });

    it("parses epoch seconds and millis", () => {
      expect(iso("1793521800")).toBe("2026-11-01T08:30:00.000Z");
      expect(iso("1793521800000")).toBe("2026-11-01T08:30:00.000Z");
    });
  });

  it("formatPacificWallClock renders both sides of the fall-back hour", () => {
    expect(formatPacificWallClock(new Date("2026-11-01T08:30:00Z"))).toBe("2026-11-01 01:30:00");
    expect(formatPacificWallClock(new Date("2026-11-01T09:30:00Z"))).toBe("2026-11-01 01:30:00");
  });

  it("parsePacificTimestamp exposes the same instants as toTimestamp", () => {
    expect(parsePacificTimestamp("11/01/2026 01:30:00")?.toISOString()).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });
});
