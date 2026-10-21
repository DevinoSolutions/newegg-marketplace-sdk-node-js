// Reads the SDK's client type declarations for the surface check and fails closed on stray ones.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  classifiedInterfaceNames,
  clientSurfaceProblems,
  strayClientDeclarations,
} from "./surface.js";

const TS_FILE = /\.[cm]?ts$/;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => TS_FILE.test(f))
    .sort();
}

/**
 * Problems with the client surface of the SDK under `root`: the classification check over
 * `types.ts` plus EVERY `.ts` file under `types/` (recursively), and a fail-closed scan of every
 * other file in `packages/sdk/src` for a second declaration of `NeweggClient` or of an interface the
 * check classifies (interface declaration merging would otherwise hide a new method from the guard).
 */
export function clientTypeProblems(root: string): string[] {
  const srcDir = join(root, "packages", "sdk", "src");
  const barrel = join(srcDir, "types.ts");
  const scanned = [barrel, ...tsFilesUnder(join(srcDir, "types"))];
  const typesSource = scanned.map((f) => readFileSync(f, "utf8")).join("\n");
  const problems = clientSurfaceProblems(typesSource);
  const names = classifiedInterfaceNames(typesSource);
  const scannedSet = new Set(scanned);
  for (const file of tsFilesUnder(srcDir)) {
    if (scannedSet.has(file)) continue;
    const rel = relative(root, file).replaceAll("\\", "/");
    problems.push(...strayClientDeclarations(readFileSync(file, "utf8"), rel, names));
  }
  return problems;
}
