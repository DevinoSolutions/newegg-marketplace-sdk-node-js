/**
 * Support for the output-schema drift guard (`output-schema-drift.test.ts`).
 *
 * The guard answers one question per MCP tool: "does every key of the SDK type this tool's
 * handler returns appear in the tool's registered output schema, or is it explicitly listed as
 * intentionally omitted?" It asks the TypeScript compiler (so new SDK keys are picked up without
 * anyone writing a fixture) and compares against the JSON Schema a real MCP host receives from
 * `tools/list`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
// TypeScript normalizes to forward slashes on every platform.
const VIRTUAL_FILE = path.join(PACKAGE_ROOT, "test", "__sdk-type-probe.ts").replaceAll("\\", "/");

/** A JSON Schema node, as returned by `tools/list` (only the parts the guard reads). */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
}

/** One SDK key that the output schema neither covers nor lists as intentionally omitted. */
export interface DriftFinding {
  /** Dotted path from the schema root; arrays are written `[]` (e.g. `orders[].packages[].items`). */
  path: string;
  /** The SDK type declaring the key, as `TypeName.key`, to make the message actionable. */
  sdkOwner: string;
  /** True when the SDK type could not be resolved (`any` / error type), so nothing was compared. */
  unresolved?: boolean;
}

export interface SdkTypeProbe {
  /** Compares one SDK type expression against a schema node; returns uncovered key paths. */
  check: (
    typeExpression: string,
    schemaRoot: JsonSchemaNode,
    schemaPath: string,
    omitted: ReadonlySet<string>,
    /** Receives every omit entry that actually suppressed a key, so stale entries can be found. */
    usedOmits?: Set<string>,
  ) => DriftFinding[];
  /** Compiler diagnostics for the probe file itself (a bad type expression shows up here). */
  diagnostics: () => string[];
}

const MAX_DEPTH = 12;

/**
 * Builds one in-memory TypeScript program that declares a `Probe<n>` alias per type expression
 * (resolved through the real package `@devino/newegg-marketplace-sdk`, i.e. its built `.d.ts`).
 */
export function createSdkTypeProbe(typeExpressions: readonly string[]): SdkTypeProbe {
  const unique = [...new Set(typeExpressions)];
  const aliasOf = new Map(unique.map((expression, index) => [expression, `Probe${index}`]));
  const source = [
    `import type * as Sdk from "@devino/newegg-marketplace-sdk";`,
    `type NeweggClient = Sdk.NeweggClient;`,
    ...unique.map((expression) => `export type ${aliasOf.get(expression)} = ${expression};`),
  ].join("\n");

  const configPath = path.join(PACKAGE_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PACKAGE_ROOT);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    types: [],
    skipLibCheck: true,
    // The probe never needs declaration output or source maps.
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };

  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  host.fileExists = (file) => file === VIRTUAL_FILE || realFileExists(file);
  host.readFile = (file) => (file === VIRTUAL_FILE ? source : realReadFile(file));
  host.getSourceFile = (file, languageVersionOrOptions, onError, shouldCreate) =>
    file === VIRTUAL_FILE
      ? ts.createSourceFile(file, source, languageVersionOrOptions, true)
      : realGetSourceFile(file, languageVersionOrOptions, onError, shouldCreate);

  const program = ts.createProgram({ rootNames: [VIRTUAL_FILE], options, host });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(VIRTUAL_FILE);
  if (sourceFile === undefined) {
    throw new Error("drift guard: failed to create the in-memory probe source file");
  }

  const aliasTypes = new Map<string, ts.Type>();
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliasTypes.set(statement.name.text, checker.getTypeFromTypeNode(statement.type));
    }
  }

  function resolveRef(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
    if (node.$ref === undefined) return node;
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(node.$ref);
    const target = match
      ? (root[match[1] as "$defs" | "definitions"] ?? {})[match[2] ?? ""]
      : undefined;
    return target ?? {};
  }

  /** All concrete schema alternatives for a node (anyOf/oneOf/allOf/$ref flattened). */
  function alternatives(node: JsonSchemaNode, root: JsonSchemaNode, depth = 0): JsonSchemaNode[] {
    const resolved = resolveRef(node, root);
    const nested = [
      ...(resolved.anyOf ?? []),
      ...(resolved.oneOf ?? []),
      ...(resolved.allOf ?? []),
    ];
    if (nested.length === 0 || depth > 6) return [resolved];
    return [resolved, ...nested.flatMap((child) => alternatives(child, root, depth + 1))];
  }

  /**
   * True when a schema accepts keys it does not name: `z.record`, `z.looseObject`, `z.unknown()`
   * (additionalProperties true/object, or an unconstrained `{}`). Nothing can drift past it.
   */
  function isOpen(nodes: JsonSchemaNode[]): boolean {
    return nodes.some((node) => {
      if (node.additionalProperties === true) return true;
      if (typeof node.additionalProperties === "object") return true;
      return (
        node.properties === undefined &&
        node.items === undefined &&
        node.type === undefined &&
        node.anyOf === undefined &&
        node.oneOf === undefined &&
        node.allOf === undefined &&
        node.$ref === undefined
      );
    });
  }

  function schemaProperty(
    nodes: JsonSchemaNode[],
    key: string,
    root: JsonSchemaNode,
  ): JsonSchemaNode | undefined {
    const matches = nodes.flatMap((node) => {
      const property = node.properties?.[key];
      return property === undefined ? [] : [property];
    });
    if (matches.length === 0) return undefined;
    // Merge alternatives of the same key into one synthetic anyOf node.
    return matches.length === 1 ? matches[0] : { anyOf: matches.map((m) => resolveRef(m, root)) };
  }

  function schemaItems(nodes: JsonSchemaNode[], root: JsonSchemaNode): JsonSchemaNode | undefined {
    const items = nodes.flatMap((node) => {
      if (node.items === undefined) return [];
      return Array.isArray(node.items) ? node.items : [node.items];
    });
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : { anyOf: items.map((i) => resolveRef(i, root)) };
  }

  function schemaAdditional(
    nodes: JsonSchemaNode[],
    root: JsonSchemaNode,
  ): JsonSchemaNode | undefined {
    const extra = nodes.flatMap((node) =>
      typeof node.additionalProperties === "object" ? [node.additionalProperties] : [],
    );
    if (extra.length === 0) return undefined;
    return extra.length === 1 ? extra[0] : { anyOf: extra.map((e) => resolveRef(e, root)) };
  }

  function isLeaf(type: ts.Type): boolean {
    const scalar =
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.EnumLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null |
      ts.TypeFlags.Never |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown;
    if (type.flags & scalar) return true;
    if (type.getCallSignatures().length > 0) return true;
    const name = type.symbol?.getName();
    // Dates are serialized to ISO strings; Maps/Sets/typed arrays/Buffers never appear in outputs raw.
    return name === "Date" || name === "Map" || name === "Set" || name === "Buffer";
  }

  function typeName(type: ts.Type): string {
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  }

  function walk(
    type: ts.Type,
    nodes: JsonSchemaNode[],
    root: JsonSchemaNode,
    pathSoFar: string,
    omitted: ReadonlySet<string>,
    out: DriftFinding[],
    seen: Set<string>,
    depth: number,
    used: Set<string>,
  ): void {
    if (depth > MAX_DEPTH) return;
    const nonNull = checker.getNonNullableType(type);
    if (nonNull.isUnion()) {
      for (const member of nonNull.types) {
        walk(member, nodes, root, pathSoFar, omitted, out, seen, depth, used);
      }
      return;
    }
    // `any` and the error type (an unresolvable import) would otherwise hide every key beneath
    // them. `any` is banned in this repo, so reaching one means the SDK types did not resolve.
    if (nonNull.flags & ts.TypeFlags.Any) {
      out.push({ path: pathSoFar, sdkOwner: "unresolved SDK type (any)", unresolved: true });
      return;
    }
    if (isLeaf(nonNull)) return;
    if (isOpen(nodes)) return;

    if (checker.isArrayType(nonNull) || checker.isTupleType(nonNull)) {
      const element = checker.getTypeArguments(nonNull as ts.TypeReference)[0];
      if (element === undefined) return;
      const itemSchema = schemaItems(nodes, root);
      // A schema that models the array as an opaque value (no `items`) has nothing to compare.
      if (itemSchema === undefined) return;
      walk(
        element,
        alternatives(itemSchema, root),
        root,
        `${pathSoFar}[]`,
        omitted,
        out,
        seen,
        depth + 1,
        used,
      );
      return;
    }

    const stringIndex = checker.getIndexTypeOfType(nonNull, ts.IndexKind.String);
    if (stringIndex !== undefined && checker.getPropertiesOfType(nonNull).length === 0) {
      const additional = schemaAdditional(nodes, root);
      if (additional !== undefined) {
        walk(
          stringIndex,
          alternatives(additional, root),
          root,
          `${pathSoFar}{}`,
          omitted,
          out,
          seen,
          depth + 1,
          used,
        );
      }
      return;
    }

    // The schema flattens this object into a scalar (e.g. a Timestamp rendered as an ISO string);
    // that is a representation choice, not a missing key.
    if (!nodes.some((node) => node.properties !== undefined)) return;

    const cycleKey = `${pathSoFar}|${typeName(nonNull)}`;
    if (seen.has(cycleKey)) return;
    const nextSeen = new Set(seen).add(cycleKey);

    const owner = typeName(nonNull);
    for (const property of checker.getPropertiesOfType(nonNull)) {
      const key = property.getName();
      const propertyType = checker.getTypeOfSymbol(property);
      if (propertyType.getCallSignatures().length > 0) continue;
      const propertyPath = pathSoFar === "" ? key : `${pathSoFar}.${key}`;
      const omitKey = omitted.has(propertyPath)
        ? propertyPath
        : omitted.has(`*.${key}`)
          ? `*.${key}`
          : undefined;
      if (omitKey !== undefined) {
        used.add(omitKey);
        continue;
      }
      const propertySchema = schemaProperty(nodes, key, root);
      if (propertySchema === undefined) {
        out.push({ path: propertyPath, sdkOwner: `${owner}.${key}` });
        continue;
      }
      walk(
        propertyType,
        alternatives(propertySchema, root),
        root,
        propertyPath,
        omitted,
        out,
        nextSeen,
        depth + 1,
        used,
      );
    }
  }

  /** Resolves a dotted schema path (`order`, `orders[]`, `a.b[]`) to its schema alternatives. */
  function descend(root: JsonSchemaNode, schemaPath: string): JsonSchemaNode[] {
    let nodes = alternatives(root, root);
    if (schemaPath === "") return nodes;
    for (const segment of schemaPath.split(".")) {
      const isArray = segment.endsWith("[]");
      const key = isArray ? segment.slice(0, -2) : segment;
      const next = schemaProperty(nodes, key, root);
      if (next === undefined) {
        throw new Error(`drift guard: schema path "${schemaPath}" not found at "${segment}"`);
      }
      nodes = alternatives(next, root);
      if (isArray) {
        const items = schemaItems(nodes, root);
        if (items === undefined) {
          throw new Error(
            `drift guard: schema path "${schemaPath}" has no array items at "${segment}"`,
          );
        }
        nodes = alternatives(items, root);
      }
    }
    return nodes;
  }

  return {
    check: (typeExpression, schemaRoot, schemaPath, omitted, usedOmits = new Set<string>()) => {
      const alias = aliasOf.get(typeExpression);
      const type = alias === undefined ? undefined : aliasTypes.get(alias);
      if (type === undefined) {
        throw new Error(`drift guard: type expression not probed: ${typeExpression}`);
      }
      const out: DriftFinding[] = [];
      walk(
        type,
        descend(schemaRoot, schemaPath),
        schemaRoot,
        "",
        omitted,
        out,
        new Set(),
        0,
        usedOmits,
      );
      return out;
    },
    diagnostics: () =>
      ts
        .getPreEmitDiagnostics(program, sourceFile)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  };
}

/**
 * The probe reads the SDK's built `.d.ts` (dist), so a dist older than src (e.g. a OneDrive
 * rollback, or a forgotten rebuild) would silently compare against stale types. Returns a
 * human-readable problem, or undefined when dist is current (always undefined on CI).
 */
export function sdkDistStaleness(): string | undefined {
  // CI downloads the dist artifact (tar preserves the build job's older mtimes) AFTER checking
  // out the same commit, so mtimes say nothing there; the artifact is built from this commit.
  if (process.env.CI === "true") return undefined;
  const sdkRoot = path.resolve(PACKAGE_ROOT, "..", "sdk");
  const newest = (dir: string, ext: string): number => {
    let latest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) latest = Math.max(latest, newest(full, ext));
      else if (entry.name.endsWith(ext)) latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
    return latest;
  };
  const distIndex = path.join(sdkRoot, "dist", "index.d.ts");
  if (!fs.existsSync(distIndex)) return "packages/sdk/dist is missing; run `npm run build` first.";
  const srcNewest = newest(path.join(sdkRoot, "src"), ".ts");
  // Compare against the OLDEST relevant dist declaration so a partially rolled-back dist is caught.
  const distOldest = (() => {
    let oldest = Infinity;
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith(".d.ts")) oldest = Math.min(oldest, fs.statSync(full).mtimeMs);
      }
    };
    visit(path.join(sdkRoot, "dist"));
    return oldest;
  })();
  return distOldest < srcNewest
    ? "packages/sdk/dist is older than packages/sdk/src; run `npm run build` before trusting this guard."
    : undefined;
}
