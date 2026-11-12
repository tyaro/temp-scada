import type { Project, ScreenObject, SymbolDefinition } from "./project";
import { isStateSlotType } from "./equipment";
import { evaluateSlotState } from "./slot-state";
import {
  resolveSymbolSlot,
  symbolEquipmentSlot,
  type EquipmentContext,
} from "./symbol-slots";
/** Shown when a follower's source Text is missing or invalid (fail closed). */
export const UNRESOLVED_STATE_COLOR = "#64748b";
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
      object.shape.stateColors &&
      definition.readSlots?.some(
        (slot) =>
          slot.name ===
            (object.shape.type === "text"
              ? object.shape.slotBinding?.slotName
              : undefined) && isStateSlotType(slot.type),
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
          "状態色の配色元Textが見つからないか、状態の色に従うTextではありません",
        );
      if (!supportsStateColor(object))
        throw new Error(
          "状態色の追従には有効な単色塗りが必要です。先に追従を解除してください。",
        );
    }
  }
}
/**
 * Color of a Text that follows its slot's state colors. A known state with a
 * defined color gives that color; a known state without one (a bool slot
 * without `boolDisplay`) gives undefined, meaning the normal color. Anything
 * else (no equipment, unassigned, Bad, type mismatch, no definition) gives
 * `unknownColor`; a previous or false color is never substituted.
 */
export function stateTextColor(
  text: ScreenObject,
  definition: SymbolDefinition,
  equipmentId?: string,
  context?: EquipmentContext,
): string | undefined {
  if (text.shape.type !== "text" || !text.shape.stateColors) return undefined;
  const { unknownColor } = text.shape.stateColors;
  const slotName = text.shape.slotBinding?.slotName;
  if (slotName === undefined) return unknownColor;
  const slot = symbolEquipmentSlot(definition, slotName, equipmentId, context);
  const evaluation = slot
    ? evaluateSlotState(
        slot,
        resolveSymbolSlot(definition, slotName, equipmentId, context),
      )
    : undefined;
  return evaluation?.state === "known" ? evaluation.color : unknownColor;
}
/**
 * Color override for a state-following Text or a follower shape; undefined
 * keeps the object's normal color. A follower resolves exactly as its source
 * Text, and a missing source never falls back to a normal authored color.
 */
export function resolveStateColor(
  object: ScreenObject,
  definition: SymbolDefinition,
  equipmentId?: string,
  context?: EquipmentContext,
): string | undefined {
  if (object.shape.type === "text")
    return stateTextColor(object, definition, equipmentId, context);
  if (!("stateColor" in object.shape) || !object.shape.stateColor)
    return undefined;
  const reference = object.shape.stateColor;
  const source = definition.objects.find(
    (item) => item.id === reference.textId,
  );
  if (
    source?.shape.type !== "text" ||
    !source.shape.stateColors ||
    !source.shape.slotBinding
  )
    return UNRESOLVED_STATE_COLOR;
  return stateTextColor(source, definition, equipmentId, context);
}
