import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadMcpConfigFromEnv } from "../src/index.js";
import { previewKeyFor } from "../src/tools/preview-hash.js";
import { makeEnv, SENTINELS } from "./helpers.js";

// T-6215: JSON.stringify was redacted, but util.inspect (console.error(config), debuggers, error
// reporters) printed the raw credentials, bearer token and HMAC key.

const BEARER = "9f2c4e6a1b7d3085c2e49a6f01d8b37e5a4c9d20f6b18e73a0c5d4b92e6f1a37";
const HMAC_KEY = "c41e7a90d2b6385f1a7c0e94b3d82f65e0a9b7c4d1f2863a5e0c97b4d2a18f6e";

const config = loadMcpConfigFromEnv(
  makeEnv({
    NEWEGG_MCP_ALLOW_WRITES: "true",
    NEWEGG_MCP_HTTP_BEARER_TOKEN: BEARER,
    NEWEGG_MCP_PREVIEW_HMAC_KEY: HMAC_KEY,
  }),
);

const SECRETS = [
  SENTINELS.sellerId,
  SENTINELS.apiKey,
  SENTINELS.secretKey,
  BEARER,
  HMAC_KEY,
] as const;

function expectClean(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("the config never reveals secrets when printed (T-6215)", () => {
  it.each([
    ["default options", {}],
    ["unlimited depth", { depth: null }],
    ["showHidden", { depth: null, showHidden: true }],
    ["customInspect off", { depth: null, showHidden: true, customInspect: false }],
    ["colors", { depth: null, colors: true }],
  ])("util.inspect with %s", (_label, options) => {
    expectClean(inspect(config, options));
  });

  it("util.format %o / %O / %s and console-style formatting", () => {
    expectClean(format("%o", config));
    expectClean(format("%O", config));
    expectClean(format("%s", config));
    expectClean(format("config:", config));
  });

  it("each secret holder on its own", () => {
    for (const part of [config.credentials, config.previewIntegrity, config.http]) {
      expectClean(inspect(part, { depth: null, showHidden: true }));
      expectClean(JSON.stringify(part));
    }
  });

  it("JSON.stringify of the whole config and of the http section", () => {
    expectClean(JSON.stringify(config));
    expectClean(JSON.stringify(config.http));
  });

  it("an object spread of the config does not print secrets either", () => {
    expectClean(inspect({ ...config }, { depth: null, showHidden: true }));
  });

  it("still hands the raw values to the code that needs them", () => {
    expect(config.credentials.sellerId).toBe(SENTINELS.sellerId);
    expect(config.credentials.apiKey).toBe(SENTINELS.apiKey);
    expect(config.credentials.secretKey).toBe(SENTINELS.secretKey);
    expect(config.http.bearerToken).toBe(BEARER);
    expect(config.previewIntegrity?.hmacKey).toBe(HMAC_KEY);
    expect(previewKeyFor(config).equals(Buffer.from(HMAC_KEY, "utf8"))).toBe(true);
  });

  it("keeps the non-secret settings visible", () => {
    const text = inspect(config, { depth: null });
    expect(text).toContain("marketplace");
    expect(text).toContain("127.0.0.1");
  });

  // T-6468: `{ ...config.http }` is plain data and cannot carry the redacting toJSON, so it holds the
  // raw token. Hiding the token from spreads (non-enumerable) would silently DROP it from such a copy
  // and turn an embedder's HTTP auth off, so the copy keeps it on purpose; treat it as a secret holder.
  it("a spread copy of config.http keeps the bearer token, so auth is never silently dropped", () => {
    expect({ ...config.http }.bearerToken).toBe(BEARER);
  });
});
