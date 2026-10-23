const fs=require("fs");const file="redact.ts";
const CR=String.fromCharCode(13);
const raw=fs.readFileSync(file,"utf8");const crlf=raw.includes(CR);let s=raw.split(CR).join("");
function rep(a,b){if(!s.includes(a))throw new Error("missing "+a.slice(0,60));s=s.replace(a,()=>b);}
rep(`  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn) as object | null);
  for (const key of Reflect.ownKeys(fn)) {
    const descriptor = forwardPrivateAccess(`,
`  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn) as object | null);
  // A fresh prototype object that inherits from the original's keeps \`new wrapper() instanceof
  // Original\` true without pointing back (through \`constructor\`) at the original and its secrets.
  const original: unknown = fn.prototype;
  if (typeof original === "object" && original !== null) {
    const fresh = Object.create(original) as object;
    Object.defineProperty(fresh, "constructor", {
      value: wrapper,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(wrapper, "prototype", { value: fresh, writable: true });
  }
  for (const key of Reflect.ownKeys(fn)) {
    if (FUNCTION_SKIP(key)) continue;
    const descriptor = forwardPrivateAccess(`);
rep(` * properties replaces it. \`prototype\` is not walked (it points back at the function) but is
 * shared with the original, so \`new wrapper() instanceof Original\` holds.`,
` * properties replaces it. \`prototype\` is not walked (it points back at the function); the wrapper
 * gets a fresh one that inherits from the original's, so \`new wrapper() instanceof Original\` holds.`);
rep(`if (descriptor === undefined || isChanged || key === "prototype") return descriptor;`,`if (descriptor === undefined || isChanged) return descriptor;`);
// native check: accessors only, and only above built-in kinds cloneBase copies itself
rep(`    while (proto !== null && proto !== Object.prototype) {
      for (const key of Reflect.ownKeys(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor === undefined) continue;
        const hooks = key === inspect.custom || key === "toJSON" ? [descriptor.value] : [];
        for (const fn of [descriptor.get, descriptor.set, ...hooks] as unknown[]) {
          if (typeof fn !== "function") continue;
          const source = Function.prototype.toString.call(fn);
          if (source.includes("#") || source.includes("[native code]")) return true;
        }
      }`,
`    while (proto !== null && proto !== Object.prototype && !COPIED_BUILTIN_PROTOTYPES.has(proto)) {
      for (const key of Reflect.ownKeys(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor === undefined) continue;
        const hooks = key === inspect.custom || key === "toJSON" ? [descriptor.value] : [];
        for (const fn of [descriptor.get, descriptor.set, ...hooks] as unknown[]) {
          if (typeof fn !== "function") continue;
          const source = Function.prototype.toString.call(fn);
          const native = source.includes("[native code]") && fn !== descriptor.value;
          if (source.includes("#") || native) return true;
        }
      }`);
rep(`/**
 * Whether a same-prototype copy`,`/** Built-in kinds whose internal value {@link cloneBase} carries over, so their natives are fine. */
const COPIED_BUILTIN_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  Date.prototype,
  RegExp.prototype,
  Number.prototype,
  String.prototype,
  Boolean.prototype,
  Error.prototype,
]);

/**
 * Whether a same-prototype copy`);
fs.writeFileSync(file,crlf?s.split("\n").join(CR+"\n"):s);
