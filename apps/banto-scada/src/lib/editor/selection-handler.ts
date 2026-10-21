import { setPaintAlpha } from "../selection-paint-alpha";
import { relativeObjectOrder } from "../relative-layer-order";
import { setSelectionSize } from "./size-arrangement";
import { duplicatePlacements } from "./duplicate-placement";
import { validateArrayCopy } from "../array-copy";
import { distributeGaps } from "./gap-arrangement";
import { groupFor } from "../geometric-groups";
import { arrangeUnits } from "./group-arrangement";
import {
  getBounds,
  placementColor,
  type Screen,
  type SymbolDefinition,
} from "../project";
import { parseLineStyle, setLineStyle } from "../line-style";
import type { SelectionCommand } from "./commands";
import { applyFolderAssignment } from "./folder-handler";
import { unhandledCommand } from "./unhandled-command";

/** The caller has checked locks; this handler validates the whole selection before edits. */
export function applySelectionCommand(
  screen: Screen | SymbolDefinition,
  command: SelectionCommand,
): "finish" | "unchanged" {
  const ids = new Set(command.objectIds);
  if (ids.size === 0 || ids.size !== command.objectIds.length)
    throw new Error("選択する図形の ID が空または重複しています");
  const objects = screen.objects
    .filter((o) => ids.has(o.id))
    .sort((a, b) => a.order - b.order);
  if (objects.length !== ids.size)
    throw new Error("選択した図形が見つかりません");
  if (command.type === "reorder-relative") {
    const ids = relativeObjectOrder(
      screen,
      command.objectIds,
      command.targetObjectId,
      command.position,
    );
    const ordered = [...screen.objects].sort((a, b) => a.order - b.order);
    if (ordered.every((object, index) => object.id === ids[index]))
      return "unchanged";
    const byId = new Map(screen.objects.map((object) => [object.id, object]));
    screen.objects = ids.map((id, index) => ({
      ...byId.get(id)!,
      order: index,
    }));
    return "finish";
  }
  if (command.type === "distribute-gaps")
    return distributeGaps(screen, command.objectIds, command.axis);
  if (
    (command.type === "align" || command.type === "distribute") &&
    objects.some((object) => groupFor(screen, object.id))
  )
    return arrangeUnits(screen, command);
  if (command.type === "set-text-style") {
    const patch = command.patch;
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (key) => !["fontSize", "fontWeight", "align"].includes(key),
      )
    )
      throw new Error("文字書式の指定が不正です");
    const { fontSize, fontWeight, align } = patch;
    if (
      fontSize === undefined &&
      fontWeight === undefined &&
      align === undefined
    )
      throw new Error("変更する文字書式を指定してください");
    if (
      fontSize !== undefined &&
      (typeof fontSize !== "number" ||
        !Number.isFinite(fontSize) ||
        fontSize <= 0 ||
        fontSize > 512)
    )
      throw new Error(
        "文字サイズは0より大きく512以下の有限の数値で指定してください",
      );
    if (
      fontWeight !== undefined &&
      fontWeight !== "normal" &&
      fontWeight !== "bold"
    )
      throw new Error("文字の太さは標準または太字を指定してください");
    if (align !== undefined && !["left", "center", "right"].includes(align))
      throw new Error("文字揃えは左・中央・右を指定してください");
    if (objects.some((object) => object.shape.type !== "text"))
      throw new Error(
        "Textだけを選択してください。選択内の文字だけを暗黙に変更しません",
      );
    for (const object of objects) {
      if (object.shape.type !== "text") continue;
      if (fontSize !== undefined) object.shape.style.fontSize = fontSize;
      if (fontWeight !== undefined) object.shape.style.fontWeight = fontWeight;
      if (align !== undefined) object.shape.style.align = align;
    }
  } else if (command.type === "set-size") {
    setSelectionSize(objects, command);
  } else if (command.type === "set-paint-alpha") {
    setPaintAlpha(objects, command.patch);
  } else if (command.type === "set-opacity") {
    if (
      typeof command.opacity !== "number" ||
      !Number.isFinite(command.opacity) ||
      command.opacity < 0 ||
      command.opacity > 1
    )
      throw new Error("不透明度は0〜100%の有限の数値で指定してください");
    for (const object of objects)
      if ((object.opacity ?? 1) !== command.opacity)
        object.opacity = command.opacity;
  } else if (command.type === "set-outline-style") {
    if (
      !command.patch ||
      typeof command.patch !== "object" ||
      Array.isArray(command.patch) ||
      Object.keys(command.patch).some(
        (key) => !["mode", "color", "width", "lineStyle"].includes(key),
      )
    )
      throw new Error("枠線のスタイル指定が不正です");
    const { mode, color, width, lineStyle } = command.patch;
    if (lineStyle !== undefined) parseLineStyle(lineStyle);
    if (
      mode === undefined &&
      color === undefined &&
      width === undefined &&
      lineStyle === undefined
    )
      throw new Error("枠線の変更する項目を指定してください");
    if (mode !== undefined && mode !== "none" && mode !== "enabled")
      throw new Error("枠線はなし・ありを指定してください");
    if (
      color !== undefined &&
      (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color.trim()))
    )
      throw new Error("枠線の色は#と6桁の16進数で指定してください");
    if (
      width !== undefined &&
      (typeof width !== "number" ||
        !Number.isFinite(width) ||
        width <= 0 ||
        width > 64)
    )
      throw new Error(
        "枠線の幅は0より大きく64以下の有限の数値で指定してください",
      );
    if (
      mode === "none" &&
      (color !== undefined || width !== undefined || lineStyle !== undefined)
    )
      throw new Error(
        "枠線なしと色・幅・線種は同時に指定できません。スタイルの指定を解除してください",
      );
    if (
      objects.some(
        (object) =>
          object.shape.type !== "rectangle" && object.shape.type !== "ellipse",
      )
    )
      throw new Error(
        "矩形・楕円だけを選択してください。対応する図形だけを暗黙に変更しません",
      );
    if (
      mode !== "none" &&
      objects.some(
        (object) =>
          (object.shape.type === "rectangle" ||
            object.shape.type === "ellipse") &&
          !object.shape.paint.stroke,
      ) &&
      (mode !== "enabled" || color === undefined || width === undefined)
    )
      throw new Error(
        "枠線なしの配置を含むため、枠線ありと色・幅の両方を明示してください",
      );
    const normalized = color?.trim().toLowerCase();
    for (const object of objects) {
      if (object.shape.type !== "rectangle" && object.shape.type !== "ellipse")
        continue;
      if (mode === "none") object.shape.paint.stroke = null;
      else if (!object.shape.paint.stroke)
        object.shape.paint.stroke = { color: normalized!, width: width! };
      else {
        if (
          normalized !== undefined &&
          object.shape.paint.stroke.color.toLowerCase() !== normalized
        )
          object.shape.paint.stroke.color = normalized;
        if (width !== undefined) object.shape.paint.stroke.width = width;
      }
      if (object.shape.paint.stroke && lineStyle !== undefined)
        setLineStyle(object.shape.paint.stroke, lineStyle);
    }
  } else if (command.type === "set-line-style") {
    if (
      !command.patch ||
      typeof command.patch !== "object" ||
      Array.isArray(command.patch) ||
      Object.keys(command.patch).some(
        (key) => !["strokeWidth", "arrow", "lineStyle"].includes(key),
      )
    )
      throw new Error("線・配管のスタイル指定が不正です");
    const { strokeWidth, arrow, lineStyle } = command.patch;
    if (lineStyle !== undefined) parseLineStyle(lineStyle);
    if (
      strokeWidth !== undefined &&
      (typeof strokeWidth !== "number" ||
        !Number.isFinite(strokeWidth) ||
        strokeWidth <= 0 ||
        strokeWidth > 64)
    )
      throw new Error("線幅は0より大きく64以下の有限の数値で指定してください");
    if (arrow !== undefined && arrow !== "none" && arrow !== "end")
      throw new Error("矢印はなし・終端のいずれかで指定してください");
    if (objects.some((object) => object.shape.type !== "polyline"))
      throw new Error(
        "線・配管だけを選択してください。選択内の線だけを暗黙に変更しません。",
      );
    for (const object of objects)
      if (object.shape.type === "polyline") {
        if (strokeWidth !== undefined) object.shape.strokeWidth = strokeWidth;
        if (arrow !== undefined) object.shape.arrow = arrow;
        if (lineStyle !== undefined) setLineStyle(object.shape, lineStyle);
      }
  } else if (command.type === "set-folder") {
    applyFolderAssignment(screen, objects, command);
  } else if (command.type === "distribute") {
    if (objects.length < 3)
      throw new Error("等間隔に配置する図形を3件以上選択してください");
    if (command.axis !== "x" && command.axis !== "y")
      throw new Error("等間隔配置の方向が不正です");
    const axis = command.axis;
    const placements = objects.map((object) => {
      const bounds = getBounds(object);
      const offset =
        bounds[axis] + (axis === "x" ? bounds.width : bounds.height) / 2;
      return { object, offset, center: object[axis] + offset };
    });
    if (placements.some((item) => !Number.isFinite(item.center)))
      throw new Error("配置の中心は有限の座標にしてください");
    placements.sort(
      (a, b) => a.center - b.center || a.object.order - b.object.order,
    );
    const start = placements[0].center,
      end = placements.at(-1)!.center;
    if (start === end) return "unchanged";
    // Endpoints stay untouched. Weighted interpolation also avoids end-start overflow.
    for (let i = 1; i < placements.length - 1; i++) {
      const fraction = i / (placements.length - 1);
      const target = start * (1 - fraction) + end * fraction;
      const { object, offset, center } = placements[i];
      const tolerance =
        Number.EPSILON * Math.max(1, Math.abs(center), Math.abs(target)) * 4;
      if (Math.abs(target - center) > tolerance) object[axis] = target - offset;
    }
  } else if (command.type === "set-color") {
    if (
      objects.some(
        (object) =>
          (object.shape.type === "rectangle" ||
            object.shape.type === "ellipse") &&
          object.shape.paint.fill.enabled &&
          object.shape.paint.fill.paint.type !== "solid",
      )
    )
      throw new Error(
        "グラデーションや模様を含む選択には共通色を適用できません。単独の塗り設定で編集してください。",
      );
    if (
      objects.some(
        (object) =>
          object.shape.type === "image" || object.shape.type === "screenView",
      )
    )
      throw new Error(
        "画像や埋込画面を含む選択には色を適用できません。対象を除いて選択してください。",
      );
    const fill = command.fill.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(fill))
      throw new Error("色は#と6桁の16進数で指定してください");
    if (
      command.convertDefinitionSymbols !== undefined &&
      typeof command.convertDefinitionSymbols !== "boolean"
    )
      throw new Error("単色への切替指定はbooleanで指定してください");
    const usesDefinition = objects.some(
      (object) =>
        object.shape.type === "symbol" &&
        object.shape.colorMode === "definition",
    );
    if (usesDefinition && !command.convertDefinitionSymbols)
      throw new Error(
        "共有定義の色を使うSymbolを含むため、配置単色への切替を明示してください",
      );
    if (
      objects.some(
        (object) =>
          (object.shape.type === "rectangle" ||
            object.shape.type === "ellipse") &&
          !object.shape.paint.fill.enabled &&
          !object.shape.paint.stroke,
      )
    )
      throw new Error(
        "塗りと枠線が無効の配置を含みます。有効にしてから適用してください",
      );
    objects.forEach((object) => {
      if (
        object.shape.type === "rectangle" ||
        object.shape.type === "ellipse"
      ) {
        if (
          object.shape.paint.fill.enabled &&
          object.shape.paint.fill.paint.type === "solid" &&
          object.shape.paint.fill.paint.color.toLowerCase() !== fill
        )
          object.shape.paint.fill.paint.color = fill;
        if (
          object.shape.paint.stroke &&
          object.shape.paint.stroke.color.toLowerCase() !== fill
        )
          object.shape.paint.stroke.color = fill;
      } else if (placementColor(object).toLowerCase() !== fill)
        object.fill = fill;
      if (command.convertDefinitionSymbols && object.shape.type === "symbol")
        object.shape.colorMode = "monochrome";
    });
  } else if (command.type === "move-many") {
    if (!Number.isFinite(command.dx) || !Number.isFinite(command.dy))
      throw new Error("移動量は有限の数値にしてください");
    objects.forEach((o) => {
      o.x += command.dx;
      o.y += command.dy;
    });
  } else if (command.type === "remove-many") {
    screen.objects = screen.objects.filter((o) => !ids.has(o.id));
    if ("groups" in screen)
      screen.groups = screen.groups.filter(
        (group) => !group.memberIds.some((id) => ids.has(id)),
      );
  } else if (command.type === "duplicate-many") {
    duplicatePlacements(screen, objects, 20, 20);
  } else if (command.type === "duplicate-array") {
    validateArrayCopy(
      command,
      objects.length,
      screen.objects.length,
      "background" in screen ? 1000 : 100,
    );
    for (let row = 0; row < command.rows; row++) {
      for (let column = 0; column < command.columns; column++) {
        if (row === 0 && column === 0) continue;
        duplicatePlacements(
          screen,
          objects,
          column * command.stepX,
          row * command.stepY,
        );
      }
    }
  } else if (command.type === "align") {
    const bounds = objects.map((o) => {
      const b = getBounds(o);
      return {
        left: o.x + b.x,
        right: o.x + b.x + b.width,
        top: o.y + b.y,
        bottom: o.y + b.y + b.height,
      };
    });
    const left = Math.min(...bounds.map((b) => b.left)),
      right = Math.max(...bounds.map((b) => b.right));
    const top = Math.min(...bounds.map((b) => b.top)),
      bottom = Math.max(...bounds.map((b) => b.bottom));
    objects.forEach((o, i) => {
      const b = bounds[i];
      if (command.alignment === "left") o.x += left - b.left;
      else if (command.alignment === "right") o.x += right - b.right;
      else if (command.alignment === "center-x")
        o.x += (left + right - b.left - b.right) / 2;
      else if (command.alignment === "top") o.y += top - b.top;
      else if (command.alignment === "bottom") o.y += bottom - b.bottom;
      else o.y += (top + bottom - b.top - b.bottom) / 2;
    });
  } else return unhandledCommand(command);
  return "finish";
}
