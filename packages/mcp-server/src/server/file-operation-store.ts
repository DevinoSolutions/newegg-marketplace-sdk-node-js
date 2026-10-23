/**
 * A file-backed SDK `OperationStore` (T-6280), so the label-create duplicate ledger (T-6212)
 * survives a restart of the MCP server. Enabled by `NEWEGG_MCP_OPERATION_STORE_FILE`.
 *
 * - The file is `{ "version": 1, "operations": { "<key>": <StoredOperation> } }`. It holds the ledger
 *   keys (`label-create:<marketplace>:<order number>`), states, payload hashes, attempt ids and
 *   timestamps. It never holds a credential, a label link or customer data.
 * - Every write is atomic: a temp file in the same directory (created `0600`), `fsync`, `rename`
 *   over the target, then a best-effort `fsync` of the directory.
 * - It fails CLOSED. A file that is not valid JSON, has an unknown version or malformed records, is
 *   unreadable, or is writable by other users makes the store refuse to open (construction throws)
 *   or, once open, reject every read and write. It is never replaced by an empty ledger. A file that
 *   does not exist yet is the one empty case (first run).
 * - Writers take a lock file (`<file>.lock`, created with `O_EXCL`) around read-modify-write, so
 *   `compareAndPut` is atomic between processes on one host. A lock left by a process that no longer
 *   exists is taken over; a lock a live process keeps holding makes the operation fail after
 *   `lockTimeoutMs` with a message naming the lock file. The file must be on a local filesystem
 *   shared by processes of ONE host (no network file systems: their locking is not trustworthy).
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { OperationStore, StoredOperation } from "@devino/newegg-marketplace-sdk";

const FILE_VERSION = 1;

/** Records older than the longest guard window (30 days) plus a day are dropped on write. */
const MAX_RECORD_AGE_MS = 31 * 24 * 3_600_000;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 15;
/** A lock this old is taken over even if its pid looks alive (pid reuse, a hung holder). */
const LOCK_STALE_AFTER_MS = 60_000;
/** A lock file with unreadable content is taken over once it is this old (a crash mid-create). */
const LOCK_UNREADABLE_STALE_MS = 10_000;
const RENAME_RETRIES = 5;

const operationSchema = z.strictObject({
  state: z.enum(["submitting", "submitted", "failed"]),
  payloadHash: z.string(),
  requestIds: z.array(z.string()).optional(),
  updatedAt: z.string(),
});

const fileSchema = z.strictObject({
  version: z.literal(FILE_VERSION),
  operations: z.record(z.string(), operationSchema),
});

const ENV_NAME = "NEWEGG_MCP_OPERATION_STORE_FILE";

export type OperationStoreFileErrorCode =
  "corrupt" | "unreadable" | "unwritable" | "permissions" | "lock";

/** The operation store file cannot be trusted or used. Messages never contain file content. */
export class OperationStoreFileError extends Error {
  readonly code: OperationStoreFileErrorCode;

  constructor(code: OperationStoreFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationStoreFileError";
    this.code = code;
  }
}

export interface FileOperationStoreOptions {
  /** How long a write waits for the lock file before failing closed. Default 5000. */
  readonly lockTimeoutMs?: number;
  /** Called with every failure of an opened store (reads and writes), for server-side logging. */
  readonly onFailure?: (error: OperationStoreFileError) => void;
}

type Operations = Map<string, StoredOperation>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errnoOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

function sameOperation(a: StoredOperation | undefined, b: StoredOperation | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.state === b.state &&
    a.payloadHash === b.payloadHash &&
    a.updatedAt === b.updatedAt &&
    (a.requestIds ?? []).join("\n") === (b.requestIds ?? []).join("\n")
  );
}

function parseOperations(text: string, path: string): Operations {
  const guidance =
    `Refusing to continue with an empty ledger. Restore ${ENV_NAME} (${path}) from a backup, or, only ` +
    "after verifying every order in it in the Seller Portal, delete the file.";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OperationStoreFileError(
      "corrupt",
      `The operation store file ${ENV_NAME} (${path}) is not valid JSON. ${guidance}`,
    );
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new OperationStoreFileError(
      "corrupt",
      `The operation store file ${ENV_NAME} (${path}) is not a version ${FILE_VERSION} operation ` +
        `store (unexpected structure or version). ${guidance}`,
    );
  }
  return new Map(Object.entries(parsed.data.operations));
}

/** Refuses a file other users could tamper with (POSIX only: Windows mode bits are not meaningful). */
function assertNotSharedWritable(mode: number, path: string): void {
  if (process.platform !== "win32" && (mode & 0o022) !== 0) {
    throw new OperationStoreFileError(
      "permissions",
      `The operation store file ${ENV_NAME} (${path}) is writable by other users; anyone who can ` +
        "write it can clear the duplicate-purchase guard. Run chmod 600 on it.",
    );
  }
}

function unreadable(path: string, error: unknown): OperationStoreFileError {
  return new OperationStoreFileError(
    "unreadable",
    `The operation store file ${ENV_NAME} (${path}) could not be read (${errnoOf(error) ?? "error"}).`,
    { cause: error },
  );
}

/** Reads the file synchronously. A missing file is the one empty case. */
function readOperationsSync(path: string): Operations {
  let text: string;
  try {
    assertNotSharedWritable(statSync(path).mode, path);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof OperationStoreFileError) throw error;
    if (errnoOf(error) === "ENOENT") return new Map();
    throw unreadable(path, error);
  }
  return parseOperations(text, path);
}

async function readOperations(path: string): Promise<Operations> {
  let text: string;
  try {
    assertNotSharedWritable((await stat(path)).mode, path);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof OperationStoreFileError) throw error;
    if (errnoOf(error) === "ENOENT") return new Map();
    throw unreadable(path, error);
  }
  return parseOperations(text, path);
}

function pruned(operations: Operations, keep: string | undefined): Operations {
  const cutoff = Date.now() - MAX_RECORD_AGE_MS;
  const next: Operations = new Map();
  for (const [key, op] of operations) {
    const at = Date.parse(op.updatedAt);
    // An unparseable timestamp is kept: the ledger treats it as still blocking.
    if (key === keep || !Number.isFinite(at) || at >= cutoff) next.set(key, op);
  }
  return next;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

export class FileOperationStore implements OperationStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;
  readonly #onFailure: ((error: OperationStoreFileError) => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Opens the store, reading and validating the file now. Throws {@link OperationStoreFileError}
   * for a corrupt, unreadable, shared-writable or unwritable location, so the server fails at start.
   */
  constructor(path: string, options: FileOperationStoreOptions = {}) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#onFailure = options.onFailure;
    const directory = dirname(path);
    try {
      if (!statSync(directory).isDirectory()) throw new Error("not a directory");
      accessSync(directory, constants.W_OK);
    } catch (error) {
      throw new OperationStoreFileError(
        "unwritable",
        `The directory of ${ENV_NAME} (${directory}) does not exist or is not writable.`,
        { cause: error },
      );
    }
    readOperationsSync(path);
  }

  async get(key: string): Promise<StoredOperation | undefined> {
    return this.#guard(async () => (await readOperations(this.#path)).get(key));
  }

  async put(key: string, op: StoredOperation): Promise<void> {
    await this.#guard(() =>
      this.#exclusive(async () => {
        const operations = await readOperations(this.#path);
        operations.set(key, op);
        await this.#write(pruned(operations, key));
      }),
    );
  }

  async compareAndPut(
    key: string,
    expected: StoredOperation | undefined,
    op: StoredOperation,
  ): Promise<boolean> {
    return this.#guard(() =>
      this.#exclusive(async () => {
        const operations = await readOperations(this.#path);
        if (!sameOperation(operations.get(key), expected)) return false;
        operations.set(key, op);
        await this.#write(pruned(operations, key));
        return true;
      }),
    );
  }

  /**
   * Operator-only: removes one record. Resolves `false` (and writes nothing) when there is none.
   * This is deliberately not part of the SDK `OperationStore` interface and is reached only from the
   * `--clear-label-guard` command, never from a tool.
   */
  async remove(key: string): Promise<boolean> {
    return this.#guard(() =>
      this.#exclusive(async () => {
        const operations = await readOperations(this.#path);
        if (!operations.delete(key)) return false;
        await this.#write(pruned(operations, undefined));
        return true;
      }),
    );
  }

  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const failure =
        error instanceof OperationStoreFileError
          ? error
          : new OperationStoreFileError(
              "unreadable",
              `The operation store file ${ENV_NAME} (${this.#path}) failed (${errnoOf(error) ?? "error"}).`,
              { cause: error },
            );
      this.#onFailure?.(failure);
      throw failure;
    }
  }

  /** Serialises in-process writers, then takes the cross-process lock file around `run`. */
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      const release = await this.#acquireLock();
      try {
        return await run();
      } finally {
        await release();
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          await handle.close();
        }
        return () => rm(this.#lockPath, { force: true });
      } catch (error) {
        if (errnoOf(error) !== "EEXIST") throw error;
      }
      if (await this.#takeOverStaleLock()) continue;
      if (Date.now() >= deadline) {
        throw new OperationStoreFileError(
          "lock",
          `Could not lock the operation store: ${this.#lockPath} is held by another process. If no ` +
            "server or command is running, delete that lock file and retry. Nothing was written.",
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  /** Removes a lock whose holder is gone. Resolves `true` when the caller should retry at once. */
  async #takeOverStaleLock(): Promise<boolean> {
    let content: string;
    let modifiedAt: number;
    try {
      content = await readFile(this.#lockPath, "utf8");
      modifiedAt = (await stat(this.#lockPath)).mtimeMs;
    } catch (error) {
      return errnoOf(error) === "ENOENT";
    }
    let stale = false;
    try {
      const held = z.object({ pid: z.number(), at: z.number() }).parse(JSON.parse(content));
      stale = !isProcessAlive(held.pid) || Date.now() - held.at > LOCK_STALE_AFTER_MS;
    } catch {
      stale = Date.now() - modifiedAt > LOCK_UNREADABLE_STALE_MS;
    }
    if (!stale) return false;
    try {
      // Re-check the content so a lock that was just replaced by a live holder is left alone.
      if ((await readFile(this.#lockPath, "utf8")) !== content) return true;
      const aside = `${this.#lockPath}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
      await rename(this.#lockPath, aside);
      await rm(aside, { force: true });
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw error;
    }
    return true;
  }

  async #write(operations: Operations): Promise<void> {
    const text = `${JSON.stringify({ version: FILE_VERSION, operations: Object.fromEntries(operations) }, null, 2)}\n`;
    const temp = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await rename(temp, this.#path);
          break;
        } catch (error) {
          // Windows can refuse a rename for a moment while a reader (or a scanner) has the file open.
          const transient = ["EPERM", "EBUSY", "EACCES"].includes(errnoOf(error) ?? "");
          if (!transient || attempt >= RENAME_RETRIES) throw error;
          await sleep(20 * attempt);
        }
      }
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    try {
      const directory = await open(dirname(this.#path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directories cannot be opened or synced on every platform; the file itself is already synced.
    }
  }
}
