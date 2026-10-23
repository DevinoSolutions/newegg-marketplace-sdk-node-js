import {
  chmodSync,
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
import { FileOperationStore, OperationStoreFileError } from "../src/server/file-operation-store.js";

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
  it("steals a lock left by a process that no longer exists", async () => {
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const store = new FileOperationStore(file, { lockTimeoutMs: 2000 });
    await store.put(KEY, op("a1"));
    expect((await store.get(KEY))?.requestIds).toEqual(["a1"]);
    expect(readdirSync(dir)).toEqual(["operations.json"]);
  });

  it("fails closed, naming the lock file, when a live process holds it past the timeout", async () => {
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const store = new FileOperationStore(file, { lockTimeoutMs: 150 });
    const attempt = store.put(KEY, op("a1"));
    await expect(attempt).rejects.toThrow(OperationStoreFileError);
    await expect(attempt).rejects.toThrow(/lock/i);
    // Nothing was written.
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
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
