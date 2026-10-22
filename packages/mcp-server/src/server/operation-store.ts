/**
 * The SDK `OperationStore` shared by every client of one server process. In HTTP mode each session
 * builds its own client, and the label-create ledger (T-6212) lives in the client's operation store:
 * a store per client would let a new session forget that an order's label was already bought. Keyed
 * on the store behind the per-session preview view, exactly like the reprint limiter, so both state
 * holders reset together on restart.
 */
import { InMemoryOperationStore } from "@devino/newegg-marketplace-sdk";
import type { OperationStore } from "@devino/newegg-marketplace-sdk";
import { underlyingPreviewStore, type PreviewStore } from "../preview-store/index.js";

const stores = new WeakMap<PreviewStore, OperationStore>();

export function operationStoreFor(previewStore: PreviewStore): OperationStore {
  const shared = underlyingPreviewStore(previewStore);
  let store = stores.get(shared);
  if (store === undefined) {
    store = new InMemoryOperationStore();
    stores.set(shared, store);
  }
  return store;
}
