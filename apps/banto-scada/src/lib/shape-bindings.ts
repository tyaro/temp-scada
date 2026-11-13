import type { ScreenObject, TagBinding } from "./project";
import { tableCellBindings } from "./table";

/** Shapes that read one value: a Text and a level. */
type ReadingShape = Extract<ScreenObject["shape"], { type: "text" | "level" }>;

function readingShape(shape: ScreenObject["shape"]): ReadingShape | undefined {
  return shape.type === "text" || shape.type === "level" ? shape : undefined;
}

/**
 * The tags a screen shape reads directly: none or one for a Text or level,
 * and every bound cell of a table (row by row).
 */
export function shapeTagBindings(shape: ScreenObject["shape"]): TagBinding[] {
  if (shape.type === "table") return tableCellBindings(shape);
  const binding = readingShape(shape)?.binding;
  return binding ? [binding] : [];
}

/** The slot a Text or level inside a shared Symbol reads. */
export function shapeSlotName(
  shape: ScreenObject["shape"],
): string | undefined {
  return readingShape(shape)?.slotBinding?.slotName;
}
