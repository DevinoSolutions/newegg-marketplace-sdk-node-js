import { describe, expect, it } from "vitest";
import { defaultLogger } from "../src/index.js";
import { redactLogText } from "../src/tools/log-redact.js";
import { makeMockClient, startHarness, callTool } from "./helpers.js";

// T-5667 (L3): the unexpected-error log line (and the default logger) must not carry URL
// credentials or query strings such as ?sellerid=.

const LEAKY =
  "fetch failed https://x.example/y?sellerid=SECRET-SELLER&token=SECRET-TOKEN ftp://u:p4ss@h.example/z";

function expectClean(serialized: string): void {
  expect(serialized).not.toContain("SECRET-SELLER");
  expect(serialized).not.toContain("SECRET-TOKEN");
  expect(serialized).not.toContain("p4ss");
  expect(serialized).not.toContain("u:p");
}

describe("log redaction stays linear on adversarial input (CodeQL polynomial-redos)", () => {
  const timeMs = (input: string): number => {
    const started = performance.now();
    redactLogText(input);
    return performance.now() - started;
  };

  it("handles repeated scheme separators, question marks and long runs in linear time", () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ["a://", (size) => "a://".repeat(size / 4)],
      ["a://x", (size) => "a://x".repeat(size / 5)],
      ["?", (size) => "?".repeat(size)],
      ["http://?", (size) => "http://?".repeat(size / 8)],
      ["http:// x?", (size) => `http://${"a".repeat(size)}`],
      ["a", (size) => "a".repeat(size)],
    ];
    for (const [name, make] of shapes) {
      timeMs(make(20_000)); // warm up
      const small = Math.max(timeMs(make(100_000)), 5);
      const large = timeMs(make(800_000));
      expect(large, name).toBeLessThan(small * 24);
      expect(large, name).toBeLessThan(500);
    }
  });

  it("still redacts the query of each of many URLs and leaves other text alone", () => {
    const url = "https://x.example/y?sellerid=SECRET-SELLER";
    const out = redactLogText(`${url} and ${url}#frag \"${url}\" no query https://h.example/p`);
    expect(out).not.toContain("SECRET-SELLER");
    expect(out.match(/\?\[redacted\]/g)).toHaveLength(3);
    expect(out).toContain("https://h.example/p");
    expect(redactLogText("failed at 12:30 with code: 17?")).toBe("failed at 12:30 with code: 17?");
  });
});

describe("unexpected tool errors are logged redacted (T-5667 / L3)", () => {
  it("strips credentials and query strings from the logged message and stack", async () => {
    const { client } = makeMockClient([]);
    client.service.getStatus = () => {
      throw new TypeError(LEAKY);
    };
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const harness = await startHarness({
      client,
      logger: (_level, event, fields) => logged.push({ event, fields }),
    });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", {});
      expect(res.isError).toBe(true);
      expect(res.json.message).toBe("internal error");
      const entry = logged.find((line) => line.event === "unexpected_tool_error");
      expect(entry).toBeDefined();
      expectClean(JSON.stringify(entry));
      expect(String(entry?.fields?.message)).toContain("https://x.example/y");
      expect(String(entry?.fields?.stack)).toContain("TypeError");
      expectClean(res.text);
    } finally {
      await harness.close();
    }
  });

  it("the default logger redacts every string field before it reaches stderr", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      defaultLogger("error", "anything", { message: LEAKY, nested: { url: LEAKY }, count: 3 });
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(1);
    expectClean(lines[0] ?? "");
    expect(lines[0]).toContain('"count":3');
  });
});
