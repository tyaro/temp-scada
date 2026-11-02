/** Text semantics for bounded, already-owned JSON contracts. */
/** Unicode White_Space plus FEFF, explicitly shared with native; no trim(). */
export function blankJsonText(text: string): boolean {
  return /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/.test(
    text,
  );
}
function scalar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
/** Run only on the bounded owned plain JSON, including keys before schema. */
export function scalarJson(value: unknown): boolean {
  if (typeof value === "string") return scalar(value);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => scalar(key) && scalarJson(child),
  );
}
