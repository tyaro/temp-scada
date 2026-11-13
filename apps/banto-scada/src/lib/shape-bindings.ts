import type { ScreenObject, TagBinding } from "./project";
import { tableCellBindings, tableCellSlotNames } from "./table";

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

/**
 * The slots a shape inside a shared Symbol reads: none or one for a Text or
 * level, and every slot-bound cell of a table (row by row, repeats kept).
 */
export function shapeSlotNames(shape: ScreenObject["shape"]): string[] {
  if (shape.type === "table") return tableCellSlotNames(shape);
  const slotName = readingShape(shape)?.slotBinding?.slotName;
  return slotName === undefined ? [] : [slotName];
}
