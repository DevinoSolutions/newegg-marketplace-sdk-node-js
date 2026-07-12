// Verifies that both built packages expose working ESM entry points with the
// expected named exports, and that every "exports" target file exists on disk.
// Run after `npm run build`.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};
const ok = (msg: string): void => console.log(`ok   ${msg}`);

interface PackageSpec {
  dir: string;
  name: string;
  entries: Record<string, string[]>;
}

const packages: PackageSpec[] = [
  {
    dir: "packages/sdk",
    name: "@devino/newegg-marketplace-sdk",
    entries: {
      ".": [
        "createNeweggClient",
        "NeweggError",
        "NeweggValidationError",
        "InMemoryOperationStore",
        "InMemoryRateLimitStore",
      ],
      "./testing": ["createMockFetch"],
    },
  },
  {
    dir: "packages/mcp-server",
    name: "@devino/newegg-marketplace-mcp",
    entries: {
      ".": ["createNeweggMcpServer", "loadMcpConfigFromEnv", "InMemoryPreviewStore"],
    },
  },
];

for (const pkg of packages) {
  const pkgJsonPath = join(root, pkg.dir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
    bin?: Record<string, string>;
  };
  for (const [subpath, target] of Object.entries(pkgJson.exports ?? {})) {
    const candidates =
      typeof target === "string"
        ? [target]
        : Object.values(target as Record<string, unknown>).filter(
            (v): v is string => typeof v === "string",
          );
    for (const rel of candidates) {
      const file = join(root, pkg.dir, rel);
      if (!existsSync(file)) fail(`${pkg.name} exports["${subpath}"] -> ${rel} missing on disk`);
      else ok(`${pkg.name} exports["${subpath}"] -> ${rel}`);
    }
  }
  for (const [subpath, names] of Object.entries(pkg.entries)) {
    const spec = subpath === "." ? pkg.name : pkg.name + subpath.slice(1);
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      for (const name of names) {
        if (typeof mod[name] === "undefined") fail(`${spec} is missing named export "${name}"`);
        else ok(`${spec} exports ${name}`);
      }
    } catch (err) {
      fail(`import("${spec}") threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pkgJson.bin) {
    for (const [binName, rel] of Object.entries(pkgJson.bin)) {
      const file = join(root, pkg.dir, rel);
      if (!existsSync(file)) fail(`${pkg.name} bin "${binName}" -> ${rel} missing on disk`);
      else ok(`${pkg.name} bin "${binName}" -> ${rel}`);
    }
  }
}

// Every example workspace must define its own `typecheck` script. The root typechecks with
// `npm run typecheck --workspaces --if-present`, which SILENTLY skips any workspace missing the
// script — so a new example could ship completely un-typechecked without CI noticing. Turn that
// silent gap into a hard failure here (this runs in the same CI job as the export checks).
const examplesDir = join(root, "examples");
if (existsSync(examplesDir)) {
  const exampleNames = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of exampleNames) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) {
      fail(`examples/${name} has no package.json`);
      continue;
    }
    const examplePkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (typeof examplePkg.scripts?.typecheck !== "string") {
      fail(
        `examples/${name} is missing a "typecheck" script — the root typecheck skips it via --if-present`,
      );
    } else {
      ok(`examples/${name} defines a typecheck script`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} export check(s) failed`);
  process.exit(1);
}
console.log("\nAll export checks passed");
