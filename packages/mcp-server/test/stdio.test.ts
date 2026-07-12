import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { enabledToolNames, loadMcpConfigFromEnv } from "../src/index.js";
import { makeEnv } from "./helpers.js";

/**
 * The ONE test that exercises the production transport. Every other MCP test uses the InMemory
 * transport; stdio is what ships. It spawns the built `dist/cli.js` as a real child process and
 * drives it through the actual MCP SDK client (initialize + tools/list).
 *
 * Two guarantees are asserted at once:
 *  - The stdio server advertises exactly the same tool set the in-process factory does
 *    (`enabledToolNames`), so a transport-wiring regression can't silently drop or add tools.
 *  - stdout carries ONLY JSON-RPC frames. This needs no separate assertion: a single stray byte
 *    on stdout (a rogue console.log, a startup banner) corrupts the framing and makes either the
 *    initialize handshake or tools/list throw. A clean round-trip IS the proof — server logs go
 *    to stderr, as the transport requires.
 *
 * Skips (does not fail) when `dist/cli.js` is absent, so `npm test` without a prior build is not
 * a red herring. CI's test job depends on `build` and unpacks the dist bundle, so it runs there.
 */
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("stdio transport (built dist/cli.js)", () => {
  it("serves initialize + tools/list over stdio, matching the in-process tool set", async (ctx) => {
    if (!existsSync(CLI_PATH)) {
      ctx.skip(); // run `npm run build` first — CI does this via the dist artifact.
      return;
    }

    // Default env: sentinel credentials, marketplace "ca", writes DISABLED (no
    // NEWEGG_MCP_ALLOW_WRITES). listTools is a local operation — no network call is made, so
    // the sentinel credentials are never exercised against Newegg.
    const env = makeEnv();
    const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value;
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH],
      env: childEnv,
      stderr: "ignore", // discard the server's stderr JSON logs; keep test output clean.
    });
    const client = new Client({ name: "stdio-test-client", version: "0.0.0" });

    try {
      await client.connect(transport); // performs the MCP initialize handshake over stdout.
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();

      const expected = enabledToolNames(loadMcpConfigFromEnv(env)).sort();
      expect(names).toEqual(expected);
      // Read-only by default: the single mutating tool must not be advertised.
      expect(names).not.toContain("newegg_inventory_apply_update");
      expect(names).toContain("newegg_inventory_get");
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000); // generous: spawning node + loading the MCP SDK can be slow on a cold CI runner.
});
