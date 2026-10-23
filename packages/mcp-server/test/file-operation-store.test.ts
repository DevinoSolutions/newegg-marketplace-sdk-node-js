import { open as fsOpen } from "node:fs/promises";
import { hostname } from "node:os";
import {
  chmodSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredOperation } from "@devino/newegg-marketplace-sdk";
import {
  FileOperationStore,
  fileSecurityProblem,
  OperationStoreFileError,
  releaseStoreLock,
} from "../src/server/file-operation-store.js";

// T-6280: the label-create duplicate ledger survives a restart in an operator-chosen file. The file
// holds only keys, states, payload hashes, attempt ids and timestamps; never a credential.

const KEY = "label-create:ca:900000001";
const HOUR = 3_600_000;
const posix = process.platform !== "win32";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "newegg-op-store-"));
  file = join(dir, "operations.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function op(
  id: string,
  state: StoredOperation["state"] = "submitting",
  updatedAt = new Date().toISOString(),
): StoredOperation {
  return { state, payloadHash: "hash-" + id, requestIds: [id], updatedAt };
}

describe("FileOperationStore persistence", () => {
  it("starts empty when the file does not exist yet, and creates it on the first write", async () => {
    const store = new FileOperationStore(file);
    expect(await store.get(KEY)).toBeUndefined();
    await store.put(KEY, op("a1"));
    expect(statSync(file).isFile()).toBe(true);
  });

  it("replays a record in a second instance over the same file (a restart)", async () => {
    const first = new FileOperationStore(file);
    const record = op("a1", "submitted");
    await first.put(KEY, record);
    const second = new FileOperationStore(file);
    expect(await second.get(KEY)).toEqual(record);
  });

  it("sees a write made by another instance without being reopened", async () => {
    const a = new FileOperationStore(file);
    const b = new FileOperationStore(file);
    await a.put(KEY, op("a1"));
    expect((await b.get(KEY))?.requestIds).toEqual(["a1"]);
  });

  it("keeps other keys when one is written", async () => {
    const store = new FileOperationStore(file);
    await store.put("label-create:ca:1", op("a1"));
    await store.put("label-create:ca:2", op("a2"));
    expect((await store.get("label-create:ca:1"))?.requestIds).toEqual(["a1"]);
    expect((await store.get("label-create:ca:2"))?.requestIds).toEqual(["a2"]);
  });

  it("writes through a temp file and leaves no temp or lock file behind", async () => {
    const store = new FileOperationStore(file);
    await store.put(KEY, op("a1"));
    await store.put(KEY, op("a2"));
    expect(readdirSync(dir)).toEqual(["operations.json"]);
  });

  it.runIf(posix)("creates the file readable and writable by its owner only (0600)", async () => {
    const store = new FileOperationStore(file);
    await store.put(KEY, op("a1"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("stores no credential or anything but operation records", async () => {
    const store = new FileOperationStore(file);
    await store.put(KEY, op("a1"));
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      operations: { [KEY]: expect.objectContaining({ state: "submitting" }) },
    });
    expect(text).not.toMatch(/secret|apikey|sellerid|token/i);
  });

  it("drops records older than the longest guard window (31 days) when it writes", async () => {
    const store = new FileOperationStore(file);
    const old = new Date(Date.now() - 31 * 24 * HOUR - 1000).toISOString();
    await store.put("label-create:ca:old", op("old", "submitted", old));
    await store.put(KEY, op("a1"));
    expect(await store.get("label-create:ca:old")).toBeUndefined();
    expect(await store.get(KEY)).toBeDefined();
  });

  it("keeps a record with an unparseable timestamp (fails closed)", async () => {
    const store = new FileOperationStore(file);
    await store.put("label-create:ca:odd", op("odd", "submitting", "not a date"));
    await store.put(KEY, op("a1"));
    expect(await store.get("label-create:ca:odd")).toBeDefined();
  });
});

describe("FileOperationStore fails closed on a bad file", () => {
  const bad: Array<[label: string, content: string]> = [
    ["not JSON", "this is { not json"],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["an unknown version", JSON.stringify({ version: 2, operations: {} })],
    ["no operations object", JSON.stringify({ version: 1 })],
    ["operations as an array", JSON.stringify({ version: 1, operations: [] })],
    [
      "a record with an unknown state",
      JSON.stringify({
        version: 1,
        operations: {
          [KEY]: { state: "weird", payloadHash: "h", updatedAt: "2026-10-22T00:00:00Z" },
        },
      }),
    ],
    [
      "a record without a timestamp",
      JSON.stringify({
        version: 1,
        operations: { [KEY]: { state: "submitting", payloadHash: "h" } },
      }),
    ],
    [
      "a record with non-string attempt ids",
      JSON.stringify({
        version: 1,
        operations: {
          [KEY]: {
            state: "submitting",
            payloadHash: "h",
            requestIds: [1],
            updatedAt: "2026-10-22T00:00:00Z",
          },
        },
      }),
    ],
  ];

  it.each(bad)("refuses to open %s instead of starting empty", (_label, content) => {
    writeFileSync(file, content);
    expect(() => new FileOperationStore(file)).toThrow(OperationStoreFileError);
    expect(() => new FileOperationStore(file)).toThrow(/NEWEGG_MCP_OPERATION_STORE_FILE/);
  });

  it("names what to do and never echoes the file content", () => {
    writeFileSync(file, "SECRET-LOOKING-CONTENT { nope");
    let message = "";
    try {
      new FileOperationStore(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid|corrupt|unreadable/i);
    expect(message).not.toContain("SECRET-LOOKING-CONTENT");
  });

  it("rejects every read and write when the file turns corrupt after opening", async () => {
    const store = new FileOperationStore(file);
    await store.put(KEY, op("a1"));
    writeFileSync(file, "{ truncated");
    await expect(store.get(KEY)).rejects.toThrow(OperationStoreFileError);
    await expect(store.put(KEY, op("a2"))).rejects.toThrow(OperationStoreFileError);
    await expect(store.compareAndPut(KEY, undefined, op("a3"))).rejects.toThrow(
      OperationStoreFileError,
    );
    // The bad file was not overwritten.
    expect(readFileSync(file, "utf8")).toBe("{ truncated");
  });

  it("refuses a path that is a directory", () => {
    mkdirSync(join(dir, "adir"));
    expect(() => new FileOperationStore(join(dir, "adir"))).toThrow(OperationStoreFileError);
  });

  it("refuses a file in a directory that does not exist", () => {
    expect(() => new FileOperationStore(join(dir, "missing", "ops.json"))).toThrow(
      OperationStoreFileError,
    );
  });

  it.runIf(posix)("refuses a file that other users can write to", () => {
    writeFileSync(file, JSON.stringify({ version: 1, operations: {} }), { mode: 0o666 });
    // writeFileSync honours the umask, so force the bits.
    chmodSync(file, 0o666);
    expect(() => new FileOperationStore(file)).toThrow(/writable by other users/);
  });
});

describe("FileOperationStore.compareAndPut", () => {
  it("writes only while the stored record is still the expected one", async () => {
    const store = new FileOperationStore(file);
    const first = op("a1");
    expect(await store.compareAndPut(KEY, undefined, first)).toBe(true);
    expect(await store.compareAndPut(KEY, undefined, op("b1"))).toBe(false);
    expect(await store.get(KEY)).toEqual(first);
    const second = op("a1", "submitted");
    expect(await store.compareAndPut(KEY, { ...first }, second)).toBe(true);
    expect(await store.get(KEY)).toEqual(second);
  });

  it("lets exactly one of two instances on one file win a simultaneous claim", async () => {
    const a = new FileOperationStore(file);
    const b = new FileOperationStore(file);
    const results = await Promise.all([
      a.compareAndPut(KEY, undefined, op("a1")),
      b.compareAndPut(KEY, undefined, op("b1")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? "a1" : "b1";
    expect((await new FileOperationStore(file).get(KEY))?.requestIds).toEqual([winner]);
  });

  it("serialises many simultaneous writers without losing a record", async () => {
    const stores = Array.from({ length: 6 }, () => new FileOperationStore(file));
    await Promise.all(
      stores.map((store, index) => store.put(`label-create:ca:${index}`, op(`k${index}`))),
    );
    const reader = new FileOperationStore(file);
    for (let index = 0; index < stores.length; index++) {
      expect((await reader.get(`label-create:ca:${index}`))?.requestIds).toEqual([`k${index}`]);
    }
  });
});

describe("FileOperationStore lock", () => {
  beforeEach(() => {
    // An existing ledger, so a lock beside it is not read as "the file was lost".
    writeFileSync(file, JSON.stringify({ version: 1, operations: {} }), { mode: 0o600 });
  });

  const lockText = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      hostname: hostname(),
      pid: 2 ** 22 + 12345,
      startedAt: new Date().toISOString(),
      ...overrides,
    });

  it("never takes over an existing lock, even one whose pid is gone or that is old", async () => {
    const old = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
    writeFileSync(`${file}.lock`, lockText({ startedAt: old }));
    const store = new FileOperationStore(file, { lockTimeoutMs: 150 });
    await expect(store.put(KEY, op("a1"))).rejects.toThrow(OperationStoreFileError);
    await expect(store.compareAndPut(KEY, undefined, op("a1"))).rejects.toMatchObject({
      code: "lock",
    });
    // Nothing was written and the lock is untouched.
    expect(readdirSync(dir).sort()).toEqual(["operations.json", "operations.json.lock"]);
  });

  it("names the lock path and tells the operator to check no server is running", async () => {
    writeFileSync(`${file}.lock`, lockText({ pid: process.pid }));
    const store = new FileOperationStore(file, { lockTimeoutMs: 100 });
    let message = "";
    try {
      await store.put(KEY, op("a1"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`${file}.lock`);
    expect(message).toMatch(/no (newegg|server)/i);
    expect(message).toContain("--release-store-lock");
  });

  it("records hostname, pid and start time in the lock while it is held", async () => {
    let seen: unknown;
    const store = new FileOperationStore(file, {
      onLockHeld: () => {
        seen = JSON.parse(readFileSync(`${file}.lock`, "utf8"));
      },
    });
    await store.put(KEY, op("a1"));
    expect(seen).toEqual({
      hostname: hostname(),
      pid: process.pid,
      startedAt: expect.any(String),
    });
    expect(Number.isFinite(Date.parse((seen as { startedAt: string }).startedAt))).toBe(true);
    expect(readdirSync(dir)).toEqual(["operations.json"]);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a transient %s when creating the lock, then succeeds",
    async (code) => {
      let failures = 2;
      const store = new FileOperationStore(file, {
        lockTimeoutMs: 2000,
        openLockFile: async (path, flags, mode) => {
          if (failures-- > 0) throw Object.assign(new Error("transient"), { code });
          return fsOpen(path, flags, mode);
        },
      });
      await store.put(KEY, op("a1"));
      expect((await store.get(KEY))?.requestIds).toEqual(["a1"]);
    },
  );

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "reports a lock that stays %s as busy (code lock), not as unreadable",
    async (code) => {
      const store = new FileOperationStore(file, {
        lockTimeoutMs: 120,
        openLockFile: async () => {
          throw Object.assign(new Error("transient"), { code });
        },
      });
      const attempt = store.put(KEY, op("a1"));
      await expect(attempt).rejects.toMatchObject({ code: "lock" });
      await expect(attempt).rejects.toThrow(/busy|held/i);
    },
  );
});

describe("a lock that cannot be removed after the work", () => {
  it("reports that the write may have succeeded instead of masking it", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, operations: {} }), { mode: 0o600 });
    const store = new FileOperationStore(file, {
      removeLockFile: async () => {
        throw Object.assign(new Error("stuck"), { code: "EPERM" });
      },
    });
    const attempt = store.compareAndPut(KEY, undefined, op("a1"));
    await expect(attempt).rejects.toMatchObject({ code: "lock" });
    await expect(attempt).rejects.toThrow(/may have (succeeded|been written)/);
    await expect(attempt).rejects.toThrow(/Seller Portal/);
    // The claim really was written, and the lock is still there for the operator.
    expect(JSON.parse(readFileSync(file, "utf8")).operations[KEY]).toBeDefined();
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});

describe("releaseStoreLock (operator)", () => {
  const writeLock = (overrides: Record<string, unknown> = {}) =>
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        hostname: hostname(),
        pid: 2 ** 22 + 12345,
        startedAt: new Date().toISOString(),
        ...overrides,
      }),
    );

  it("reports none when there is no lock", async () => {
    expect(await releaseStoreLock(file)).toBe("none");
  });

  it("removes a lock whose host is this one and whose pid is not alive", async () => {
    writeLock();
    expect(await releaseStoreLock(file)).toBe("released");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("refuses a lock whose pid is alive on this host", async () => {
    writeLock({ pid: process.pid });
    await expect(releaseStoreLock(file)).rejects.toThrow(OperationStoreFileError);
    await expect(releaseStoreLock(file)).rejects.toThrow(/running/);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("refuses a lock taken on another host", async () => {
    writeLock({ hostname: `not-${hostname()}` });
    await expect(releaseStoreLock(file)).rejects.toThrow(/another host|--force/);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("refuses a lock it cannot parse", async () => {
    writeFileSync(`${file}.lock`, "garbage");
    await expect(releaseStoreLock(file)).rejects.toThrow(/--force/);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("--force removes any of those", async () => {
    writeLock({ pid: process.pid });
    expect(await releaseStoreLock(file, { force: true })).toBe("released");
    writeLock({ hostname: "elsewhere" });
    expect(await releaseStoreLock(file, { force: true })).toBe("released");
    writeFileSync(`${file}.lock`, "garbage");
    expect(await releaseStoreLock(file, { force: true })).toBe("released");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("requires an absolute path", async () => {
    await expect(releaseStoreLock("ledger.json")).rejects.toThrow(/absolute/);
  });
});

describe("FileOperationStore path and lost-file checks", () => {
  it("refuses a relative path without echoing it", () => {
    let message = "";
    try {
      new FileOperationStore("some/secret-ish/ledger.json");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/absolute/);
    expect(message).not.toContain("secret-ish");
  });

  it("refuses to start empty when the file is gone but an old lock is left beside it", () => {
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        hostname: hostname(),
        pid: 1,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    expect(() => new FileOperationStore(file)).toThrow(OperationStoreFileError);
    expect(() => new FileOperationStore(file)).toThrow(/lost|moved|deleted/i);
  });

  it("refuses to start empty when the file is gone but a temp file is left beside it", () => {
    const tmp = `${file}.4242.abcdef.tmp`;
    writeFileSync(tmp, "{}");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(tmp, old, old);
    expect(() => new FileOperationStore(file)).toThrow(/lost|moved|deleted/i);
  });

  it("does not treat a lock dated in the future as fresh (clock skew beyond 5 s)", () => {
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        hostname: hostname(),
        pid: 1,
        startedAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect(() => new FileOperationStore(file)).toThrow(/lost|moved|deleted/i);
  });

  it("still treats a lock dated a couple of seconds ahead as fresh (small skew)", () => {
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        hostname: hostname(),
        pid: 1,
        startedAt: new Date(Date.now() + 2_000).toISOString(),
      }),
    );
    expect(() => new FileOperationStore(file)).not.toThrow();
  });

  it("accepts a fresh temp file beside a missing file (a first run writing right now)", () => {
    writeFileSync(`${file}.4242.abcdef.tmp`, "{}");
    expect(() => new FileOperationStore(file)).not.toThrow();
  });

  it("accepts a fresh lock beside a missing file (a first run in progress)", () => {
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({ hostname: hostname(), pid: 1, startedAt: new Date().toISOString() }),
    );
    expect(() => new FileOperationStore(file)).not.toThrow();
  });

  it("ignores leftovers of other files in the directory", () => {
    writeFileSync(join(dir, "other.json.lock"), "x");
    writeFileSync(join(dir, "other.json.1.aa.tmp"), "x");
    expect(() => new FileOperationStore(file)).not.toThrow();
  });
});

describe("orphan temp files", () => {
  it("removes this file's temp files older than an hour when it opens, and keeps younger ones", async () => {
    await new FileOperationStore(file).put(KEY, op("a1"));
    const oldTmp = `${file}.111.aaaaaa.tmp`;
    const youngTmp = `${file}.222.bbbbbb.tmp`;
    const otherTmp = join(dir, "other.json.333.cccccc.tmp");
    for (const path of [oldTmp, youngTmp, otherTmp]) writeFileSync(path, "{}");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    utimesSync(otherTmp, twoHoursAgo, twoHoursAgo);
    new FileOperationStore(file);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(youngTmp)).toBe(true);
    expect(existsSync(otherTmp)).toBe(true);
    expect((await new FileOperationStore(file).get(KEY))?.requestIds).toEqual(["a1"]);
  });
});

describe("fileSecurityProblem (POSIX ownership and permissions)", () => {
  const file0 = { mode: 0o100600, uid: 1000 };
  const dir0 = { mode: 0o040700, uid: 1000 };

  it("accepts an owned 0600 file in a private directory", () => {
    expect(fileSecurityProblem(file0, dir0, 1000)).toBeUndefined();
  });

  it("rejects a file owned by someone else", () => {
    expect(fileSecurityProblem({ ...file0, uid: 0 }, dir0, 1000)).toMatch(/owned by another user/);
  });

  it("rejects a group- or other-writable file", () => {
    expect(fileSecurityProblem({ ...file0, mode: 0o100620 }, dir0, 1000)).toMatch(/writable/);
    expect(fileSecurityProblem({ ...file0, mode: 0o100602 }, dir0, 1000)).toMatch(/writable/);
  });

  it("rejects an other-writable directory without the sticky bit, accepts it with", () => {
    expect(fileSecurityProblem(file0, { ...dir0, mode: 0o040777 }, 1000)).toMatch(/directory/);
    expect(fileSecurityProblem(file0, { ...dir0, mode: 0o041777 }, 1000)).toBeUndefined();
  });

  it("does nothing when there are no POSIX owners (Windows)", () => {
    expect(
      fileSecurityProblem({ mode: 0o100666, uid: 0 }, { mode: 0o040777, uid: 0 }, undefined),
    ).toBeUndefined();
  });

  it.runIf(posix)("refuses a real store file in an other-writable, non-sticky directory", () => {
    const open = join(dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(() => new FileOperationStore(join(open, "ops.json"))).toThrow(/directory/);
  });
});

describe("FileOperationStore.remove (operator clear)", () => {
  it("removes one record and reports whether it existed", async () => {
    const store = new FileOperationStore(file);
    await store.put(KEY, op("a1"));
    await store.put("label-create:ca:2", op("a2"));
    expect(await store.remove(KEY)).toBe(true);
    expect(await store.remove(KEY)).toBe(false);
    expect(await new FileOperationStore(file).get(KEY)).toBeUndefined();
    expect(await new FileOperationStore(file).get("label-create:ca:2")).toBeDefined();
  });

  it("does not create the file when there is nothing to remove", async () => {
    const store = new FileOperationStore(file);
    expect(await store.remove(KEY)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
