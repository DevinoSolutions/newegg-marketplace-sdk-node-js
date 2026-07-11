// Verifies that both built packages expose working ESM entry points with the
// expected named exports, and that every "exports" target file exists on disk.
// Run after `npm run build`.
import { readFileSync, existsSync } from "node:fs";
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

if (failures > 0) {
  console.error(`\n${failures} export check(s) failed`);
  process.exit(1);
}
console.log("\nAll export checks passed");
