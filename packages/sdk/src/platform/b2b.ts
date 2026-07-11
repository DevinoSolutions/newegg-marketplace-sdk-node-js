import { createItemAdapter } from "./item-adapter.js";

/** B2B (`neweggbusiness.com`) adapter — item endpoints under the `b2b/` prefix. */
export const b2bAdapter = createItemAdapter("b2b", "b2b/");
