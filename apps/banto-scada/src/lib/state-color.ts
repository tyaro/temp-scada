import type { Project, ScreenObject, SymbolDefinition } from "./project";
import { boolSlotState } from "./slot-presentation";
import {
  resolveSymbolSlot,
  slotPresentation,
  type EquipmentContext,
} from "./symbol-slots";
export function supportsStateColor(object: ScreenObject): boolean {
  const shape = object.shape;
  return (
    shape.type === "polyline" ||
    ((shape.type === "rectangle" || shape.type === "ellipse") &&
      shape.paint.fill.enabled &&
      shape.paint.fill.paint.type === "solid")
  );
}
export function stateColorSources(definition: SymbolDefinition) {
  return definition.objects.filter(
    (object) =>
      object.shape.type === "text" &&
      object.shape.boolColors &&
      definition.readSlots?.some(
        (slot) =>
          slot.name ===
            (object.shape.type === "text"
              ? object.shape.slotBinding?.slotName
              : undefined) && slot.type === "bool",
      ),
  );
}
export function stateColorUsages(definition: SymbolDefinition, textId: string) {
  return definition.objects.filter(
    (object) =>
      "stateColor" in object.shape &&
      object.shape.stateColor?.textId === textId,
  );
}
export function validateStateColors(project: Project) {
  for (const owner of [...project.screens, ...project.symbols]) {
    const definition = project.symbols.includes(owner as SymbolDefinition)
      ? (owner as SymbolDefinition)
      : undefined;
    const sources = new Set(
      definition
        ? stateColorSources(definition).map((source) => source.id)
        : [],
    );
    for (const object of owner.objects) {
      if (!("stateColor" in object.shape) || !object.shape.stateColor) continue;
      if (!definition || !sources.has(object.shape.stateColor.textId))
        throw new Error(
          "状態色の配色元Textが見つからないか、有効なbool配色ではありません",
        );
      if (!supportsStateColor(object))
        throw new Error(
          "状態色の追従には有効な単色塗りが必要です。先に追従を解除してください。",
        );
    }
  }
}
/** A missing source never falls back to a normal authored color. */
export function resolveStateColor(
  object: ScreenObject,
  definition: SymbolDefinition,
  equipmentId?: string,
  context?: EquipmentContext,
): string | undefined {
  if (!("stateColor" in object.shape) || !object.shape.stateColor)
    return undefined;
  const reference = object.shape.stateColor;
  const source = definition.objects.find(
    (item) => item.id === reference.textId,
  );
  if (
    source?.shape.type !== "text" ||
    !source.shape.boolColors ||
    !source.shape.slotBinding
  )
    return "#64748b";
  const display = resolveSymbolSlot(
    definition,
    source.shape.slotBinding.slotName,
    equipmentId,
    context,
  );
  const state = boolSlotState(display ?? slotPresentation("unbound")).state;
  return source.shape.boolColors[
    state === "true"
      ? "trueColor"
      : state === "false"
        ? "falseColor"
        : "unknownColor"
  ];
}
