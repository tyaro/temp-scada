import type { EquipmentSlot } from "../../equipment";
import type { EditCommand, ObjectPatch } from "../../editor";
import { parsePoints, type ScreenObject } from "../../project";
import { parseLineStyle } from "../../line-style";
import { parseNumericProperty } from "../numeric-properties";

export interface ObjectFormContext {
  screenId: string;
  readSlots?: readonly EquipmentSlot[];
  definition: boolean;
  selected: ScreenObject | undefined;
}
export function objectFormCommand(
  data: Pick<FormData, "get" | "has">,
  context: ObjectFormContext,
): EditCommand {
  const selected = context.selected;
  if (!selected) throw new Error("選択した図形が見つかりません");
  const patch: ObjectPatch = {
    name: String(data.get("name") ?? ""),
    x: Number(data.get("x")),
    y: Number(data.get("y")),
    rotation: parseNumericProperty(String(data.get("rotation") ?? "")),
    opacity: parseNumericProperty(String(data.get("opacity") ?? "")) / 100,
    ...(data.has("colorAlpha")
      ? {
          colorAlpha:
            parseNumericProperty(String(data.get("colorAlpha"))) / 100,
        }
      : {}),
    ...(data.has("fill") ? { fill: String(data.get("fill")) } : {}),
  };
  if ("width" in selected) {
    patch.width = Number(data.get("width"));
    patch.height = Number(data.get("height"));
  }
  if (selected.shape.type === "text") {
    patch.text = String(data.get("text"));
    const fontWeight = String(data.get("fontWeight")),
      align = String(data.get("textAlign"));
    if (
      !["normal", "bold"].includes(fontWeight) ||
      !["left", "center", "right"].includes(align)
    )
      throw new Error("文字書式を選択してください。");
    patch.textStyle = {
      fontSize: parseNumericProperty(String(data.get("fontSize") ?? "")),
      fontWeight: fontWeight as "normal" | "bold",
      align: align as "left" | "center" | "right",
    };
    if (context.definition && data.has("slotName")) {
      const slotName = String(data.get("slotName") ?? "");
      patch.slotBinding = slotName ? { slotName } : null;
      if (
        selected.shape.boolColors &&
        !context.readSlots?.some(
          (slot) => slot.name === slotName && slot.type === "bool",
        )
      )
        patch.boolColors = null;
    }
    if (!context.definition) {
      const externalName = String(data.get("externalName") ?? "");
      patch.binding = externalName === "" ? null : { externalName };
    }
  }
  if (selected.shape.type === "symbol") {
    patch.symbolId = String(data.get("symbolId"));
    if (!context.definition && data.has("equipmentId"))
      patch.equipmentId = String(data.get("equipmentId") ?? "") || null;
  }
  if (selected.shape.type === "screenView")
    patch.sourceScreenId = String(data.get("sourceScreenId"));
  if (selected.shape.type === "polyline") {
    patch.lineStyle = parseLineStyle(data.get("lineStyle"));
    patch.points = parsePoints(String(data.get("points")));
    patch.strokeWidth = Number(data.get("strokeWidth"));
    patch.arrow = data.get("arrow") === "end" ? "end" : "none";
  }
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch,
  };
}
export function acknowledgeObjectForm(form: HTMLFormElement, name: string) {
  const input = form.elements.namedItem("name");
  if (input instanceof HTMLInputElement) input.value = name;
}
