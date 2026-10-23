import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCliArgs } from "../src/cli.js";
import { FileOperationStore } from "../src/server/file-operation-store.js";
import { makeEnv } from "./helpers.js";

// T-6280: the operator-only way to clear a label-create guard record is a CLI command on the host,
// never a tool. These tests cover its argument parsing and its run through `main`.

const ORDER = "900000002";
const KEY = `label-create:ca:${ORDER}`;

let dir: string;
let file: string;
let errors: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "newegg-cli-clear-"));
  file = join(dir, "operations.json");
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function stubEnv(extra: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(makeEnv(extra))) {
    vi.stubEnv(name, value);
  }
}

async function seed(): Promise<void> {
  await new FileOperationStore(file).put(KEY, {
    state: "submitting",
    payloadHash: "h",
    requestIds: ["a1"],
    updatedAt: new Date().toISOString(),
  });
}

describe("parseCliArgs --clear-label-guard", () => {
  it("takes a marketplace and an order number", () => {
    expect(parseCliArgs(["--clear-label-guard", "ca", ORDER]).clearLabelGuard).toEqual({
      marketplace: "ca",
      orderNumber: ORDER,
    });
  });

  it("normalizes the marketplace like the config does (case, 'can' alias)", () => {
    expect(parseCliArgs(["--clear-label-guard", "CAN", ORDER]).clearLabelGuard?.marketplace).toBe(
      "ca",
    );
    expect(parseCliArgs(["--clear-label-guard", "US", ORDER]).clearLabelGuard?.marketplace).toBe(
      "us",
    );
  });

  it("is absent by default", () => {
    expect(parseCliArgs([]).clearLabelGuard).toBeUndefined();
  });

  it.each([
    [["--clear-label-guard"]],
    [["--clear-label-guard", "ca"]],
    [["--clear-label-guard", "mars", ORDER]],
    [["--clear-label-guard", "ca", "not-a-number"]],
    [["--clear-label-guard", "ca", "0"]],
    [["--clear-label-guard", "ca", "12345678901"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(/clear-label-guard/);
  });
});

describe("main --clear-label-guard", () => {
  it("clears the record from the configured file and exits 0 without needing credentials", async () => {
    await seed();
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    vi.stubEnv("NEWEGG_API_KEY", undefined);
    await main(["--clear-label-guard", "ca", ORDER]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(await new FileOperationStore(file).get(KEY)).toBeUndefined();
    expect(errors.join("\n")).toContain("label_guard_cleared");
  });

  it("exits 1 and says so when there is no such record", async () => {
    await seed();
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    await main(["--clear-label-guard", "ca", "900000003"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("label_guard_not_found");
    expect(await new FileOperationStore(file).get(KEY)).toBeDefined();
  });

  it("exits 1 when NEWEGG_MCP_OPERATION_STORE_FILE is not set", async () => {
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", "");
    await main(["--clear-label-guard", "ca", ORDER]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("NEWEGG_MCP_OPERATION_STORE_FILE");
  });

  it("exits 1 on a corrupt file and leaves it untouched", async () => {
    writeFileSync(file, "{ nope");
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    await main(["--clear-label-guard", "ca", ORDER]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("operation_store_error");
  });
});

describe("main startup with a bad operation store file", () => {
  it("refuses to start on a corrupt file (exit 1) instead of starting with an empty ledger", async () => {
    writeFileSync(file, "{ nope");
    stubEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: file, NEWEGG_MCP_ALLOW_WRITES: "true" });
    await main([]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("operation_store_error");
  });
});

describe("parseCliArgs --release-store-lock", () => {
  it("parses the flag and --force", () => {
    expect(parseCliArgs(["--release-store-lock"]).releaseStoreLock).toEqual({ force: false });
    expect(parseCliArgs(["--release-store-lock", "--force"]).releaseStoreLock).toEqual({
      force: true,
    });
    expect(parseCliArgs(["--force", "--release-store-lock"]).releaseStoreLock).toEqual({
      force: true,
    });
  });

  it("rejects --force on its own", () => {
    expect(() => parseCliArgs(["--force"])).toThrow(/--force/);
  });

  it("is absent by default", () => {
    expect(parseCliArgs([]).releaseStoreLock).toBeUndefined();
  });
});

describe("main --release-store-lock", () => {
  const lock = () => `${file}.lock`;
  const writeLock = (overrides: Record<string, unknown> = {}) =>
    writeFileSync(
      lock(),
      JSON.stringify({
        hostname: hostname(),
        pid: 2 ** 22 + 99,
        startedAt: new Date().toISOString(),
        ...overrides,
      }),
    );

  it("removes a dead local lock and exits 0 without credentials", async () => {
    await seed();
    writeLock();
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    await main(["--release-store-lock"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(lock())).toBe(false);
    expect(errors.join("\n")).toContain("store_lock_released");
  });

  it("refuses a live lock, exit 1, and --force overrides", async () => {
    await seed();
    writeLock({ pid: process.pid });
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    await main(["--release-store-lock"]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(lock())).toBe(true);
    process.exitCode = undefined;
    await main(["--release-store-lock", "--force"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(lock())).toBe(false);
  });

  it("exits 0 and says so when there is no lock", async () => {
    await seed();
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", file);
    await main(["--release-store-lock"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(errors.join("\n")).toContain("store_lock_absent");
  });

  it("exits 1 when the path is not set or not absolute", async () => {
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", "");
    await main(["--release-store-lock"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", "ledger.json");
    await main(["--release-store-lock"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/absolute/);
  });

  it("clear-label-guard also refuses a relative path", async () => {
    vi.stubEnv("NEWEGG_MCP_OPERATION_STORE_FILE", "ledger.json");
    await main(["--clear-label-guard", "ca", ORDER]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/absolute/);
  });
});
