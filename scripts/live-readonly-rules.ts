// Allowlist rules of the live read-only guard (see check-live-readonly.ts), applied to the
// whitespace-normalised source of each live file.
//
// The per-line method patterns in check-live-readonly.ts are a denylist, which aliasing
// (`const r = client.rma; r.submit(x)`), destructuring, bracket access, `.bind`, `Reflect.apply`
// and line-wrapped chains all evade. For the money-moving namespaces the rule is therefore
// inverted: the ONLY thing a live file may do with `<expr>.rma` / `<expr>.refunds` is call a
// documented READ. A receiver named `*Page` is exempt (the result pages carry plain `rmas` /
// `refunds` arrays). Contracts §18 (reads) and §20 (writes).

const RMA_READS = "list|get|tryGet";
const REFUND_READS = "list|get|tryGet|listRequests|getRequestStatus";

/** `<expr>.<namespace>` that is not immediately followed by `.<allowed read>`. */
function namespaceRule(namespace: string, reads: string): RegExp {
  return new RegExp(`(?<![Pp]age)\\??\\.${namespace}\\b(?!\\??\\.(?:${reads})(?![\\w$]))`);
}

const NORMALIZED_RULES: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: namespaceRule("rma", RMA_READS),
    why: "client.rma used other than to call a read (list/get/tryGet): aliasing, bracket access, bind and write calls are forbidden",
  },
  {
    re: namespaceRule("refunds", REFUND_READS),
    why: "client.refunds used other than to call a read (list/get/tryGet/listRequests/getRequestStatus): aliasing, bracket access, bind and write calls are forbidden",
  },
  {
    re: /\[["'`](?:rma|refunds)["'`]\]/,
    why: "string-keyed access to the rma/refunds namespace",
  },
  {
    re: /\{[^{}]*\b(?:rma|refunds)\b[^{}]*\}\s*(?::[^=;{}]*)?=[^=>]|\{[^{}]*\b(?:rma|refunds)\b[^{}]*\}\s*\)\s*=>/,
    why: "destructuring of the rma/refunds namespace",
  },
  {
    re: /\b\w*[Cc]lient\w*(?:\?\.)?\[|makeLiveClient\(\)(?:\?\.)?\[/,
    why: "computed property access on the SDK client",
  },
  { re: /\bReflect\b/, why: "Reflect (can invoke a write method indirectly)" },
  { re: /\beval\s*\(|\bnew\s+Function\b/, why: "dynamic code evaluation" },
];

/** Collapses whitespace around member access so a line-wrapped chain matches like a one-liner. */
function normalizeSource(source: string): string {
  return source
    .replace(/\s*(\?\.|\.)\s*/g, "$1")
    .replace(/\s*\[\s*/g, "[")
    .replace(/\s+/g, " ");
}

/** Reasons the normalised `source` breaks the allowlist rules. */
export function normalizedViolations(source: string): string[] {
  const normalized = normalizeSource(source);
  return NORMALIZED_RULES.filter(({ re }) => re.test(normalized)).map(({ why }) => why);
}

/** Known bypasses of the per-line denylist: every one MUST be flagged. */
export const MUST_FLAG: ReadonlyArray<string> = [
  "const r = client.rma; await r.submit(x);",
  "const { submit } = client.rma; await submit(x);",
  "await client.rma['submit'](x);",
  "await client.rma\n  .submit(x);",
  "await client.rma\n.\nsubmit\n(x);",
  "const f = client.rma.submit.bind(client.rma); await f(x);",
  "await Reflect.apply(client.rma.submit, client.rma, [x]);",
  "await client.rma?.['submit'](x);",
  "await client.rma!.submit(x);",
  "const { rma } = client; await rma.submit(x);",
  "const { refunds: r } = makeLiveClient(); await r.issue(x);",
  "run(({ rma }) => rma.process(x));",
  "const r = client.refunds; await r.issue(x);",
  "await client['refunds']['issue'](x);",
  "const k = 'rma'; await client[k].submit(x);",
  "await client.refunds\n  .issue(x);",
  "await client.rma.previewSubmit(x);",
  "await client.rma.getEvil(x);",
  "await client.refunds.issue(x);",
];

/** Legitimate reads: every one MUST pass. */
export const MUST_PASS: ReadonlyArray<string> = [
  "const page = await client.rma.list({ pageSize: 5 });",
  "const one = await client.rma.get('1');",
  "await client.rma.tryGet('1');",
  "await makeLiveClient().refunds.listRequests({ maxCount: 5 });",
  "await client.refunds.getRequestStatus('1');",
  "await client.refunds\n  .list({});",
  "expect(Array.isArray(refundsPage.refunds)).toBe(true);",
  "for (const rma of rmasPage.rmas) expect(rma.rmaNumber).toBeTruthy();",
  "await client.reports.rmaList.waitForResult(x);",
];
