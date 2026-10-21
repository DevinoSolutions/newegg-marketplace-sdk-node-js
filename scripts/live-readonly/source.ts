// Parsing helpers shared by the AST and regex rules of the live read-only guard.
import ts from "typescript";

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
