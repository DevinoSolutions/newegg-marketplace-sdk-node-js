import { createItemAdapter } from "./item-adapter.js";

/** Canada (`newegg.ca`) adapter — item endpoints under the `can/` prefix. */
export const caAdapter = createItemAdapter("ca", "can/");
