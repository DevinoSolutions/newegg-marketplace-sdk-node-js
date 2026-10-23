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
/** Rounds raced at once; every child of a batch waits for the same wall-clock instant. */
const BATCH = 25;
const BARRIER_MS = 3_000;

const CHILD = `
const [file, startAt, id, moduleUrl, lockTimeoutMs] = process.argv.slice(1);
(async () => {
  const { FileOperationStore } = await import(moduleUrl);
  const store = new FileOperationStore(file, { lockTimeoutMs: Number(lockTimeoutMs) });
  const op = { state: "submitting", payloadHash: "h" + id, requestIds: [id], updatedAt: new Date().toISOString() };
  while (Date.now() < Number(startAt)) { /* spin until the shared start instant */ }
  try {
    const ok = await store.compareAndPut(${JSON.stringify(KEY)}, undefined, op);
    process.stdout.write(JSON.stringify({ id, ok }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, err: String(error && error.code) }));
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ id, crash: String(error && error.message).slice(0, 200) }));
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

function runChild(file: string, startAt: number, id: string, lockTimeoutMs: number) {
  return new Promise<Outcome>((resolve) => {
    const child = spawn(
      process.execPath,
      ["-e", CHILD, file, String(startAt), id, pathToFileURL(STORE_MODULE.pathname.replace(/^\/([A-Za-z]:)/, "$1")).href, String(lockTimeoutMs)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out) as Outcome);
      } catch {
        resolve({ id, crash: `exit ${code}: ${out.slice(0, 100)} ${err.slice(0, 200)}` });
      }
    });
  });
}

/** Races `PROCESSES` children over a fresh store file in each of `rounds` directories at once. */
async function race(rounds: number, stale: boolean) {
  const startAt = Date.now() + BARRIER_MS;
  const roundDirs = Array.from({ length: rounds }, () => {
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
    return { dir, file };
  });
  const results = await Promise.all(
    roundDirs.map(async ({ file }) =>
      Promise.all(
        Array.from({ length: PROCESSES }, (_, k) =>
          runChild(file, startAt, `p${k}`, stale ? 300 : 20_000),
        ),
      ),
    ),
  );
  return roundDirs.map(({ dir, file }, index) => ({ dir, file, outcomes: results[index] ?? [] }));
}

async function raceAll(iterations: number, stale: boolean) {
  const all: Array<Awaited<ReturnType<typeof race>>[number]> = [];
  for (let done = 0; done < iterations; done += BATCH) {
    all.push(...(await race(Math.min(BATCH, iterations - done), stale)));
  }
  return all;
}

describe("FileOperationStore across real processes", () => {
  it("the compiled store is present (run npm run build first)", () => {
    expect(existsSync(STORE_MODULE)).toBe(true);
  });

  it(
    `exactly one of ${PROCESSES} processes wins the claim, in each of ${ITERATIONS} rounds`,
    async () => {
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
    },
    90_000,
  );

  it(
    `with a lock already present nobody wins and everybody fails closed, in each of ${ITERATIONS} rounds`,
    async () => {
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
    },
    90_000,
  );
});
