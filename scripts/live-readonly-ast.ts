// AST rules of the live read-only guard (see check-live-readonly.ts and live-readonly-rules.ts).
//
// The regex rules run on text, so comments, computed access, reflection, destructuring in
// parameter position and direct imports of SDK internals all slip past them. These rules parse
// each live file with the TypeScript compiler and judge what the code DOES, not how it is spelled.
// The guard may only get stricter: when a legitimate new read trips a rule, extend the lists
// below in the same PR and say why; that review moment is the point of the guard.
//
// This file is the entry point (its path and exports are used by check-live-readonly.ts and
// live-readonly-rules.ts); the implementation lives in live-readonly/: allowlists.ts (rule data),
// source.ts (parsing), ast-helpers.ts (tree helpers), violations.ts (per-file rules) and
// surface.ts (client-surface classification check).
export { parseSource, stripComments } from "./live-readonly/source.js";
export { PARSE_FAILURE_REASON, astViolations } from "./live-readonly/violations.js";
export { clientSurfaceProblems } from "./live-readonly/surface.js";
