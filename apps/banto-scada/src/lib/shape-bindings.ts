import type { ScreenObject, TagBinding } from "./project";

/** Shapes that read one value: a Text and a level. */
type ReadingShape = Extract<ScreenObject["shape"], { type: "text" | "level" }>;

function readingShape(shape: ScreenObject["shape"]): ReadingShape | undefined {
  return shape.type === "text" || shape.type === "level" ? shape : undefined;
}

/** The tag a screen Text or level reads directly. */
export function shapeTagBinding(
  shape: ScreenObject["shape"],
): TagBinding | undefined {
  return readingShape(shape)?.binding;
}

/** The slot a Text or level inside a shared Symbol reads. */
export function shapeSlotName(
  shape: ScreenObject["shape"],
): string | undefined {
  return readingShape(shape)?.slotBinding?.slotName;
}
