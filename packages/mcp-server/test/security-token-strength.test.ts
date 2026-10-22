import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { weakBearerTokenReason } from "../src/config/index.js";
import { loadMcpConfigFromEnv, McpConfigError } from "../src/index.js";
import { makeEnv } from "./helpers.js";

// T-6215: length plus a distinct-character count let patterned secrets through ("abcdefghijkl" x 3,
// keyboard rows, ascending runs). The rule now also estimates how much of the token is predictable.

/** Weak secrets that were accepted before T-6215 (each is 32+ characters with 12+ distinct ones). */
const PATTERNED: Array<[label: string, token: string]> = [
  ["a 12-character alphabet repeated", "abcdefghijkl".repeat(3)],
  ["a 13-character unit repeated", "x7Kp2mQ9Zr4Tb".repeat(3)],
  ["ascending digit and letter runs", "0123456789abcdefghijklmnopqrstuv"],
  ["descending letter runs", "zyxwvutsrqponmlkjihgfedcba9876543210"],
  ["the keyboard rows", "qwertyuiopasdfghjklzxcvbnm1234567890"],
  ["the keyboard rows backwards", "poiuytrewqlkjhgfdsamnbvcxz0987654321"],
];

const KEY_VARIABLES = ["NEWEGG_MCP_HTTP_BEARER_TOKEN", "NEWEGG_MCP_PREVIEW_HMAC_KEY"] as const;

function loadWith(name: (typeof KEY_VARIABLES)[number], value: string): unknown {
  return loadMcpConfigFromEnv(makeEnv({ [name]: value }));
}

describe("patterned secrets are refused (T-6215)", () => {
  for (const name of KEY_VARIABLES) {
    it.each(PATTERNED)(`${name} rejects %s without echoing it`, (_label, weak) => {
      let thrown: unknown;
      try {
        loadWith(name, weak);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpConfigError);
      const message = (thrown as Error).message;
      expect(message).toContain(name);
      expect(message).not.toContain(weak);
      expect(message).toContain("--generate-token");
    });
  }

  it("still names the length rule first for a short secret", () => {
    expect(weakBearerTokenReason("short")).toMatch(/at least 32 characters/);
  });
});

/** Deterministic stand-ins for `openssl rand` output: sha-256 of a counter, in the same encodings. */
function sample(index: number, bytes: number): Buffer {
  const out: Buffer[] = [];
  for (let block = 0; out.length * 32 < bytes; block += 1) {
    out.push(createHash("sha256").update(`t-6215:${index}:${block}`).digest());
  }
  return Buffer.concat(out).subarray(0, bytes);
}

describe("generated secrets are never refused (T-6215)", () => {
  const SAMPLES = 20_000;
  const formats: Array<[label: string, make: (index: number) => string]> = [
    ["openssl rand -hex 32", (index) => sample(index, 32).toString("hex")],
    ["openssl rand -hex 16", (index) => sample(index, 16).toString("hex")],
    ["openssl rand -base64 32", (index) => sample(index, 32).toString("base64")],
    ["openssl rand -base64 24", (index) => sample(index, 24).toString("base64")],
    ["base64url of 32 bytes", (index) => sample(index, 32).toString("base64url")],
  ];

  it.each(formats)("accepts %s output", (_label, make) => {
    const rejected: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      if (weakBearerTokenReason(make(index)) !== undefined) rejected.push(index);
    }
    expect(rejected).toEqual([]);
  });
});
