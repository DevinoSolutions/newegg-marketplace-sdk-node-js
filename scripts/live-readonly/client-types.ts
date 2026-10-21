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
  return clientTypeScan(root).problems;
}

/**
 * As clientTypeProblems, plus the number of type files read so a silent skip is visible. Only
 * packages/sdk/src is scanned: augmentation from outside it (mcp-server, sdk/test) is out of scope by
 * design, since the live call-site allowlists still judge every use in the live suite. tsconfig
 * includes only .ts files under src, so .tsx / .js files cannot augment the SDK's types.
 */
export function clientTypeScan(root: string): { problems: string[]; typeFiles: number } {
  const srcDir = join(root, "packages", "sdk", "src");
  const barrel = join(srcDir, "types.ts");
  const scanned = [barrel, ...tsFilesUnder(join(srcDir, "types"))];
  const typesSource = scanned.map((f) => readFileSync(f, "utf8")).join("\n");
  const problems = clientSurfaceProblems(typesSource);
  const names = classifiedInterfaceNames(typesSource);
  const scannedSet = new Set(scanned);
  for (const file of tsFilesUnder(srcDir)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const isTypesFile = scannedSet.has(file);
    problems.push(...strayClientDeclarations(readFileSync(file, "utf8"), rel, names, isTypesFile));
  }
  return { problems, typeFiles: scanned.length };
}
