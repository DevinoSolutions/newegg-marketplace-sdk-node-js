/**
 * The SDK `OperationStore` shared by every client of one server process. In HTTP mode each session
 * builds its own client, and the label-create ledger (T-6212) lives in the client's operation store:
 * a store per client would let a new session forget that an order's label was already bought. Keyed
 * on the store behind the per-session preview view, exactly like the reprint limiter, so both state
 * holders reset together on restart.
 *
 * With `NEWEGG_MCP_OPERATION_STORE_FILE` set (T-6280) the label-create records are kept in that file
 * and survive a restart; every other record (feed submission dedup, which has no expiry) stays in
 * memory, because a feed payload recorded on disk would block an identical resubmission forever.
 */
import { InMemoryOperationStore } from "@devino/newegg-marketplace-sdk";
import type { OperationStore, StoredOperation } from "@devino/newegg-marketplace-sdk";
import { underlyingPreviewStore, type PreviewStore } from "../preview-store/index.js";
import type { Logger } from "../tools/index.js";
import { FileOperationStore } from "./file-operation-store.js";

/** The ledger key prefix of a label create attempt (contracts §23.5). */
const LABEL_CREATE_PREFIX = "label-create:";
const MARKETPLACES: readonly string[] = ["us", "b2b", "ca"];
/** Newegg order numbers: a positive integer of at most 10 digits (the SDK's own rule). */
const ORDER_NUMBER = /^[1-9]\d{0,9}$/;

/** Sends label-create records to the file store and everything else to memory. */
class LabelRoutedOperationStore implements OperationStore {
  readonly #file: FileOperationStore;
  readonly #memory = new InMemoryOperationStore();

  constructor(file: FileOperationStore) {
    this.#file = file;
  }

  #route(key: string): OperationStore & Required<Pick<OperationStore, "compareAndPut">> {
    return key.startsWith(LABEL_CREATE_PREFIX) ? this.#file : this.#memory;
  }

  get(key: string): Promise<StoredOperation | undefined> {
    return this.#route(key).get(key);
  }

  put(key: string, op: StoredOperation): Promise<void> {
    return this.#route(key).put(key, op);
  }

  compareAndPut(
    key: string,
    expected: StoredOperation | undefined,
    op: StoredOperation,
  ): Promise<boolean> {
    return this.#route(key).compareAndPut(key, expected, op);
  }
}

const stores = new WeakMap<PreviewStore, OperationStore>();

/**
 * The operation store of one server process. Throws `OperationStoreFileError` when the configured
 * file is corrupt, unreadable or unsafe: the server must not start with an empty ledger instead.
 */
export function operationStoreFor(
  previewStore: PreviewStore,
  config?: { readonly operationStoreFile?: string },
  logger?: Logger,
): OperationStore {
  const shared = underlyingPreviewStore(previewStore);
  let store = stores.get(shared);
  if (store === undefined) {
    const path = config?.operationStoreFile;
    store =
      path === undefined
        ? new InMemoryOperationStore()
        : new LabelRoutedOperationStore(
            new FileOperationStore(path, {
              onFailure: (error) =>
                logger?.("error", "operation_store_error", {
                  code: error.code,
                  message: error.message,
                }),
            }),
          );
    stores.set(shared, store);
  }
  return store;
}

/**
 * Operator-only: removes the label-create guard record of one order from the store file, so the
 * order can be previewed again after a restart. A running server keeps its in-process claim until it
 * restarts. Reached only from the `--clear-label-guard` command; no MCP tool calls it.
 * Resolves `false` when the file holds no record for that order.
 */
export async function clearLabelCreateGuard(
  file: string,
  marketplace: string,
  orderNumber: string,
): Promise<boolean> {
  if (!MARKETPLACES.includes(marketplace)) {
    throw new Error(`Unknown marketplace "${marketplace}" (expected us, b2b or ca).`);
  }
  if (!ORDER_NUMBER.test(orderNumber)) {
    throw new Error("The order number must be a positive whole number of at most 10 digits.");
  }
  return new FileOperationStore(file).remove(`${LABEL_CREATE_PREFIX}${marketplace}:${orderNumber}`);
}

/** Opens (and thereby validates) the configured store file; throws when it cannot be trusted. */
export function assertOperationStoreFileUsable(file: string): void {
  new FileOperationStore(file);
}
