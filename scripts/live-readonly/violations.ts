// The per-file AST rules: what a live test file DOES, judged on the parsed tree.
import ts from "typescript";
import {
  ALLOWED_NODE_MODULES,
  ALLOWED_SPECIFIERS,
  ALLOWED_VITEST_NAMES,
  BANNED_GLOBALS,
  BANNED_PROPERTY_NAMES,
  OBJECT_ENUMERATORS,
  WRITE_METHOD_NAMES,
  WRITE_NAMESPACE_READS,
} from "./allowlists.js";
import { parseSource } from "./source.js";
import {
  boundNames,
  clientHolders,
  isAssignmentTarget,
  isValueReference,
  keyText,
} from "./ast-helpers.js";

/** Reported when a live file cannot be parsed, so the AST rules could not look at it. */
export const PARSE_FAILURE_REASON =
  "file does not parse as TypeScript — the guard cannot verify it";

/** Reasons the AST of `source` breaks the guard's rules. */
export function astViolations(source: string): string[] {
  const sourceFile = parseSource(source);
  const reasons = new Set<string>();
  const flag = (why: string): void => {
    reasons.add(why);
  };

  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
    flag(PARSE_FAILURE_REASON);
  }

  const holders = clientHolders(sourceFile);
  const namespaces = Object.keys(WRITE_NAMESPACE_READS);
  const isForbiddenMemberName = (name: string): boolean =>
    namespaces.includes(name) || WRITE_METHOD_NAMES.has(name) || BANNED_PROPERTY_NAMES.has(name);

  const checkSpecifier = (specifier: string): void => {
    if (ALLOWED_SPECIFIERS.has(specifier) || specifier === "vitest") return;
    if (ALLOWED_NODE_MODULES.has(specifier)) return;
    flag(
      `import of "${specifier}" — live files may import only vitest, ../../src/index.js, ./helpers.js and node:fs/path/url/util/assert/timers/promises (SDK internals, node:child_process/http/net and the like can write)`,
    );
  };

  const checkVitestImport = (node: ts.ImportDeclaration): void => {
    const clause = node.importClause;
    if (clause === undefined) return;
    const bindings = clause.namedBindings;
    if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
      flag("vitest imported by default/namespace — import only named test-API functions (no vi)");
      return;
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!ALLOWED_VITEST_NAMES.has(imported)) {
          flag(
            `vitest import "${imported}" — only describe/it/test/expect/before*/after* are allowed (vi.importActual and vi.mock load arbitrary modules)`,
          );
        }
      }
    }
  };

  // The one tolerated use of Object.*: enumerating the fields of ONE REPORT ROW, i.e.
  // `for (const row of result.rows) { Object.entries(row) }` where `result` is a `const` holding
  // an awaited value that never held a client and no function boundary lies between the loop and
  // the call. A row is plain data; a parameter, alias or anything else could be an SDK client.
  const isReportRowEnumeration = (call: ts.CallExpression): boolean => {
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isIdentifier(arg) || call.arguments.length !== 1) return false;
    let loop: ts.ForOfStatement | undefined;
    for (let up: ts.Node | undefined = call.parent; up !== undefined; up = up.parent) {
      if (ts.isFunctionLike(up)) return false;
      if (ts.isForOfStatement(up) && up.statement.pos <= call.pos && call.end <= up.statement.end) {
        loop = up;
        break;
      }
    }
    if (loop === undefined || !ts.isVariableDeclarationList(loop.initializer)) return false;
    const declaration = loop.initializer.declarations[0];
    if (
      loop.initializer.declarations.length !== 1 ||
      declaration === undefined ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== arg.text
    ) {
      return false;
    }
    const iterable = loop.expression;
    if (
      !ts.isPropertyAccessExpression(iterable) ||
      iterable.name.text !== "rows" ||
      !ts.isIdentifier(iterable.expression)
    ) {
      return false;
    }
    const resultName = iterable.expression.text;
    if (holders.has(resultName) || holders.has(arg.text)) return false;
    if (arg.text === resultName) return false;
    if (!resultUsedReadOnly(resultName)) return false;
    // No re-declaration of the loop variable inside the loop body.
    let shadowed = false;
    const scan = (n: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
        ts.isIdentifier(n.name) &&
        n.name.text === arg.text
      ) {
        shadowed = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(loop.statement);
    if (shadowed) return false;
    // `resultName` is declared exactly once, as `const resultName = await …`.
    const declarations: ts.VariableDeclaration[] = [];
    const find = (n: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
        ts.isIdentifier(n.name) &&
        n.name.text === resultName
      ) {
        if (ts.isVariableDeclaration(n)) declarations.push(n);
        else declarations.push(undefined as unknown as ts.VariableDeclaration);
      }
      ts.forEachChild(n, find);
    };
    find(sourceFile);
    const only = declarations[0];
    return (
      declarations.length === 1 &&
      only !== undefined &&
      ts.isVariableDeclarationList(only.parent) &&
      (only.parent.flags & ts.NodeFlags.Const) !== 0 &&
      only.initializer !== undefined &&
      isDirectReportRead(only.initializer)
    );
  };

  const patternBinds = (pattern: ts.BindingName, name: string): boolean => {
    const names = new Set<string>();
    boundNames(pattern, names);
    return names.has(name);
  };

  // Every declaration of `name` in the file (variables, parameters, bindings, functions, classes,
  // imports), so a shadowed or re-declared name is never mistaken for the real thing.
  const declarationsOf = (name: string): ts.Node[] => {
    const found: ts.Node[] = [];
    const walk = (n: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(n) ||
          ts.isParameter(n) ||
          ts.isBindingElement(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isClassDeclaration(n) ||
          ts.isImportSpecifier(n) ||
          ts.isNamespaceImport(n) ||
          ts.isImportClause(n)) &&
        n.name !== undefined &&
        (ts.isIdentifier(n.name)
          ? n.name.text === name
          : (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) &&
            patternBinds(n.name, name))
      ) {
        found.push(n);
      }
      ts.forEachChild(n, walk);
    };
    walk(sourceFile);
    return found;
  };

  const isFactoryCall = (expr: ts.Node): boolean => {
    if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return false;
    const factory = expr.expression.text;
    if (factory !== "makeLiveClient" && factory !== "createNeweggClient") return false;
    const declarations = declarationsOf(factory);
    return declarations.length === 1 && declarations.every((d) => ts.isImportSpecifier(d));
  };

  /** `name` only ever names a client built by the imported factory: `const name = makeLiveClient()`. */
  const isRealClient = (name: string): boolean => {
    const declarations = declarationsOf(name);
    return (
      declarations.length > 0 &&
      declarations.every(
        (d) =>
          ts.isVariableDeclaration(d) &&
          d.initializer !== undefined &&
          ts.isVariableDeclarationList(d.parent) &&
          (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
          isFactoryCall(d.initializer),
      )
    );
  };

  /** Is `node` assigned to, incremented, or deleted (directly or through a destructuring target)? */
  const isMutated = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return true;
    }
    if (ts.isDeleteExpression(parent)) return true;
    return isAssignmentTarget(node);
  };

  /**
   * The Object.* row exception trusts that `result.rows` still holds only report rows, so every
   * reference to the result binding must be one of: `result.<field>` read (not `rows`),
   * `for (const row of result.rows)`, `result.rows.length` read, or `Array.isArray(result.rows)`.
   * Assigning to it or its members, calling a method on `result.rows` (push, splice, ...), passing
   * `result` or `result.rows` anywhere else, and aliasing `result` all revoke the exception.
   */
  const resultUsedReadOnly = (resultName: string): boolean => {
    let ok = true;
    const walk = (n: ts.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(n) && n.text === resultName && isValueReference(n)) {
        const declaration = n.parent;
        // The declaration itself (`const result = await ...`).
        if (ts.isVariableDeclaration(declaration) && declaration.name === n) {
          ts.forEachChild(n, walk);
          return;
        }
        if (!ts.isPropertyAccessExpression(declaration) || declaration.expression !== n) {
          ok = false;
          return;
        }
        if (isMutated(declaration)) {
          ok = false;
          return;
        }
        const next = declaration.parent;
        if (declaration.name.text === "rows") {
          const iteratesRows = ts.isForOfStatement(next) && next.expression === declaration;
          const readsLength =
            ts.isPropertyAccessExpression(next) &&
            next.expression === declaration &&
            next.name.text === "length" &&
            !isMutated(next);
          const isArrayCheck =
            ts.isCallExpression(next) &&
            next.arguments[0] === declaration &&
            next.arguments.length === 1 &&
            ts.isPropertyAccessExpression(next.expression) &&
            ts.isIdentifier(next.expression.expression) &&
            next.expression.expression.text === "Array" &&
            next.expression.name.text === "isArray";
          if (!iteratesRows && !readsLength && !isArrayCheck) ok = false;
        } else {
          // `result.field.deeper.method(...)` or `result.field.x = ...` could mutate a member.
          let top: ts.Node = declaration;
          while (
            (ts.isPropertyAccessExpression(top.parent) ||
              ts.isElementAccessExpression(top.parent)) &&
            top.parent.expression === top
          ) {
            top = top.parent;
          }
          if (
            (ts.isCallExpression(top.parent) && top.parent.expression === top) ||
            isMutated(top)
          ) {
            ok = false;
          }
        }
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(sourceFile);
    return ok;
  };

  const REPORT_READS: ReadonlySet<string> = new Set(["waitForResult", "waitForRequest", "result"]);
  /** `await <real client>.reports.<report>.<waitForResult|waitForRequest|result>(...)`, nothing else. */
  const isDirectReportRead = (expr: ts.Node): boolean => {
    if (!ts.isAwaitExpression(expr) || !ts.isCallExpression(expr.expression)) return false;
    const callee = expr.expression.expression;
    if (!ts.isPropertyAccessExpression(callee) || !REPORT_READS.has(callee.name.text)) return false;
    const report = callee.expression;
    if (!ts.isPropertyAccessExpression(report)) return false;
    const reports = report.expression;
    if (!ts.isPropertyAccessExpression(reports) || reports.name.text !== "reports") return false;
    const receiver = reports.expression;
    return ts.isIdentifier(receiver) ? isRealClient(receiver.text) : isFactoryCall(receiver);
  };

  // JSON.stringify(value, replacer) calls the replacer with every value it visits (a client
  // included), so only the replacer-free forms are allowed.
  const checkJsonUse = (node: ts.Identifier): void => {
    const access = node.parent;
    const call = access.parent;
    if (
      ts.isPropertyAccessExpression(access) &&
      access.expression === node &&
      ts.isCallExpression(call) &&
      call.expression === access
    ) {
      const args = call.arguments;
      if (access.name.text === "parse" && args.length === 1) return;
      if (access.name.text === "stringify") {
        if (args.length === 1) return;
        const [, replacer, space] = args;
        if (
          args.length === 3 &&
          replacer !== undefined &&
          (replacer.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(replacer) && replacer.text === "undefined")) &&
          space !== undefined &&
          ts.isNumericLiteral(space)
        ) {
          return;
        }
      }
    }
    flag(
      "JSON used other than JSON.parse(text), JSON.stringify(value) or JSON.stringify(value, null, <number>) — a replacer/reviver function is invoked with every nested value (a client included)",
    );
  };

  const checkObjectUse = (node: ts.Identifier): void => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const call = parent.parent;
      if (
        OBJECT_ENUMERATORS.has(parent.name.text) &&
        ts.isCallExpression(call) &&
        call.expression === parent &&
        isReportRowEnumeration(call)
      ) {
        return;
      }
    }
    flag(
      "Object.* (values/entries/keys/getOwnProperty*/fromEntries/…) — it can enumerate SDK namespaces; the only tolerated use is Object.entries|values|keys(row) inside `for (const row of result.rows)` where `const result = await client.reports.<report>.waitForResult|waitForRequest|result(...)` is called on a client built by the imported makeLiveClient()",
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier.text);
        if (node.moduleSpecifier.text === "vitest") checkVitestImport(node);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      flag("import-equals declaration (import x = require(...)) — use plain ES imports");
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (literal !== undefined && ts.isStringLiteral(literal)) checkSpecifier(literal.text);
      else flag("import(...) type with a non-literal specifier");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        flag("dynamic import() — it can load SDK internals; use static imports of the allowed set");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        flag("require() — use static imports of the allowed set");
      }
    } else if (ts.isWithStatement(node)) {
      flag("with statement (brings every client member into scope unqualified)");
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      const onProcessEnv =
        node.expression.getText(sourceFile).replace(/\s+/g, "") === "process.env";
      if (ts.isNumericLiteral(key) || onProcessEnv) {
        // Array index / environment lookup: cannot name an SDK member.
      } else if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        if (isForbiddenMemberName(key.text)) {
          flag(
            `string-keyed access to "${key.text}" (client namespace, write method or reflection name) — use plain member access to a documented read`,
          );
        }
      } else {
        flag(
          "computed member access with a non-literal key (x[k], rows[i], x['r'+'ma']) — it can reach a write method on the SDK; index with a numeric literal, or use .at(n) / for-of / .map() instead",
        );
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (BANNED_PROPERTY_NAMES.has(name)) flag(`access to .${name} (reflection)`);
      if (WRITE_METHOD_NAMES.has(name)) {
        flag(
          `.${name} named in a live file — write methods (and call/apply/bind) may not be referenced on any receiver; if it is a plain data field the guard cannot tell it from an SDK method: pick another field or local name, or add a reviewed exception in scripts/live-readonly-ast.ts with a reason`,
        );
      }
      if (namespaces.includes(name)) checkNamespaceUse(node, name);
    } else if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) {
        if (element.dotDotDotToken !== undefined) continue;
        const key = element.propertyName ?? element.name;
        if (ts.isComputedPropertyName(key)) {
          flag("destructuring with a computed key");
        } else if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
          if (WRITE_METHOD_NAMES.has(key.text)) {
            flag(`destructuring of the write method ${key.text}`);
          }
          if (BANNED_PROPERTY_NAMES.has(key.text) || BANNED_GLOBALS.has(key.text)) {
            flag(
              `destructuring of ${key.text} (reflection, raw network access or code evaluation)`,
            );
          }
          if (namespaces.includes(key.text)) {
            flag(
              `destructuring of the ${key.text} namespace (variable, parameter or catch binding) — use client.${key.text}.<read>(...)`,
            );
          }
        }
      }
    } else if (ts.isObjectLiteralExpression(node) && isAssignmentTarget(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          if (isForbiddenMemberName(property.name.text) || BANNED_GLOBALS.has(property.name.text)) {
            flag(`destructuring assignment of ${property.name.text}`);
          }
        } else if (ts.isPropertyAssignment(property)) {
          if (ts.isComputedPropertyName(property.name)) {
            flag("destructuring assignment with a computed key");
          } else {
            const text = keyText(property.name);
            if (text !== undefined && (isForbiddenMemberName(text) || BANNED_GLOBALS.has(text))) {
              flag(`destructuring assignment of ${text}`);
            }
          }
        }
      }
    } else if (ts.isIdentifier(node)) {
      if (BANNED_GLOBALS.has(node.text) && isValueReference(node)) {
        flag(`reference to ${node.text} (raw network access or indirect invocation)`);
      }
      if (node.text === "Object" && isValueReference(node)) checkObjectUse(node);
      if (node.text === "JSON" && isValueReference(node)) checkJsonUse(node);
      if (node.text === "process" && isValueReference(node)) {
        const parent = node.parent;
        if (!(
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "env"
        )) {
          flag(
            "process used other than process.env — process.getBuiltinModule / mainModule / binding can load modules; for platform or timing needs add the exact property to the guard's allowlist in the same PR with a reason",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  function checkNamespaceUse(node: ts.PropertyAccessExpression, name: string): void {
    // Result pages carry plain `orders` / `rmas` / `refunds` arrays (`page.orders`).
    if (ts.isIdentifier(node.expression) && /[Pp]age$/.test(node.expression.text)) return;
    const reads = WRITE_NAMESPACE_READS[name] ?? [];
    const member = node.parent;
    if (
      ts.isPropertyAccessExpression(member) &&
      member.expression === node &&
      reads.includes(member.name.text) &&
      ts.isCallExpression(member.parent) &&
      member.parent.expression === member
    ) {
      return;
    }
    flag(
      reads.length === 0
        ? `.${name} touched — the live suite may not use the ${name} namespace at all`
        : `.${name} used other than to call a read (${reads.join("/")}): aliasing, binding, casting, optional-chain non-null and write calls are forbidden`,
    );
  }

  visit(sourceFile);
  return [...reasons];
}
