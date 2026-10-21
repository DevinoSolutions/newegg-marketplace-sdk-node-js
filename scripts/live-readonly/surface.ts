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
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
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
        `NeweggClient.${name} is not classified in scripts/live-readonly-ast.ts: add it to WRITE_NAMESPACE_READS (with its read methods), READ_ONLY_NAMESPACES or CLIENT_PLAIN_MEMBERS`,
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
            `client.${name}.${apiName} is in neither the read allowlist nor WRITE_METHOD_NAMES (scripts/live-readonly-ast.ts): classify it`,
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
            `client.${name}.${apiName} is not classified: classify this method as read (add it to READ_ONLY_NAMESPACE_MEMBERS in scripts/live-readonly-ast.ts) or write (move ${name} to WRITE_NAMESPACE_READS)`,
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
              `client.${name}.${apiName}: interface ${nestedName} is not classified: add it to REPORT_INTERFACE_MEMBERS in scripts/live-readonly-ast.ts`,
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
                  `client.${name}.${apiName}.${nestedMemberName} is not classified: classify this method as read (REPORT_INTERFACE_MEMBERS in scripts/live-readonly-ast.ts) or write`,
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
      problems.push(`scripts/live-readonly-ast.ts lists "${name}", which NeweggClient lacks`);
  }
  return problems;
}
