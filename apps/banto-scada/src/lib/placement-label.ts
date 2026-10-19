import type { ScreenObject, SymbolDefinition } from "./project";

/** Display labels never participate in reference resolution or object identity. */
export function placementLabel(
  object: ScreenObject,
  definitions: SymbolDefinition[] = [],
): string {
  if (object.name) return object.name;
  const kind =
    object.shape.type === "symbol"
      ? (definitions.find(
          (definition) =>
            object.shape.type === "symbol" &&
            definition.id === object.shape.symbolId,
        )?.name ?? "Symbol")
      : object.shape.type;
  return `${kind} · ${object.order}`;
}
