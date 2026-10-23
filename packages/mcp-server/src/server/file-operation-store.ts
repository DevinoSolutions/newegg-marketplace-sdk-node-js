/**
 * A file-backed SDK `OperationStore` (T-6280), so the label-create duplicate ledger (T-6212)
 * survives a restart of the MCP server. Enabled by `NEWEGG_MCP_OPERATION_STORE_FILE` (an ABSOLUTE
 * path: a relative one would silently start an empty ledger when the server is restarted elsewhere).
 *
 * - The file is `{ "version": 1, "operations": { "<key>": <StoredOperation> } }`. It holds the ledger
 *   keys (`label-create:<marketplace>:<order number>`), states, payload hashes, attempt ids and
 *   timestamps. It never holds a credential, a label link or customer data.
 * - Every write is atomic: a temp file in the same directory (created `0600`), `fsync`, `rename`
 *   over the target, then a best-effort `fsync` of the directory.
 * - It fails CLOSED. A file that is not valid JSON, has an unknown version or malformed records, is
 *   unreadable, is writable by other users, is owned by another user, or sits in a directory other
 *   users can write to (POSIX) makes the store refuse to open (construction throws) or, once open,
 *   reject every read and write. It is never replaced by an empty ledger. A file that does not exist
 *   yet is the one empty case (first run), unless the directory holds a leftover lock or temp file of
 *   this store, which means the file was lost or moved: that fails closed too.
 * - Writers take a lock file (`<file>.lock`, created with `O_EXCL`, holding hostname, pid and start
 *   time) around read-modify-write, so `compareAndPut` is atomic between processes on one host. A lock
 *   is NEVER taken over automatically (every takeover scheme has a window in which two processes both
 *   win): a lock that cannot be acquired before `lockTimeoutMs` fails the operation closed, and an
 *   operator removes a lock a crash left behind with `releaseStoreLock` (`--release-store-lock`).
 *   The file must be on a local filesystem shared by processes of ONE host (no network file systems:
 *   their locking is not trustworthy).
 */
import { accessSync, constants, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { OperationStore, StoredOperation } from "@devino/newegg-marketplace-sdk";

const FILE_VERSION = 1;

/** Records older than the longest guard window (30 days) plus a day are dropped on write. */
const MAX_RECORD_AGE_MS = 31 * 24 * 3_600_000;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 15;
const RENAME_RETRIES = 5;
/** Errors that mean "busy for a moment" on Windows (a scanner, another handle) as much as EEXIST. */
const TRANSIENT_LOCK_ERRORS = ["EEXIST", "EPERM", "EBUSY", "EACCES"];
/** Orphaned temp files of a crashed write are removed after this long. */
const ORPHAN_TMP_AGE_MS = 3_600_000;
/** A lock beside a missing store file is read as "a first run is writing" until it is this old. */
const FRESH_LOCK_MS = 30_000;

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

const lockSchema = z.object({
  hostname: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
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
  /** Test hook: creates the lock file (default `fs.promises.open`). */
  readonly openLockFile?: (path: string, flags: string, mode: number) => ReturnType<typeof open>;
  /** Test hook: called while the lock is held, before the protected work runs. */
  readonly onLockHeld?: () => void;
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

function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw new OperationStoreFileError(
      "unwritable",
      `${ENV_NAME} must be an absolute path: a relative one resolves against the working directory, ` +
        "so a server restarted from another directory would silently start with an empty ledger.",
    );
  }
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

interface OwnedMode {
  readonly mode: number;
  readonly uid: number;
}

/**
 * Why a store file on a POSIX system cannot be trusted, or undefined. `uid` is the current user
 * (undefined where there are no POSIX owners, i.e. Windows: nothing is checked there). The file must
 * belong to the current user and not be writable by group or others, and its directory must not be
 * writable by others unless sticky (otherwise someone could swap the file or its temp files).
 */
export function fileSecurityProblem(
  file: OwnedMode,
  directory: OwnedMode,
  uid: number | undefined,
): string | undefined {
  if (uid === undefined) return undefined;
  if (file.uid !== uid) {
    return "is owned by another user; anyone who can replace it can clear the duplicate-purchase guard.";
  }
  if ((file.mode & 0o022) !== 0) {
    return "is writable by other users; anyone who can write it can clear the duplicate-purchase guard. Run chmod 600 on it.";
  }
  if ((directory.mode & 0o002) !== 0 && (directory.mode & 0o1000) === 0) {
    return "is in a directory that other users can write to (no sticky bit), so the file could be swapped. Use a private directory.";
  }
  return undefined;
}

const currentUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

function assertTrusted(path: string, file: OwnedMode): void {
  const problem = fileSecurityProblem(file, statSync(dirname(path)), currentUid());
  if (problem !== undefined) {
    throw new OperationStoreFileError(
      "permissions",
      `The operation store file ${ENV_NAME} (${path}) ${problem}`,
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
    assertTrusted(path, statSync(path));
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
    assertTrusted(path, await stat(path));
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

/** The temp files of this store's atomic writes: `<file name>.<pid>.<hex>.tmp`. */
function tempFilesOf(path: string): string[] {
  const prefix = `${basename(path)}.`;
  const directory = dirname(path);
  return readdirSync(directory)
    .filter(
      (name) => name.startsWith(prefix) && /^\d+\.[0-9a-f]+\.tmp$/.test(name.slice(prefix.length)),
    )
    .map((name) => `${directory}/${name}`);
}

/**
 * A store file that is missing while its directory holds a leftover temp file of this store, or a lock,
 * that is not fresh (30 s), was lost or moved after the ledger was written: starting empty would forget
 * every claim. (A fresh lock or temp file is a first run writing right now.)
 */
function assertNotLost(path: string): void {
  const stale = (file: string): boolean => {
    try {
      return Date.now() - statSync(file).mtimeMs >= FRESH_LOCK_MS;
    } catch {
      return false;
    }
  };
  let leftover = tempFilesOf(path).some(stale);
  if (!leftover) {
    try {
      const lock = lockSchema.parse(JSON.parse(readFileSync(`${path}.lock`, "utf8")));
      leftover = !(Date.now() - Date.parse(lock.startedAt) < FRESH_LOCK_MS);
    } catch (error) {
      // No lock at all is normal. One that cannot be parsed counts only once it is not fresh: a lock
      // being created is briefly empty.
      leftover = errnoOf(error) !== "ENOENT" && stale(`${path}.lock`);
    }
  }
  if (leftover) {
    throw new OperationStoreFileError(
      "corrupt",
      `The operation store file ${ENV_NAME} (${path}) is missing, but a leftover lock or temp file of ` +
        "it is beside it: the file was lost, moved or deleted, and starting with an empty ledger would " +
        "forget every label claim. Restore it from a backup, or, only after verifying every order in " +
        "the Seller Portal, remove the leftover files (--release-store-lock for the lock).",
    );
  }
}

/** Removes this store's temp files older than an hour (a crash between create and rename). */
function removeOrphanTempFiles(path: string): void {
  for (const temp of tempFilesOf(path)) {
    try {
      const info = statSync(temp);
      const uid = currentUid();
      if (
        Date.now() - info.mtimeMs > ORPHAN_TMP_AGE_MS &&
        (uid === undefined || info.uid === uid)
      ) {
        unlinkSync(temp);
      }
    } catch {
      // Already gone or not ours: harmless either way.
    }
  }
}

export type ReleaseLockResult = "released" | "none";

/**
 * Operator-only: removes the lock file a crashed server left behind. Refuses unless the lock was
 * taken on THIS host by a process that is no longer alive; `force` overrides every refusal (use it
 * only after confirming by other means that no server or command is using the store). It never
 * touches the ledger, and nothing in the MCP surface calls it.
 */
export async function releaseStoreLock(
  path: string,
  options: { readonly force?: boolean } = {},
): Promise<ReleaseLockResult> {
  assertAbsolute(path);
  const lockPath = `${path}.lock`;
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return "none";
    throw new OperationStoreFileError(
      "lock",
      `The lock file ${lockPath} could not be read (${errnoOf(error) ?? "error"}).`,
      { cause: error },
    );
  }
  if (options.force !== true) {
    let refusal: string | undefined;
    try {
      const held = lockSchema.parse(JSON.parse(content));
      if (held.hostname !== hostname()) {
        refusal = "was taken on another host";
      } else if (isProcessAlive(held.pid)) {
        refusal = "belongs to a process that is still running on this host";
      }
    } catch {
      refusal = "has content that cannot be read";
    }
    if (refusal !== undefined) {
      throw new OperationStoreFileError(
        "lock",
        `The lock file ${lockPath} ${refusal}, so it was not removed. Make sure no server or command ` +
          "is using the store, then repeat with --force.",
      );
    }
  }
  await removeWithRetry(lockPath);
  return "released";
}

async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (!TRANSIENT_LOCK_ERRORS.includes(errnoOf(error) ?? "") || attempt >= RENAME_RETRIES) {
        throw error;
      }
      await sleep(20 * attempt);
    }
  }
}

export class FileOperationStore implements OperationStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;
  readonly #onFailure: ((error: OperationStoreFileError) => void) | undefined;
  readonly #openLockFile: NonNullable<FileOperationStoreOptions["openLockFile"]>;
  readonly #onLockHeld: (() => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Opens the store, reading and validating the file now. Throws {@link OperationStoreFileError}
   * for a relative path, a corrupt, unreadable, untrusted or unwritable location, or a lost file, so
   * the server fails at start.
   */
  constructor(path: string, options: FileOperationStoreOptions = {}) {
    assertAbsolute(path);
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#onFailure = options.onFailure;
    this.#openLockFile =
      options.openLockFile ?? ((target, flags, mode) => open(target, flags, mode));
    this.#onLockHeld = options.onLockHeld;
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
    const dirProblem = fileSecurityProblem(
      { mode: 0o100600, uid: currentUid() ?? 0 },
      statSync(directory),
      currentUid(),
    );
    if (dirProblem !== undefined) {
      throw new OperationStoreFileError(
        "permissions",
        `The operation store file ${ENV_NAME} (${path}) ${dirProblem}`,
      );
    }
    let exists = true;
    try {
      statSync(path);
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw unreadable(path, error);
      exists = false;
    }
    if (exists) {
      readOperationsSync(path);
      removeOrphanTempFiles(path);
    } else {
      assertNotLost(path);
    }
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
      await this.#acquireLock();
      try {
        this.#onLockHeld?.();
        return await run();
      } finally {
        await removeWithRetry(this.#lockPath);
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Creates the lock file or fails closed at the deadline. An existing lock is never taken over. */
  async #acquireLock(): Promise<void> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        const handle = await this.#openLockFile(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              hostname: hostname(),
              pid: process.pid,
              startedAt: new Date().toISOString(),
            }),
          );
        } catch (error) {
          await handle.close();
          await removeWithRetry(this.#lockPath);
          throw error;
        }
        await handle.close();
        return;
      } catch (error) {
        if (!TRANSIENT_LOCK_ERRORS.includes(errnoOf(error) ?? "")) throw error;
      }
      if (Date.now() >= deadline) {
        throw new OperationStoreFileError(
          "lock",
          `The operation store is busy: the lock file ${this.#lockPath} is held (or cannot be created). ` +
            "Nothing was written. If a server crashed while holding it, first make sure no Newegg MCP " +
            "server or command is running, then remove it with `newegg-marketplace-mcp --release-store-lock`.",
        );
      }
      await sleep(LOCK_POLL_MS);
    }
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
