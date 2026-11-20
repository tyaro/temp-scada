/** Canonical editor/import text: preserve spaces and blank lines, normalize separators to LF. */
export const normalizeTextNewlines = (text: string): string =>
  text.replace(/\r\n|[\r\u2028\u2029]/gu, "\n");
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** Mutates only the freshly parsed JSON input; malformed structure still goes to the schema. */
export function normalizeProjectText(value: unknown): void {
  const project = record(value);
  for (const key of ["screens", "symbols"]) {
    const owners = project?.[key];
    if (!Array.isArray(owners)) continue;
    for (const owner of owners) {
      const objects = record(owner)?.objects;
      if (!Array.isArray(objects)) continue;
      for (const object of objects) {
        const shape = record(record(object)?.shape);
        if (shape?.type === "text" && typeof shape.text === "string")
          shape.text = normalizeTextNewlines(shape.text);
        // 面の図形の文字（#305）。種類で分ける（画面切替ボタンの label は文字列で別の型）。
        if (
          shape?.type === "rectangle" ||
          shape?.type === "ellipse" ||
          shape?.type === "polygon"
        ) {
          const label = record(shape.label);
          if (label && typeof label.text === "string")
            label.text = normalizeTextNewlines(label.text);
        }
      }
    }
  }
}
