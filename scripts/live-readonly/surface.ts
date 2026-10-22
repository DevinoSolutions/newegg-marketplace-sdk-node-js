// Classification check of the SDK client surface (NeweggClient and its API interfaces).
import ts from "typescript";
import {
  READ_ONLY_NAMESPACES,
  READ_ONLY_NAMESPACE_MEMBERS,
  REPORT_INTERFACE_MEMBERS,
  WRITE_METHOD_NAMES,
  WRITE_NAMESPACE_READS,
} from "./allowlists.js";

// Members of NeweggClient that are neither a namespace nor a write surface.
const CLIENT_PLAIN_MEMBERS: ReadonlySet<string> = new Set(["marketplace", "verifyCredentials"]);
// Methods that only re-bind a function; they are not SDK methods and never appear on an API interface.
const FUNCTION_HELPERS: ReadonlySet<string> = new Set(["call", "apply", "bind"]);

function memberName(member: ts.TypeElement): string | undefined {
  const name = member.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * Problems with how the SDK's client surface is classified, found by parsing `types.ts` (not by
 * regex, so no member form can be skipped): every member of `NeweggClient` must be a plain member
 * or a classified namespace typed by a plain interface reference, and every member of a write
 * namespace's interface must be a listed read or a listed write method. Fails closed on anything
 * it cannot read (index signatures, computed names, `extends`, unions, intersections).
 */
export function clientSurfaceProblems(typesSource: string): string[] {
  const problems: string[] = [];
  const file = ts.createSourceFile("types.ts", typesSource, ts.ScriptTarget.ESNext, true);
  // Interfaces merge by name, so a second declaration silently adds members that a one-declaration
  // lookup would never see: any interface looked up below that is declared twice fails closed.
  const declarations = declarationsByName(file);
  const reportedMerges = new Set<string>();
  const interfaces = {
    get(name: string): ts.InterfaceDeclaration | undefined {
      const all = declarations.get(name) ?? [];
      if (all.length > 1 && !reportedMerges.has(name)) {
        reportedMerges.add(name);
        problems.push(
          `interface ${name} is declared ${all.length} times (declaration merging): its merged members cannot be classified`,
        );
      }
      return all[0];
    },
  };
  const client = interfaces.get("NeweggClient");
  if (client === undefined)
    return [
      "interface NeweggClient not found in packages/sdk/src/types.ts or packages/sdk/src/types/",
    ];
  if (client.heritageClauses !== undefined) {
    problems.push("NeweggClient extends something: its inherited members cannot be classified");
  }
  const writeNamespaces = Object.keys(WRITE_NAMESPACE_READS);
  const seen = new Set<string>();
  for (const member of client.members) {
    const name = memberName(member);
    if (name === undefined) {
      problems.push(`NeweggClient has a member the guard cannot name: ${member.getText(file)}`);
      continue;
    }
    seen.add(name);
    if (CLIENT_PLAIN_MEMBERS.has(name)) continue;
    const isWrite = writeNamespaces.includes(name);
    if (!isWrite && !READ_ONLY_NAMESPACES.includes(name)) {
      problems.push(
        `NeweggClient.${name} is not classified in scripts/live-readonly/allowlists.ts: add it to WRITE_NAMESPACE_READS (with its read methods), READ_ONLY_NAMESPACES or CLIENT_PLAIN_MEMBERS`,
      );
      continue;
    }
    const type = ts.isPropertySignature(member) ? member.type : undefined;
    if (
      type === undefined ||
      !ts.isTypeReferenceNode(type) ||
      !ts.isIdentifier(type.typeName) ||
      type.typeArguments !== undefined
    ) {
      problems.push(
        `NeweggClient.${name} is not a plain interface reference (union, intersection, method, ...)`,
      );
      continue;
    }
    const api = interfaces.get(type.typeName.text);
    if (api === undefined || api.heritageClauses !== undefined) {
      problems.push(
        `${type.typeName.text} (NeweggClient.${name}) is not a plain interface the guard can read`,
      );
      continue;
    }
    const names = new Set<string>();
    for (const apiMember of api.members) {
      const apiName = memberName(apiMember);
      if (apiName === undefined) {
        problems.push(
          `${api.name.text} has a member the guard cannot name: ${apiMember.getText(file)}`,
        );
        continue;
      }
      names.add(apiName);
      if (isWrite) {
        const reads = WRITE_NAMESPACE_READS[name] ?? [];
        if (!reads.includes(apiName) && !WRITE_METHOD_NAMES.has(apiName)) {
          problems.push(
            `client.${name}.${apiName} is in neither the read allowlist nor WRITE_METHOD_NAMES (scripts/live-readonly/allowlists.ts): classify it`,
          );
        }
      } else {
        const allowed = READ_ONLY_NAMESPACE_MEMBERS[name] ?? [];
        if (WRITE_METHOD_NAMES.has(apiName) && !FUNCTION_HELPERS.has(apiName)) {
          problems.push(
            `client.${name}.${apiName} looks like a write method on a namespace classified read-only: reclassify ${name} or rename the method`,
          );
        } else if (!allowed.includes(apiName)) {
          problems.push(
            `client.${name}.${apiName} is not classified: classify this method as read (add it to READ_ONLY_NAMESPACE_MEMBERS in scripts/live-readonly/allowlists.ts) or write (move ${name} to WRITE_NAMESPACE_READS)`,
          );
        }
        // Nested report interfaces (`client.reports.dailyInventory.submit`).
        const nested = ts.isPropertySignature(apiMember) ? apiMember.type : undefined;
        if (
          nested !== undefined &&
          ts.isTypeReferenceNode(nested) &&
          ts.isIdentifier(nested.typeName)
        ) {
          const nestedName = nested.typeName.text;
          const nestedApi = interfaces.get(nestedName);
          const nestedAllowed = REPORT_INTERFACE_MEMBERS[nestedName];
          if (nestedApi === undefined || nestedApi.heritageClauses !== undefined) {
            problems.push(
              `${nestedName} (client.${name}.${apiName}) is not a plain interface the guard can read`,
            );
          } else if (nestedAllowed === undefined) {
            problems.push(
              `client.${name}.${apiName}: interface ${nestedName} is not classified: add it to REPORT_INTERFACE_MEMBERS in scripts/live-readonly/allowlists.ts`,
            );
          } else {
            const nestedNames = new Set<string>();
            for (const nestedMember of nestedApi.members) {
              const nestedMemberName = memberName(nestedMember);
              if (nestedMemberName === undefined) {
                problems.push(
                  `${nestedName} has a member the guard cannot name: ${nestedMember.getText(file)}`,
                );
                continue;
              }
              nestedNames.add(nestedMemberName);
              if (!nestedAllowed.includes(nestedMemberName)) {
                problems.push(
                  `client.${name}.${apiName}.${nestedMemberName} is not classified: classify this method as read (REPORT_INTERFACE_MEMBERS in scripts/live-readonly/allowlists.ts) or write`,
                );
              }
            }
            for (const read of nestedAllowed) {
              if (!nestedNames.has(read))
                problems.push(`allowlisted ${nestedName}.${read} no longer exists`);
            }
          }
        }
      }
    }
    const allowlisted = isWrite
      ? (WRITE_NAMESPACE_READS[name] ?? [])
      : (READ_ONLY_NAMESPACE_MEMBERS[name] ?? []);
    for (const read of allowlisted) {
      if (!names.has(read)) problems.push(`allowlisted member ${name}.${read} no longer exists`);
    }
  }
  for (const name of [...writeNamespaces, ...READ_ONLY_NAMESPACES, ...CLIENT_PLAIN_MEMBERS]) {
    if (!seen.has(name))
      problems.push(
        `scripts/live-readonly/allowlists.ts lists "${name}", which NeweggClient lacks`,
      );
  }
  return problems;
}

function declarationsByName(file: ts.SourceFile): Map<string, ts.InterfaceDeclaration[]> {
  const declarations = new Map<string, ts.InterfaceDeclaration[]>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      declarations.set(statement.name.text, [
        ...(declarations.get(statement.name.text) ?? []),
        statement,
      ]);
    }
  }
  return declarations;
}

const typeReferenceName = (member: ts.TypeElement): string | undefined =>
  ts.isPropertySignature(member) &&
  member.type !== undefined &&
  ts.isTypeReferenceNode(member.type) &&
  ts.isIdentifier(member.type.typeName)
    ? member.type.typeName.text
    : undefined;

/**
 * Names of the interfaces the surface check classifies: `NeweggClient`, the API interface behind
 * each of its members and the interfaces those reference (the nested report interfaces).
 */
export function classifiedInterfaceNames(typesSource: string): Set<string> {
  const file = ts.createSourceFile("types.ts", typesSource, ts.ScriptTarget.ESNext, true);
  const declarations = declarationsByName(file);
  const names = new Set<string>(["NeweggClient"]);
  const visit = (name: string, depth: number): void => {
    for (const decl of declarations.get(name) ?? []) {
      for (const member of decl.members) {
        const ref = typeReferenceName(member);
        if (ref === undefined || !declarations.has(ref)) continue;
        names.add(ref);
        if (depth < 2) visit(ref, depth + 1);
      }
    }
  };
  visit("NeweggClient", 0);
  return names;
}

/**
 * Declarations that could merge into a classified interface without the surface check reading
 * them. Interface declarations merge across files and modules (including through
 * `declare module "./x.js" { interface ... }` augmentation), so each of these could add an
 * unclassified method to the client:
 * - in a file outside the scanned types set (`scanned` false): any interface declaration of a
 *   classified name, wherever it sits;
 * - in a scanned file (`scanned` true): only declarations nested in a `declare module` /
 *   `declare global` / namespace block, since top-level ones are counted by the surface check;
 * - in any file: a class or enum of a classified name nested in such a block, or declared in the
 *   same module as an interface of that name, and any NeweggClient type alias / class / enum. A
 *   top-level class of the same name in a different module (an implementation class) does not
 *   merge with the interface and is allowed;
 * - in any file: an interface that `extends`, or a class that `extends` / `implements`, NeweggClient
 *   by bare, aliased-import (`import { NeweggClient as C }` or `import C = T.NeweggClient`) or
 *   qualified (`T.NeweggClient`) name (defense in depth).
 *
 * Not detected (documented gaps): a local type alias of the client under another name
 * (`type C = NeweggClient; interface X extends C {}`), an intersection alias
 * (`type C = NeweggClient & Foo`), a parenthesised heritage expression, and class expressions
 * (`const K = class implements NeweggClient {}`).
 */
export function strayClientDeclarations(
  source: string,
  fileName: string,
  names: ReadonlySet<string>,
  scanned = false,
): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const problems: string[] = [];
  const topLevelInterfaces = new Set(
    file.statements.filter(ts.isInterfaceDeclaration).map((d) => d.name.text),
  );
  // Local names bound to NeweggClient by `import { NeweggClient as X }` / `import type ... as X`
  // or by an import-equals alias (`import U = T.NeweggClient;`, or `import V = U;` of an alias).
  const clientAliases = new Set<string>(["NeweggClient"]);
  for (const stmt of file.statements) {
    if (ts.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.moduleReference;
      if (
        (ts.isQualifiedName(ref) && ref.right.text === "NeweggClient") ||
        (ts.isIdentifier(ref) && clientAliases.has(ref.text))
      ) {
        clientAliases.add(stmt.name.text);
      }
      continue;
    }
    const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === "NeweggClient") clientAliases.add(el.name.text);
    }
  }
  // True when an extends/implements clause names NeweggClient: a bare or aliased identifier, or a
  // qualified/property-access name ending in it (`T.NeweggClient` through a namespace import).
  const heritageNamesClient = (node: ts.InterfaceDeclaration | ts.ClassDeclaration): boolean =>
    node.heritageClauses?.some((clause) =>
      clause.types.some((t) => {
        const e = t.expression;
        if (ts.isIdentifier(e)) return clientAliases.has(e.text);
        return ts.isPropertyAccessExpression(e) && e.name.text === "NeweggClient";
      }),
    ) === true;
  const flag = (what: string): void => {
    problems.push(
      `${fileName} ${what}: its members cannot be classified (declaration merging or augmentation)`,
    );
  };
  const walk = (node: ts.Node, inModule: boolean): void => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) &&
      heritageNamesClient(node)
    ) {
      flag(`declares ${node.name?.text ?? "a class"}, which extends or implements NeweggClient`);
    }
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      if (names.has(name) && (inModule || !scanned)) {
        flag(
          `declares ${name} outside the top level of packages/sdk/src/types.ts and packages/sdk/src/types/`,
        );
      }
    } else if (
      (ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      const name = node.name.text;
      if (
        name === "NeweggClient" ||
        (names.has(name) && (inModule || topLevelInterfaces.has(name)))
      ) {
        flag(`declares ${name} as a class, enum or type alias alongside or inside the interface`);
      }
    }
    const nested = ts.isModuleDeclaration(node);
    ts.forEachChild(node, (child) => walk(child, inModule || nested));
  };
  walk(file, false);
  return problems;
}
