import { describe, expect, it } from "vitest";
import { parsePacificTimestamp, toTimestamp } from "../src/platform/dates.js";

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
