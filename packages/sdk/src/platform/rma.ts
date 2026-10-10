/**
 * Per-marketplace differences of the Service Management reads (contracts §18). The three
 * platforms share paths, verbs and OperationTypes; what differs is the set of Get RMA Information
 * `version`s Newegg accepts and the currency (optional item fields such as `UnOpen`/`Memo`,
 * documented for USA/CAN only, are simply read when present). Keeping that here (ADR 0002) means
 * the API layer has no per-marketplace `if`s.
 */
import type { NeweggMarketplace, RmaCurrency } from "../types.js";
import { NeweggValidationError } from "../errors/index.js";

/** Default Get RMA Information `version`: 320 is the newest on every platform (§18.1). */
const RMA_DEFAULT_VERSION = "320";

export interface RmaPlatform {
  readonly marketplace: NeweggMarketplace;
  /** Documented Get RMA Information versions (`version` query), oldest first. */
  readonly versions: readonly string[];
  readonly currency: RmaCurrency;
}

const usRma: RmaPlatform = {
  marketplace: "us",
  versions: ["307", "309", "320"],
  currency: "USD",
};

const b2bRma: RmaPlatform = {
  marketplace: "b2b",
  versions: ["305", "309", "320"],
  currency: "USD",
};

const caRma: RmaPlatform = {
  marketplace: "ca",
  versions: ["305", "309", "320"],
  currency: "CAD",
};

/** Returns the RMA platform data for a marketplace. */
export function getRmaPlatform(marketplace: NeweggMarketplace): RmaPlatform {
  switch (marketplace) {
    case "us":
      return usRma;
    case "b2b":
      return b2bRma;
    case "ca":
      return caRma;
  }
}

/** Resolves the requested `version` against the platform's documented set. */
export function resolveRmaVersion(platform: RmaPlatform, requested: string | undefined): string {
  const version = requested ?? RMA_DEFAULT_VERSION;
  if (!platform.versions.includes(version)) {
    throw new NeweggValidationError("Invalid RMA request.", [
      {
        path: "version",
        message: `must be one of ${platform.versions.join(", ")} on the ${platform.marketplace} marketplace`,
      },
    ]);
  }
  return version;
}
