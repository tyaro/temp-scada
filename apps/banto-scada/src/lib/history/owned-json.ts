/** Copy bounded plain JSON without evaluating accessors or retaining source
 * ownership. This is a structured-data boundary, not a wire parser/sandbox. */
export function ownHistoryJson(input: unknown, maxBytes: number): unknown {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) throw Error("History data limit");
  };
  function stringBytes(text: string) {
    if (text.length > maxBytes - bytes) throw Error("History data limit");
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          add(4);
          i++;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 250_000 || depth > 32) throw Error("History data limit");
    if (value === null) {
      add(4);
      return null;
    }
    if (typeof value === "boolean") {
      add(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      add(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      stringBytes(value);
      return value;
    }
    if (typeof value !== "object") throw Error("History data shape");
    if (ancestors.has(value)) throw Error("History data cycle");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw Error("History data shape");
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > 250_000 - nodes ||
      keys.some((key) => typeof key !== "string")
    )
      throw Error("History data shape");
    ancestors.add(value);
    const property = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw Error("History data shape");
      return descriptor.value as unknown;
    };
    add(2);
    let owned: unknown;
    if (array) {
      const size = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 250_000 - nodes ||
        keys.length !== size + 1
      )
        throw Error("History data shape");
      const result: unknown[] = [];
      for (let i = 0; i < size; i++) {
        if (i) add(1);
        result.push(visit(property(String(i)), depth + 1));
      }
      owned = result;
    } else {
      const result: Record<string, unknown> = Object.create(null);
      keys.forEach((key, index) => {
        if (index) add(1);
        stringBytes(key as string);
        add(1);
        result[key as string] = visit(property(key as string), depth + 1);
      });
      owned = result;
    }
    ancestors.delete(value);
    return owned;
  }
  return visit(input, 0);
}

/** Only call on owned plain JSON. */
export function freezeHistory<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeHistory(child);
    Object.freeze(value);
  }
  return value;
}
