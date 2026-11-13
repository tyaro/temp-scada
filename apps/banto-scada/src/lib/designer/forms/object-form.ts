import { parseLineArrow } from "../../line-arrow";
import { normalizeTextNewlines } from "../../text-content";
import { isEquipmentPropertyField } from "../../equipment-property";
import { isStateSlotType, type EquipmentSlot } from "../../equipment";
import type { EditCommand, ObjectPatch } from "../../editor";
import { parsePoints, type ScreenObject } from "../../project";
import { parseLineStyle } from "../../line-style";
import { parseNumericProperty } from "../numeric-properties";
import {
  buildTableCells,
  parseTableColors,
  parseTableText,
  parseTableWeights,
} from "../../table";

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
    patch.text = normalizeTextNewlines(String(data.get("text")));
    const fontWeight = String(data.get("fontWeight")),
      align = String(data.get("textAlign")),
      wrap = data.has("textWrap")
        ? String(data.get("textWrap"))
        : (selected.shape.style.wrap ?? "none");
    if (
      !["normal", "bold"].includes(fontWeight) ||
      !["left", "center", "right"].includes(align) ||
      !["none", "word"].includes(wrap)
    )
      throw new Error("文字書式を選択してください。");
    patch.textStyle = {
      fontSize: parseNumericProperty(String(data.get("fontSize") ?? "")),
      fontWeight: fontWeight as "normal" | "bold",
      align: align as "left" | "center" | "right",
      ...(wrap === "word" || selected.shape.style.wrap === "none"
        ? { wrap: wrap as "none" | "word" }
        : {}),
    };
    if (context.definition && data.has("slotName")) {
      const slotName = String(data.get("slotName") ?? "");
      if (slotName.startsWith("@")) {
        const field = slotName.slice(1);
        if (!isEquipmentPropertyField(field))
          throw new Error("機器情報の表示項目を選択してください");
        patch.equipmentProperty = { field };
        patch.slotBinding = null;
      } else {
        patch.equipmentProperty = null;
        patch.slotBinding = slotName ? { slotName } : null;
      }
      if (
        selected.shape.stateColors &&
        !context.readSlots?.some(
          (slot) => slot.name === slotName && isStateSlotType(slot.type),
        )
      )
        patch.stateColors = null;
    }
    if (!context.definition) {
      const externalName = String(data.get("externalName") ?? "");
      patch.binding = externalName === "" ? null : { externalName };
    }
  }
  if (selected.shape.type === "level") {
    const direction = String(data.get("levelDirection") ?? "");
    if (direction !== "up" && direction !== "right")
      throw new Error("液位の向きを選択してください。");
    const min = parseNumericProperty(String(data.get("levelMin") ?? ""));
    const max = parseNumericProperty(String(data.get("levelMax") ?? ""));
    if (!(min < max))
      throw new Error("液位の下限は上限より小さくしてください。");
    const background =
      data.get("levelBackgroundMode") === "color"
        ? String(data.get("levelBackground") ?? "")
        : "";
    patch.level = {
      direction,
      min,
      max,
      ...(background ? { background } : {}),
    };
    if (context.definition && data.has("slotName")) {
      const slotName = String(data.get("slotName") ?? "");
      patch.slotBinding = slotName ? { slotName } : null;
    }
    if (!context.definition) {
      const externalName = String(data.get("externalName") ?? "");
      patch.binding = externalName === "" ? null : { externalName };
    }
  }
  if (selected.shape.type === "table") {
    const texts = parseTableText(String(data.get("tableText") ?? ""));
    const rows = texts.length,
      columns = texts[0].length;
    const fontWeight = String(data.get("tableFontWeight") ?? ""),
      align = String(data.get("tableAlign") ?? "");
    if (
      (fontWeight !== "normal" && fontWeight !== "bold") ||
      (align !== "left" && align !== "center" && align !== "right")
    )
      throw new Error("表の文字書式を選択してください。");
    const fontSize = parseNumericProperty(
      String(data.get("tableFontSize") ?? ""),
    );
    if (!(fontSize > 0 && fontSize <= 512))
      throw new Error("表の文字サイズは0より大きく512以下にしてください。");
    let border: { color: string; width: number } | undefined;
    if (data.get("tableBorderMode") === "line") {
      const width = parseNumericProperty(
        String(data.get("tableBorderWidth") ?? ""),
      );
      if (!(width > 0 && width <= 32))
        throw new Error("表の罫線の太さは0より大きく32以下にしてください。");
      border = { color: String(data.get("tableBorderColor") ?? ""), width };
    }
    const background =
      data.get("tableBackgroundMode") === "color"
        ? String(data.get("tableBackground") ?? "")
        : "";
    patch.table = {
      columns: parseTableWeights(
        String(data.get("tableColumns") ?? ""),
        columns,
        "列幅の比",
      ),
      rows: parseTableWeights(
        String(data.get("tableRows") ?? ""),
        rows,
        "行の高さの比",
      ),
      cells: buildTableCells(
        texts,
        parseTableColors(
          String(data.get("tableFills") ?? ""),
          rows,
          columns,
          "セルの塗り",
        ),
        parseTableColors(
          String(data.get("tableColors") ?? ""),
          rows,
          columns,
          "セルの文字色",
        ),
      ),
      style: { fontSize, fontWeight, align },
      ...(border ? { border } : {}),
      ...(background ? { background } : {}),
    };
  }
  if (selected.shape.type === "symbol") {
    patch.symbolId = String(data.get("symbolId"));
    if (!context.definition && data.has("equipmentId"))
      patch.equipmentId = String(data.get("equipmentId") ?? "") || null;
  }
  if (selected.shape.type === "screenView")
    patch.sourceScreenId = String(data.get("sourceScreenId"));
  if (selected.shape.type === "trend")
    patch.trendId = String(data.get("trendId"));
  if (selected.shape.type === "polyline") {
    patch.lineStyle = parseLineStyle(data.get("lineStyle"));
    patch.points = parsePoints(String(data.get("points")));
    patch.strokeWidth = Number(data.get("strokeWidth"));
    patch.arrow = parseLineArrow(data.get("arrow"));
  }
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch,
  };
}
export function acknowledgeObjectForm(
  form: HTMLFormElement,
  name: string,
  text?: string,
) {
  const textarea = form.elements.namedItem("text");
  if (text !== undefined && textarea instanceof HTMLTextAreaElement)
    textarea.value = text;
  const input = form.elements.namedItem("name");
  if (input instanceof HTMLInputElement) input.value = name;
}
