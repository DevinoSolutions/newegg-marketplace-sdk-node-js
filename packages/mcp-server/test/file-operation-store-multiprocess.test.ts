import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * T-6280 review fix: REAL separate OS processes race for one claim on one store file. The store's
 * lock must give exactly one winner per round, and a lock that already exists (even one left by a
 * process that is gone) must make every contender fail closed instead of being taken over.
 *
 * The children load the compiled store (`dist`), so `npm run build` must have run first, as in CI.
 */
const STORE_MODULE = new URL("../dist/server/file-operation-store.js", import.meta.url);
const KEY = "label-create:ca:900000001";
const PROCESSES = 4;
const ITERATIONS = 50;
/**
 * Rounds raced at once. Kept small: this file shares the CI runner with every other test file, and a
 * crowd of children would starve them (the other files' 5 s timeouts, T-6280 round 2).
 */
const CONCURRENT_ROUNDS = 3;

/**
 * A child loads the store, says "ready", and then WAITS ON STDIN (no busy loop) for the parent's
 * "go", which the parent sends to all children of a round together, so the claims overlap.
 */
const CHILD = `
const [file, id, moduleUrl, lockTimeoutMs] = process.argv.slice(1);
(async () => {
  const { FileOperationStore } = await import(moduleUrl);
  const store = new FileOperationStore(file, { lockTimeoutMs: Number(lockTimeoutMs) });
  const op = { state: "submitting", payloadHash: "h" + id, requestIds: [id], updatedAt: new Date().toISOString() };
  process.stdout.write("ready\\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  try {
    const ok = await store.compareAndPut(${JSON.stringify(KEY)}, undefined, op);
    process.stdout.write("R" + JSON.stringify({ id, ok }));
  } catch (error) {
    process.stdout.write("R" + JSON.stringify({ id, err: String(error && error.code) }));
  }
  process.exit(0);
})().catch((error) => {
  process.stdout.write("R" + JSON.stringify({ id, crash: String(error && error.message).slice(0, 200) }));
  process.exit(0);
});
`;

interface Outcome {
  id: string;
  ok?: boolean;
  err?: string;
  crash?: string;
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Child {
  ready: Promise<void>;
  go: () => void;
  outcome: Promise<Outcome>;
}

function startChild(file: string, id: string, lockTimeoutMs: number): Child {
  const moduleUrl = pathToFileURL(STORE_MODULE.pathname.replace(/^\/([A-Za-z]:)/, "$1")).href;
  const child = spawn(process.execPath, ["-e", CHILD, file, id, moduleUrl, String(lockTimeoutMs)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes("ready" + String.fromCharCode(10))) markReady();
  });
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const outcome = new Promise<Outcome>((resolve) => {
    child.on("close", (code) => {
      markReady();
      const at = out.indexOf("R{");
      try {
        resolve(JSON.parse(out.slice(at + 1)) as Outcome);
      } catch {
        resolve({ id, crash: `exit ${code}: ${out.slice(0, 100)} ${err.slice(0, 200)}` });
      }
    });
  });
  return { ready, go: () => child.stdin.write("go" + String.fromCharCode(10)), outcome };
}

/** One round: a fresh store file (optionally with a stale lock beside it) and PROCESSES contenders. */
async function round(stale: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "newegg-mp-"));
  dirs.push(dir);
  const file = join(dir, "operations.json");
  if (stale) {
    // A lock a process left behind (its pid is not alive), beside an existing ledger file.
    writeFileSync(file, JSON.stringify({ version: 1, operations: {} }), { mode: 0o600 });
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        hostname: hostname(),
        pid: 2 ** 22 + 4242,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
  }
  const children = Array.from({ length: PROCESSES }, (_, k) =>
    startChild(file, `p${k}`, stale ? 100 : 20_000),
  );
  await Promise.all(children.map((child) => child.ready));
  for (const child of children) child.go();
  return { file, outcomes: await Promise.all(children.map((child) => child.outcome)) };
}

async function raceAll(iterations: number, stale: boolean) {
  const all: Array<Awaited<ReturnType<typeof round>>> = [];
  for (let done = 0; done < iterations; done += CONCURRENT_ROUNDS) {
    const size = Math.min(CONCURRENT_ROUNDS, iterations - done);
    all.push(...(await Promise.all(Array.from({ length: size }, () => round(stale)))));
  }
  return all;
}

describe("FileOperationStore across real processes", () => {
  it("the compiled store is present (run npm run build first)", () => {
    expect(existsSync(STORE_MODULE)).toBe(true);
  });

  it(`exactly one of ${PROCESSES} processes wins the claim, in each of ${ITERATIONS} rounds`, async () => {
    const rounds = await raceAll(ITERATIONS, false);
    expect(rounds).toHaveLength(ITERATIONS);
    for (const { file, outcomes } of rounds) {
      expect(outcomes.filter((o) => o.crash !== undefined)).toEqual([]);
      expect(outcomes.filter((o) => o.err !== undefined)).toEqual([]);
      const winners = outcomes.filter((o) => o.ok === true);
      expect(winners).toHaveLength(1);
      expect(outcomes.filter((o) => o.ok === false)).toHaveLength(PROCESSES - 1);
      // The recorded claim is the winner's, and no lock or temp file is left behind.
      const stored = JSON.parse(readFileSync(file, "utf8")) as {
        operations: Record<string, { requestIds: string[] }>;
      };
      expect(stored.operations[KEY]?.requestIds).toEqual([winners[0]?.id]);
      expect(existsSync(`${file}.lock`)).toBe(false);
    }
  }, 60_000);

  it(`with a lock already present nobody wins and everybody fails closed, in each of ${ITERATIONS} rounds`, async () => {
    const rounds = await raceAll(ITERATIONS, true);
    expect(rounds).toHaveLength(ITERATIONS);
    for (const { file, outcomes } of rounds) {
      expect(outcomes).toHaveLength(PROCESSES);
      expect(outcomes.filter((o) => o.crash !== undefined)).toEqual([]);
      expect(outcomes.filter((o) => o.ok !== undefined)).toEqual([]);
      expect(outcomes.every((o) => o.err === "lock")).toBe(true);
      // Nothing was claimed and the lock was left for the operator.
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, operations: {} });
      expect(existsSync(`${file}.lock`)).toBe(true);
    }
  }, 60_000);
});
