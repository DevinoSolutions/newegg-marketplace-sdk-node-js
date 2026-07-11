import type { NeweggMarketplace } from "../types.js";
import type { PlatformAdapter } from "./types.js";
import { usAdapter } from "./us.js";
import { b2bAdapter } from "./b2b.js";
import { caAdapter } from "./ca.js";

export type {
  PlatformAdapter,
  RequestSpec,
  ParsedItem,
  DirectUpdateGroup,
  FeedItemInput,
} from "./types.js";
export { identifierTypeCode } from "./normalize.js";

/** Returns the adapter for a marketplace. */
export function getAdapter(marketplace: NeweggMarketplace): PlatformAdapter {
  switch (marketplace) {
    case "us":
      return usAdapter;
    case "b2b":
      return b2bAdapter;
    case "ca":
      return caAdapter;
  }
}
