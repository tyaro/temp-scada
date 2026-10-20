import { reorderUnit } from "./group-handler";
import { type Project, type Screen, type SymbolDefinition } from "../project";
import { normalizeRotation, replaceRotatedVertex } from "../rotation";
import { setLineStyle } from "../line-style";
import type { SingleObjectCommand } from "./commands";
import { newId, copySymbol } from "./model-helpers";
import { isImageEditCommand, applyImageEdit } from "./image-handler";
import { unhandledCommand } from "./unhandled-command";

/** The caller checked locks; the existing object lookup precedes every single-object edit. */
export function applySingleObjectCommand(
  next: Project,
  screen: Screen | SymbolDefinition,
  command: SingleObjectCommand,
  definitionId?: string,
): "finish" | "unchanged" {
  const index = screen.objects.findIndex((o) => o.id === command.objectId);
  if (index < 0) throw new Error("図形が見つかりません");
  if (isImageEditCommand(command)) {
    applyImageEdit(next, screen.objects[index], command, definitionId);
  } else if (command.type === "make-symbol-unique") {
    const object = screen.objects[index];
    if (definitionId || object.shape.type !== "symbol")
      throw new Error("画面上の Symbol 配置だけを独立コピーできます");
    const id = object.shape.symbolId;
    const definition = next.symbols.find((item) => item.id === id);
    if (!definition) throw new Error("Symbol 定義が見つかりません");
    const copy = copySymbol(definition);
    next.symbols.push(copy);
    object.shape.symbolId = copy.id;
  } else if (command.type === "move-vertex") {
    const shape = screen.objects[index].shape;
    if (shape.type !== "polyline")
      throw new Error("折れ線の頂点だけを移動できます");
    if (
      !Number.isInteger(command.index) ||
      command.index < 0 ||
      command.index >= shape.points.length
    )
      throw new Error("頂点が見つかりません");
    const object = screen.objects[index];
    if (object.shape.type !== "polyline")
      throw new Error("折れ線だけを編集できます");
    const geometry = replaceRotatedVertex(
      object as typeof object & { shape: typeof shape },
      command.index,
      command.point,
    );
    object.x = geometry.x;
    object.y = geometry.y;
    shape.points = geometry.points;
  } else if (command.type === "duplicate") {
    const copy = JSON.parse(JSON.stringify(screen.objects[index]));
    copy.id = newId();
    copy.x += 20;
    copy.y += 20;
    copy.order = Math.max(-1, ...screen.objects.map((o) => o.order)) + 1;
    screen.objects.push(copy);
  } else if (command.type === "reorder") {
    return reorderUnit(screen, command.objectId, command.direction);
  } else if (command.type === "remove") screen.objects.splice(index, 1);
  else if (command.type === "update") {
    const {
      name,
      text,
      binding,
      slotBinding,
      boolColors,
      symbolId,
      equipmentId,
      sourceScreenId,
      colorMode,
      paint,
      rotation,
      opacity,
      colorAlpha,
      fontSize,
      textStyle,
      points,
      strokeWidth,
      lineStyle,
      arrow,
      ...geometry
    } = command.patch;
    const object = screen.objects[index];
    if (
      (object.shape.type === "image" ||
        object.shape.type === "screenView" ||
        object.shape.type === "rectangle" ||
        object.shape.type === "ellipse") &&
      (geometry.fill !== undefined || colorAlpha !== undefined)
    )
      throw new Error(
        "画像の色は原本、矩形・楕円の色は塗り設定で編集してください。",
      );
    Object.assign(object, geometry);
    if (colorAlpha !== undefined) {
      if (!Number.isFinite(colorAlpha) || colorAlpha < 0 || colorAlpha > 1)
        throw new Error("色の不透明度は0〜100%で入力してください。");
      if ((object.colorAlpha ?? 1) !== colorAlpha)
        object.colorAlpha = colorAlpha;
    }
    if (opacity !== undefined) {
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new Error("不透明度は0〜100%で入力してください。");
      // Preserve explicit default values, and avoid creating history for omitted defaults.
      if ((object.opacity ?? 1) !== opacity) object.opacity = opacity;
    }
    if (rotation !== undefined) object.rotation = normalizeRotation(rotation);
    if (name !== undefined) {
      if (name !== null && typeof name !== "string")
        throw new Error("配置名は文字列にしてください");
      const normalized = name?.trim() ?? "";
      if (normalized) object.name = normalized;
      else delete object.name;
    }
    if (paint !== undefined) {
      if (object.shape.type !== "rectangle" && object.shape.type !== "ellipse")
        throw new Error("塗りと枠線は矩形と楕円にだけ設定できます");
      object.shape.paint = structuredClone(paint);
    }
    if (colorMode !== undefined) {
      if (object.shape.type !== "symbol" || definitionId)
        throw new Error("色の使い方は画面のSymbol配置にだけ設定できます");
      if (colorMode !== "monochrome" && colorMode !== "definition")
        throw new Error("Symbolの色の使い方が不正です");
      object.shape.colorMode = colorMode;
    }
    if (sourceScreenId !== undefined) {
      if (definitionId || object.shape.type !== "screenView")
        throw new Error("参照画面は埋込配置にだけ設定できます。");
      object.shape.screenId = sourceScreenId;
    }
    if (equipmentId !== undefined) {
      if (definitionId || object.shape.type !== "symbol")
        throw new Error("機器は画面上のSymbol配置だけに関連付けできます");
      if (equipmentId === null) delete object.shape.equipmentId;
      else object.shape.equipmentId = equipmentId;
    }
    if (symbolId !== undefined) {
      if (definitionId || object.shape.type !== "symbol")
        throw new Error("参照先は画面上の Symbol 配置にだけ設定できます");
      if (!next.symbols.some((item) => item.id === symbolId))
        throw new Error("Symbol 定義が見つかりません");
      object.shape.symbolId = symbolId;
    }
    if (slotBinding !== undefined) {
      if (object.shape.type !== "text" || !definitionId)
        throw new Error("slot表示は共有定義内のTextだけに設定できます");
      if (slotBinding === null) delete object.shape.slotBinding;
      else object.shape.slotBinding = slotBinding;
    }
    if (boolColors !== undefined) {
      if (object.shape.type !== "text" || !definitionId)
        throw new Error("状態別の文字色は共有定義内のTextだけに設定できます");
      if (boolColors === null) delete object.shape.boolColors;
      else object.shape.boolColors = structuredClone(boolColors);
    }
    if (binding !== undefined) {
      if (definitionId || object.shape.type !== "text")
        throw new Error("タグは画面の Text に割り当ててください");
      if (binding === null) delete object.shape.binding;
      else object.shape.binding = binding;
    }
    if (textStyle !== undefined || fontSize !== undefined) {
      if (object.shape.type !== "text")
        throw new Error("文字書式はTextにだけ設定できます");
      if (textStyle !== undefined)
        object.shape.style = structuredClone(textStyle);
      if (fontSize !== undefined) object.shape.style.fontSize = fontSize;
    }
    if (text !== undefined) {
      if (object.shape.type !== "text")
        throw new Error("Text 以外に文字列は設定できません");
      if (/[\r\n\u2028\u2029]/u.test(text))
        throw new Error("1行の文字列を入力してください。");
      object.shape.text = text;
    }
    if (
      points !== undefined ||
      strokeWidth !== undefined ||
      lineStyle !== undefined ||
      arrow !== undefined
    ) {
      if (object.shape.type !== "polyline")
        throw new Error("折れ線以外に頂点や線幅は設定できません");
      if (lineStyle !== undefined) setLineStyle(object.shape, lineStyle);
      if (points !== undefined) object.shape.points = points;
      if (strokeWidth !== undefined) object.shape.strokeWidth = strokeWidth;
      if (arrow !== undefined) object.shape.arrow = arrow;
    }
  } else return unhandledCommand(command);
  return "finish";
}
