import { describe, expect, it } from "vitest";
import { defaultLogger } from "../src/index.js";
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
