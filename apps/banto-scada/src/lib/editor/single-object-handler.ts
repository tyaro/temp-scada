import { connectedVertex, remapConnections } from "../connections";
import { normalizeTextNewlines } from "../text-content";
import { reorderUnit } from "./group-handler";
import {
  isAreaShape,
  type Project,
  type Screen,
  type SymbolDefinition,
} from "../project";
import { normalizeRotation, replaceRotatedVertex } from "../rotation";
import { setFlip } from "../flip";
import { polygonVertexMove, reframePolygon } from "../polygon-frame";
import { setLineStyle } from "../line-style";
import { parseLineArrow } from "../line-arrow";
import { validateLevelShape } from "../level";
import { validateTableShape } from "../table";
import { validateClockShape } from "../clock-format";
import { validateAlarmBadgeTarget } from "../alarm-badge";
import { validateNavButtonShape } from "../nav-button";
import { parseShapeLabel } from "../shape-label";
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
    applyImageEdit(next, screen.objects[index], command);
  } else if (command.type === "set-line-connection") {
    const object = screen.objects[index];
    if (definitionId || object.shape.type !== "polyline")
      throw new Error("画面上の配管だけを接続できます");
    if (command.endpoint !== "start" && command.endpoint !== "end")
      throw new Error("始点または終点を選んでください");
    if (
      command.connection !== null &&
      (!command.connection ||
        typeof command.connection !== "object" ||
        Array.isArray(command.connection))
    )
      throw new Error("接続先の指定が不正です");
    const connections = { ...object.shape.connections };
    if (command.connection === null) delete connections[command.endpoint];
    else connections[command.endpoint] = structuredClone(command.connection);
    if (connections.start || connections.end)
      object.shape.connections = connections;
    else delete object.shape.connections;
  } else if (command.type === "make-trend-unique") {
    const object = screen.objects[index];
    if (definitionId || object.shape.type !== "trend")
      throw Error("画面上のトレンドだけ独立できます");
    const row = next.trends?.find(
      (row) => object.shape.type === "trend" && row.id === object.shape.trendId,
    );
    if (!row) throw Error("トレンド定義が見つかりません");
    const copy = {
      ...row,
      id: newId(),
      pens: row.pens.map((pen) => ({ ...pen, id: newId() })),
    };
    next.trends = [...(next.trends ?? []), copy];
    object.shape.trendId = copy.id;
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
    const target = screen.objects[index];
    if ("width" in target && target.shape.type === "polygon") {
      const polygon = { ...target, shape: target.shape };
      if (
        !Number.isInteger(command.index) ||
        !target.shape.points[command.index]
      )
        throw new Error("頂点が見つかりません");
      const frame = reframePolygon(
        polygon,
        polygonVertexMove(polygon, command.index, command.point),
      );
      if (!frame.ok) throw new Error(frame.reason);
      target.x = frame.x;
      target.y = frame.y;
      target.width = frame.width;
      target.height = frame.height;
      target.shape.points = frame.points;
      return "finish";
    }
    if (shape.type !== "polyline")
      throw new Error("折れ線と多角形の頂点だけを移動できます");
    if (
      !Number.isInteger(command.index) ||
      command.index < 0 ||
      command.index >= shape.points.length
    )
      throw new Error("頂点が見つかりません");
    const object = screen.objects[index];
    if (object.shape.type !== "polyline")
      throw new Error("折れ線だけを編集できます");
    if (connectedVertex(object, command.index))
      throw new Error(
        "接続中の端点は直接移動できません。先に接続を解除してください。",
      );
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
    remapConnections(copy, new Map([[screen.objects[index].id, copy.id]]));
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
      equipmentProperty,
      stateColors,
      format,
      boolDisplay,
      level,
      table,
      clock,
      navButton,
      alarmBadge,
      alarmBanner,
      stateColor,
      label,
      symbolId,
      equipmentId,
      sourceScreenId,
      trendId,
      colorMode,
      paint,
      rotation,
      flipX,
      flipY,
      opacity,
      colorAlpha,
      fontSize,
      textStyle,
      points,
      polygonVertices,
      strokeWidth,
      lineStyle,
      arrow,
      ...geometry
    } = command.patch;
    const object = screen.objects[index];
    if (polygonVertices !== undefined) {
      if (!("width" in object) || object.shape.type !== "polygon")
        throw new Error("多角形以外に多角形の頂点は設定できません");
      // 頂点の欄は今の枠を原点に書くので、同じ確定で枠を変える入力とは組み合わせない。
      if (
        (["x", "y", "width", "height"] as const).some(
          (key) => geometry[key] !== undefined && geometry[key] !== object[key],
        )
      )
        throw new Error("多角形の頂点と位置・サイズは別々に適用してください。");
      const frame = reframePolygon(
        { ...object, shape: object.shape },
        polygonVertices,
      );
      if (!frame.ok) throw new Error(frame.reason);
      geometry.x = frame.x;
      geometry.y = frame.y;
      geometry.width = frame.width;
      geometry.height = frame.height;
      object.shape.points = frame.points;
    }
    if (
      (object.shape.type === "image" ||
        object.shape.type === "screenView" ||
        object.shape.type === "navButton" ||
        object.shape.type === "alarmBadge" ||
        object.shape.type === "alarmBanner" ||
        object.shape.type === "trend" ||
        isAreaShape(object.shape)) &&
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
    if (flipX !== undefined) setFlip(object, "flipX", flipX);
    if (flipY !== undefined) setFlip(object, "flipY", flipY);
    if (name !== undefined) {
      if (name !== null && typeof name !== "string")
        throw new Error("配置名は文字列にしてください");
      const normalized = name?.trim() ?? "";
      if (normalized) object.name = normalized;
      else delete object.name;
    }
    if (paint !== undefined) {
      if (!isAreaShape(object.shape))
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
    if (trendId !== undefined) {
      if (definitionId || object.shape.type !== "trend")
        throw Error("画面上のトレンドだけ参照を変更できます");
      object.shape.trendId = trendId;
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
    if (equipmentProperty !== undefined) {
      if (object.shape.type !== "text" || !definitionId)
        throw new Error("機器情報は共有定義内のTextだけに設定できます");
      if (equipmentProperty === null) delete object.shape.equipmentProperty;
      else object.shape.equipmentProperty = { ...equipmentProperty };
    }
    if (slotBinding !== undefined) {
      if (
        (object.shape.type !== "text" && object.shape.type !== "level") ||
        !definitionId
      )
        throw new Error("slot表示は共有定義内のTextと液位だけに設定できます");
      if (slotBinding === null) delete object.shape.slotBinding;
      else object.shape.slotBinding = slotBinding;
    }
    if (stateColor !== undefined) {
      if (!(isAreaShape(object.shape) || object.shape.type === "polyline"))
        throw new Error("状態色の追従は矩形・楕円・線だけに設定できます");
      if (stateColor === null) delete object.shape.stateColor;
      else object.shape.stateColor = structuredClone(stateColor);
    }
    if (label !== undefined) {
      if (!isAreaShape(object.shape))
        throw new Error("図形の文字は矩形・楕円・多角形にだけ設定できます");
      // 同じ値なら finish の比較で no-op になる。
      if (label === null) delete object.shape.label;
      else object.shape.label = parseShapeLabel(label);
    }
    if (stateColors !== undefined) {
      if (object.shape.type !== "text" || !definitionId)
        throw new Error(
          "状態の色に従う指定は共有定義内のTextだけに設定できます",
        );
      if (stateColors === null) delete object.shape.stateColors;
      else object.shape.stateColors = structuredClone(stateColors);
    }
    if (binding !== undefined) {
      if (
        definitionId ||
        (object.shape.type !== "text" && object.shape.type !== "level")
      )
        throw new Error("タグは画面の Text か液位に割り当ててください");
      if (binding === null) delete object.shape.binding;
      else object.shape.binding = binding;
    }
    if (level !== undefined) {
      if (object.shape.type !== "level")
        throw new Error("下限・上限・向きは液位にだけ設定できます");
      const next = {
        ...object.shape,
        direction: level.direction,
        min: level.min,
        max: level.max,
      };
      if (level.direction !== "up" && level.direction !== "right")
        throw new Error("液位の向きを選択してください");
      validateLevelShape(next);
      if (level.background === undefined) delete next.background;
      else next.background = level.background;
      object.shape = next;
    }
    if (clock !== undefined) {
      if (object.shape.type !== "clock")
        throw new Error("日時の書式は時計にだけ設定できます");
      const next = { type: "clock" as const, ...structuredClone(clock) };
      if (next.seconds !== true) delete next.seconds;
      validateClockShape(next);
      object.shape = next;
    }
    if (table !== undefined) {
      if (object.shape.type !== "table")
        throw new Error("行・列・セルは表にだけ設定できます");
      const next = { type: "table" as const, ...structuredClone(table) };
      validateTableShape(next);
      if (next.border === undefined) delete next.border;
      if (next.background === undefined) delete next.background;
      object.shape = next;
    }
    if (alarmBadge !== undefined) {
      if (definitionId || object.shape.type !== "alarmBadge")
        throw new Error("警報・文字は警報の小札にだけ設定できます");
      const shape = {
        type: "alarmBadge" as const,
        ...structuredClone(alarmBadge),
      };
      if (shape.limit === undefined) delete shape.limit;
      validateAlarmBadgeTarget(shape, next.alarms?.definitions ?? []);
      object.shape = shape;
    }
    if (alarmBanner !== undefined) {
      if (definitionId || object.shape.type !== "alarmBanner")
        throw new Error("文字の書式は警報の帯にだけ設定できます");
      object.shape = {
        type: "alarmBanner" as const,
        style: {
          fontSize: alarmBanner.style.fontSize,
          fontWeight: alarmBanner.style.fontWeight,
        },
      };
    }
    if (navButton !== undefined) {
      if (definitionId || object.shape.type !== "navButton")
        throw new Error("行き先・文字・色は画面切替ボタンにだけ設定できます");
      const shape = {
        type: "navButton" as const,
        ...structuredClone(navButton),
      };
      validateNavButtonShape(shape, next);
      for (const key of ["target", "currentFill", "currentTextColor"] as const)
        if (shape[key] === undefined) delete shape[key];
      object.shape = shape;
    }
    if (format !== undefined) {
      if (object.shape.type !== "text")
        throw new Error("数値の書式はTextにだけ設定できます");
      if (format === null) delete object.shape.format;
      else object.shape.format = { ...format };
    }
    if (boolDisplay !== undefined) {
      if (object.shape.type !== "text" || definitionId)
        throw new Error("bool の表示は画面直下のTextにだけ設定できます");
      if (boolDisplay === null) delete object.shape.boolDisplay;
      else object.shape.boolDisplay = structuredClone(boolDisplay);
    }
    // A Text that no longer reads a tag has no bool to show.
    if (
      object.shape.type === "text" &&
      object.shape.boolDisplay &&
      !object.shape.binding
    ) {
      if (boolDisplay)
        throw new Error("bool の表示はタグを表示するTextだけに設定できます");
      delete object.shape.boolDisplay;
    }
    if (
      object.shape.type === "text" &&
      object.shape.boolDisplay &&
      object.shape.format
    )
      throw new Error("bool の表示と数値の書式は同時に設定できません");
    // A Text that no longer shows a value has no number to format.
    if (
      object.shape.type === "text" &&
      object.shape.format &&
      !object.shape.binding &&
      !object.shape.slotBinding
    ) {
      if (format)
        throw new Error(
          "数値の書式はタグかslotを表示するTextだけに設定できます",
        );
      delete object.shape.format;
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
      if (typeof text !== "string")
        throw new Error("文字列を入力してください。");
      object.shape.text = normalizeTextNewlines(text);
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
      if (points !== undefined) {
        const original = object.shape.points;
        for (const [i, j] of [
          [0, 0],
          [original.length - 1, points.length - 1],
        ])
          if (
            connectedVertex(object, i) &&
            (!points[j] ||
              points[j].x !== original[i].x ||
              points[j].y !== original[i].y)
          )
            throw new Error(
              "接続中の端点は直接変更できません。先に接続を解除してください。",
            );
        object.shape.points = points;
      }
      if (strokeWidth !== undefined) object.shape.strokeWidth = strokeWidth;
      if (arrow !== undefined) object.shape.arrow = parseLineArrow(arrow);
    }
  } else return unhandledCommand(command);
  return "finish";
}
