// AST rules of the live read-only guard (see check-live-readonly.ts and live-readonly-rules.ts).
//
// The regex rules run on text, so comments, computed access, reflection, destructuring in
// parameter position and direct imports of SDK internals all slip past them. These rules parse
// each live file with the TypeScript compiler and judge what the code DOES, not how it is spelled.
// The guard may only get stricter: when a legitimate new read trips a rule, extend the lists
// below in the same PR and say why; that review moment is the point of the guard.
import ts from "typescript";

/**
 * Client namespaces that have write methods, with the ONLY methods a live file may call on them
 * (contracts §18 / §15 / §20). `<expr>.<namespace>` may appear only as `<expr>.<namespace>.<read>(`.
 * A namespace with an empty list may not be touched at all.
 */
const WRITE_NAMESPACE_READS: Readonly<Record<string, readonly string[]>> = {
  inventory: ["getItem", "tryGetItem", "getMany"],
  pricing: ["get", "tryGet", "getMany"],
  feeds: ["getStatus", "getResult", "waitForResult"],
  orders: ["list", "get", "tryGet", "getStatus", "tryGetStatus"],
  listings: [],
  rma: ["list", "get", "tryGet"],
  refunds: ["list", "get", "tryGet", "listRequests", "getRequestStatus"],
};

/**
 * Every write method on the write namespaces (and its read-only `preview*` twin). A live file may
 * not even NAME one, on any receiver: that closes aliasing through values the taint tracking cannot
 * see (a parameter, a destructured array element). check-live-readonly.ts fails when an SDK method
 * on a write namespace is in neither this set nor the namespace's read list above.
 */
const WRITE_METHOD_NAMES: ReadonlySet<string> = new Set([
  "updateItem",
  "updateMany",
  "submitInventoryFeed",
  "ship",
  "cancel",
  "confirmDownload",
  "removeItems",
  "create",
  "previewCreate",
  "update",
  "previewUpdate",
  "submit",
  "previewSubmit",
  "edit",
  "previewEdit",
  "process",
  "previewProcess",
  "reject",
  "previewReject",
  "issue",
  "previewIssue",
  // Function.prototype helpers that re-bind or re-invoke a method without naming a write verb.
  "call",
  "apply",
  "bind",
]);

/**
 * Client namespaces that are read-only by contract (they create report jobs or read reference
 * data). Together with WRITE_NAMESPACE_READS this must cover every `readonly x: <Name>Api` member
 * of `NeweggClient`; clientSurfaceProblems fails when a new namespace is in neither list.
 */
const READ_ONLY_NAMESPACE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  service: ["getStatus"],
  reference: [
    "getSellerStatus",
    "listIndustries",
    "listSubcategories",
    "listSubcategoryProperties",
    "listPropertyValues",
  ],
  catalog: ["resolve", "submitLookup", "lookupStatus", "lookupResult"],
  reports: [
    "itemBasicInfo",
    "orderList",
    "rmaList",
    "settlementSummary",
    "settlementTransactions",
    "dailyInventory",
    "dailyPrice",
    "status",
  ],
  storefront: ["getOffers"],
};

/**
 * The report interfaces that `client.reports.<report>` members are typed with, and their methods.
 * Report submission creates a report job and mutates nothing on the seller account (contracts
 * §17); a new method here must be classified before a live file may call it.
 */
const REPORT_INTERFACE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  FileReportApi: ["submit", "status", "result", "download", "waitForRequest", "waitForResult"],
  PagedReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
  SettlementSummaryReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
  SettlementTransactionReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
};

const READ_ONLY_NAMESPACES: readonly string[] = Object.keys(READ_ONLY_NAMESPACE_MEMBERS);

// Live files may import exactly these, plus the vitest API below and a few harmless node: modules.
// Importing SDK internals (e.g. `new RmaApiImpl(...)` from ../../src/rma/api.js) builds a write
// client the namespace rules cannot see. node:child_process / http / net can reach the network.
const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set(["../../src/index.js", "./helpers.js"]);
const ALLOWED_NODE_MODULES: ReadonlySet<string> = new Set([
  "node:fs",
  "node:path",
  "node:url",
  "node:util",
  "node:assert",
  "node:assert/strict",
  "node:timers/promises",
]);
// `vi` is excluded on purpose: vi.importActual / vi.mock load arbitrary modules.
const ALLOWED_VITEST_NAMES: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
  "it",
  "test",
]);

// Values that can start a request or run code without going through the SDK.
const BANNED_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "globalThis",
  "global",
  "eval",
  "Function",
  "Reflect",
  "Proxy",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);
// `.constructor` reaches Object / Function from any value (`({}).constructor.values(client)`,
// `[].constructor.constructor("return globalThis")()`), so it and `.prototype` are banned as
// properties, string keys and destructuring keys.
const BANNED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__defineGetter__",
  "__defineSetter__",
]);

// A string-literal key (`raw["AvailableQuantity"]`) is statically resolvable, so it is judged by
// what it names: a client namespace, a write method or a reflection name is refused; any other
// literal (`raw["ShipVia"]`, `raw["UpdateDate"]`) is plain data. Any non-literal computed key is
// refused outright (`x[k]`, `x['r'+'ma']`, a template with substitutions).

const CLIENT_SOURCES: ReadonlySet<string> = new Set([
  "makeLiveClient",
  "createNeweggClient",
  "NeweggClient",
]);
// `Object.<fn>(row)` is tolerated only for these (see isReportRowEnumeration).
const OBJECT_ENUMERATORS: ReadonlySet<string> = new Set(["entries", "values", "keys"]);
// Array/promise methods that hand back (one of) the receiver's elements.
const IDENTITY_METHODS: ReadonlySet<string> = new Set([
  "at",
  "find",
  "pop",
  "shift",
  "slice",
  "filter",
  "concat",
  "flat",
  "reverse",
  "sort",
  "map",
]);

export function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "live.ts",
    source,
    {
      languageVersion: ts.ScriptTarget.ESNext,
      // Live files are ES modules: top-level await must parse.
      setExternalModuleIndicator: (file) => {
        (file as { externalModuleIndicator?: boolean }).externalModuleIndicator = true;
      },
    },
    true,
    ts.ScriptKind.TS,
  );
}

function isJsDocKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * `source` with every comment replaced by blanks (newlines kept, so line numbers survive). Comment
 * ranges come from the parser's token trivia, so comment-looking text inside strings, templates
 * and regex literals is left alone, and a comment between the members of a call chain
 * (`client./*c*\/rma.submit(x)`) cannot hide it from the line- and whitespace-based rules.
 */
export function stripComments(source: string, sourceFile: ts.SourceFile): string {
  const ranges = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    if (isJsDocKind(node.kind)) return;
    for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? []) {
      ranges.set(range.pos, range.end);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  let out = "";
  let cursor = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < cursor) continue;
    out += source.slice(cursor, start);
    out += source.slice(start, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return out + source.slice(cursor);
}

function typeMentionsClient(type: ts.Node | undefined): boolean {
  if (type === undefined) return false;
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && CLIENT_SOURCES.has(node.text)) found = true;
    else ts.forEachChild(node, walk);
  };
  walk(type);
  return found;
}

function boundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) boundNames(element.name, into);
  }
}

/**
 * Names (any scope, by name) that may hold an SDK client, one of its namespaces, or a function
 * returning one. Taint flows through aliases, wrappers and containers but NOT through the result of
 * a method call on a client (`await client.reports.x.waitForResult()` is data, not a client).
 */
function clientHolders(sourceFile: ts.SourceFile): Set<string> {
  const tainted = new Set<string>();
  const isSource = (name: string): boolean => CLIENT_SOURCES.has(name) || tainted.has(name);

  const returnsClient = (fn: ts.FunctionLikeDeclaration): boolean => {
    if (typeMentionsClient(fn.type)) return true;
    const body = fn.body;
    if (body === undefined) return false;
    if (!ts.isBlock(body)) return yields(body);
    let found = false;
    const walk = (node: ts.Node): void => {
      if (found) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined && yields(node.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    return found;
  };

  function classHoldsClient(cls: ts.ClassLikeDeclaration): boolean {
    return cls.members.some((member) => {
      if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
        return returnsClient(member);
      }
      if (ts.isConstructorDeclaration(member)) {
        return member.parameters.some((parameter) => typeMentionsClient(parameter.type));
      }
      if (ts.isPropertyDeclaration(member)) {
        return (
          typeMentionsClient(member.type) || (!!member.initializer && yields(member.initializer))
        );
      }
      return false;
    });
  }

  function yields(expr: ts.Node): boolean {
    if (ts.isIdentifier(expr)) return isSource(expr.text);
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isAwaitExpression(expr) ||
      ts.isSpreadElement(expr)
    ) {
      return yields(expr.expression);
    }
    if (ts.isConditionalExpression(expr)) return yields(expr.whenTrue) || yields(expr.whenFalse);
    if (ts.isBinaryExpression(expr)) return yields(expr.left) || yields(expr.right);
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.some(yields);
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) return yields(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return isSource(property.name.text);
        if (ts.isSpreadAssignment(property)) return yields(property.expression);
        // Methods and accessors are functions: `{ make() { return client; } }`.
        if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
          return returnsClient(property);
        }
        return false;
      });
    }
    if (ts.isClassExpression(expr)) return classHoldsClient(expr);
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      return yields(expr.expression);
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return returnsClient(expr);
    if (ts.isNewExpression(expr)) {
      return yields(expr.expression) || (expr.arguments ?? []).some(yields);
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      if (ts.isIdentifier(callee) && isSource(callee.text)) return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        IDENTITY_METHODS.has(callee.name.text) &&
        yields(callee.expression)
      ) {
        return true;
      }
      return expr.arguments.some(yields);
    }
    return false;
  }

  let changed = true;
  const mark = (name: string): void => {
    if (!tainted.has(name)) {
      tainted.add(name);
      changed = true;
    }
  };
  const markBound = (name: ts.BindingName): void => {
    const names = new Set<string>();
    boundNames(name, names);
    for (const n of names) mark(n);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      if (typeMentionsClient(node.type) || (node.initializer && yields(node.initializer))) {
        markBound(node.name);
      }
    } else if (ts.isParameter(node)) {
      if (typeMentionsClient(node.type)) markBound(node.name);
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.name !== undefined && returnsClient(node)) mark(node.name.text);
    } else if (ts.isClassDeclaration(node)) {
      if (node.name !== undefined && classHoldsClient(node)) mark(node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      yields(node.right)
    ) {
      mark(node.left.text);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      ts.isVariableDeclarationList(node.initializer) &&
      yields(node.expression)
    ) {
      for (const declaration of node.initializer.declarations) markBound(declaration.name);
    }
    ts.forEachChild(node, visit);
  };
  while (changed) {
    changed = false;
    visit(sourceFile);
  }
  return tainted;
}

function keyText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Is `node` (an object/array literal) the left-hand side of a destructuring assignment? */
function isAssignmentTarget(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) return false;
    if (ts.isBinaryExpression(parent)) {
      return (
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        parent.left === current
      );
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.initializer === current;
    }
    if (
      ts.isPropertyAssignment(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isParenthesizedExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return false;
  }
}

/** Is this identifier a reference to a value, rather than a member name, label or type name? */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isTypeReferenceNode(parent)) return false;
  return true;
}

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
    return ["interface NeweggClient not found in packages/sdk/src/types.ts"];
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
