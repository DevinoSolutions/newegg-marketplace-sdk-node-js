// Syntax-tree helpers for the AST rules: client taint tracking, binding names, value references.
import ts from "typescript";
import { CLIENT_SOURCES, IDENTITY_METHODS } from "./allowlists.js";

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

export function boundNames(name: ts.BindingName, into: Set<string>): void {
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
export function clientHolders(sourceFile: ts.SourceFile): Set<string> {
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

export function keyText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Is `node` (an object/array literal) the left-hand side of a destructuring assignment? */
export function isAssignmentTarget(node: ts.Node): boolean {
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
export function isValueReference(node: ts.Identifier): boolean {
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
