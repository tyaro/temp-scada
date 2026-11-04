/** Only bounded validated owned JSON; preserves array order. */
export function sameOwnedJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameOwnedJson(v, b[i]))
    );
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (k) => Object.hasOwn(right, k) && sameOwnedJson(left[k], right[k]),
    )
  );
}
