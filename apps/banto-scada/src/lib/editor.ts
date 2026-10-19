import { imageCropViewBox, normalizeImageCrop } from "./image-crop";
import { parseLineStyle, setLineStyle } from "./line-style";
import { projectContent } from "./save-state";
import { normalizeRotation, replaceRotatedVertex } from "./rotation";
import { parseClipboard } from "./clipboard";
import { canvasColors } from "./canvas-colors";
import {
  placementColor,
  referencedAssets,
  parseProject,
  serializeProject,
  getBounds,
  type Project,
} from "./project";
import builtins from "./symbol-library.json";
import type { SymbolDefinition, ScreenObject } from "./project";
import {
  isObjectCommand,
  isSymbolCommand,
  isScreenCommand,
  type EditCommand,
} from "./editor/commands";
import {
  isFolderStructureCommand,
  applyFolderStructureCommand,
  applyFolderAssignment,
} from "./editor/folder-handler";
import { applyProjectCommand } from "./editor/project-handler";
import { applyScreenCommand } from "./editor/screen-handler";
import { applySymbolCommand } from "./editor/symbol-handler";
import {
  centerObject,
  copySymbol,
  newId,
  renewOwnerIds,
  registerAsset,
} from "./editor/model-helpers";
export { newId, symbolUsage } from "./editor/model-helpers";
export { isObjectCommand } from "./editor/commands";
export type {
  AddKind,
  ObjectPatch,
  OutlineStylePatch,
  AlignMode,
  ObjectCommand,
  EditCommand,
} from "./editor/commands";

/** 変更はコピー上で検証し、失敗時は元の Project を保持する。 */
export function applyCommand(
  project: Project,
  command: EditCommand,
  mode: "edit" | "preview",
): Project {
  if (mode !== "edit") throw new Error("表示プレビューでは編集できません");
  const next = parseProject(serializeProject(project));
  if (command.type === "update-project") {
    applyProjectCommand(next, command);
    return finish(project, next);
  }
  if (isSymbolCommand(command)) {
    applySymbolCommand(next, command);
    return finish(project, next);
  }
  if (isScreenCommand(command)) {
    const result = applyScreenCommand(next, command);
    return result === "unchanged" ? project : finish(project, next);
  }
  const definitionId = isObjectCommand(command)
    ? command.definitionId
    : undefined;
  const targetScreen = next.screens.find((s) => s.id === command.screenId);
  const screen = definitionId
    ? next.symbols.find((s) => s.id === definitionId)
    : targetScreen;
  if (!screen) throw new Error("画面が見つかりません");
  if (command.type === "add-screen-view") {
    if (definitionId) throw new Error("Symbol定義には画面を埋め込めません。");
    screen.objects.push({
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
      rotation: 0,
      ...command.frame,
      shape: {
        type: "screenView",
        screenId: command.sourceScreenId,
        fit: "contain",
      },
    });
    return finish(project, next);
  }
  if (command.type === "add-image") {
    if (definitionId) throw new Error("Symbol定義には画像を配置できません");
    const assetId = registerAsset(next, command.asset);
    screen.objects.push({
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
      rotation: 0,
      fill: "#000000",
      ...command.frame,
      shape: { type: "image", assetId, fit: "contain" },
    });
    return finish(project, next);
  }
  if (isFolderStructureCommand(command)) {
    applyFolderStructureCommand(screen, command);
    return finish(project, next);
  }
  if (command.type === "set-visibility") {
    const object = screen.objects.find(
      (object) => object.id === command.objectId,
    );
    if (!object) throw new Error("配置が見つかりません");
    if (typeof command.visible !== "boolean")
      throw new Error("表示状態はbooleanで指定してください");
    if ((object.visible !== false) === command.visible) return project;
    if (command.visible) delete object.visible;
    else object.visible = false;
    return finish(project, next);
  }
  if (command.type === "set-lock") {
    const object = screen.objects.find(
      (object) => object.id === command.objectId,
    );
    if (!object) throw new Error("配置が見つかりません");
    if (typeof command.locked !== "boolean")
      throw new Error("ロック状態はbooleanで指定してください");
    if (!!object.locked === command.locked) return project;
    if (command.locked) object.locked = true;
    else delete object.locked;
    return finish(project, next);
  }
  if (isObjectCommand(command)) {
    const ids =
      "objectIds" in command
        ? command.objectIds
        : "objectId" in command
          ? [command.objectId]
          : [];
    if (
      screen.objects.some((object) => object.locked && ids.includes(object.id))
    )
      throw new Error(
        "ロック中の配置を含むため変更できません。レイヤーでロックを解除してください。",
      );
  }
  if (command.type === "paste") {
    const fragment = parseClipboard(command.text);
    const objects = fragment.project.screens[0].objects;
    if (
      definitionId &&
      objects.some(
        (o) =>
          o.shape.type === "symbol" ||
          o.shape.type === "image" ||
          (o.shape.type === "text" && o.shape.binding),
      )
    )
      throw new Error(
        "Symbol定義には画像・Symbol配置・タグ付きTextを貼り付けできません",
      );
    if (
      !Number.isFinite(command.center.x) ||
      !Number.isFinite(command.center.y) ||
      !Number.isFinite(command.offset ?? 0)
    )
      throw new Error("貼り付け先は有限の座標にしてください");
    const assetReferences = new Map<string, string>();
    for (const asset of fragment.project.assets) {
      const existing = next.assets.find((a) => a.sha256 === asset.sha256);
      const incoming = { ...asset, id: existing?.id ?? newId() };
      assetReferences.set(asset.id, registerAsset(next, incoming));
    }
    const references = new Map<string, string>();
    for (const object of objects)
      if (
        object.shape.type === "symbol" &&
        !references.has(object.shape.symbolId)
      ) {
        const symbolId = object.shape.symbolId;
        const source = fragment.project.symbols.find((s) => s.id === symbolId)!;
        const live =
          fragment.origin === command.origin &&
          fragment.project.manifest.projectId === project.manifest.projectId
            ? next.symbols.find((s) => s.id === source.id)
            : undefined;
        if (live) references.set(source.id, live.id);
        else {
          const copy = renewOwnerIds(
            JSON.parse(JSON.stringify(source)) as SymbolDefinition,
          );
          next.symbols.push(copy);
          references.set(source.id, copy.id);
        }
      }
    const bounds = objects.map((o) => {
      const b = getBounds(o);
      return {
        left: o.x + b.x,
        top: o.y + b.y,
        right: o.x + b.x + b.width,
        bottom: o.y + b.y + b.height,
      };
    });
    const dx =
      command.center.x -
      (Math.min(...bounds.map((b) => b.left)) +
        Math.max(...bounds.map((b) => b.right))) /
        2 +
      (command.offset ?? 0);
    const dy =
      command.center.y -
      (Math.min(...bounds.map((b) => b.top)) +
        Math.max(...bounds.map((b) => b.bottom))) /
        2 +
      (command.offset ?? 0);
    const order = Math.max(-1, ...screen.objects.map((o) => o.order)) + 1;
    [...objects]
      .sort((a, b) => a.order - b.order)
      .forEach((object, index) => {
        const copy = JSON.parse(JSON.stringify(object)) as ScreenObject;
        copy.id = newId();
        copy.order = order + index;
        delete copy.folderId;
        copy.x += dx;
        copy.y += dy;
        if (copy.shape.type === "symbol")
          copy.shape.symbolId = references.get(copy.shape.symbolId)!;
        if (copy.shape.type === "image")
          copy.shape.assetId = assetReferences.get(copy.shape.assetId)!;
        screen.objects.push(copy);
      });
    return finish(project, next);
  }
  if (
    command.type === "set-folder" ||
    command.type === "distribute" ||
    command.type === "set-color" ||
    command.type === "set-line-style" ||
    command.type === "set-outline-style" ||
    command.type === "move-many" ||
    command.type === "duplicate-many" ||
    command.type === "remove-many" ||
    command.type === "align"
  ) {
    const ids = new Set(command.objectIds);
    if (ids.size === 0 || ids.size !== command.objectIds.length)
      throw new Error("選択する図形の ID が空または重複しています");
    const objects = screen.objects
      .filter((o) => ids.has(o.id))
      .sort((a, b) => a.order - b.order);
    if (objects.length !== ids.size)
      throw new Error("選択した図形が見つかりません");
    if (command.type === "set-outline-style") {
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
            object.shape.type !== "rectangle" &&
            object.shape.type !== "ellipse",
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
        if (
          object.shape.type !== "rectangle" &&
          object.shape.type !== "ellipse"
        )
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
        throw new Error(
          "線幅は0より大きく64以下の有限の数値で指定してください",
        );
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
      if (start === end) return project;
      // Endpoints stay untouched. Weighted interpolation also avoids end-start overflow.
      for (let i = 1; i < placements.length - 1; i++) {
        const fraction = i / (placements.length - 1);
        const target = start * (1 - fraction) + end * fraction;
        const { object, offset, center } = placements[i];
        const tolerance =
          Number.EPSILON * Math.max(1, Math.abs(center), Math.abs(target)) * 4;
        if (Math.abs(target - center) > tolerance)
          object[axis] = target - offset;
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
    } else if (command.type === "remove-many")
      screen.objects = screen.objects.filter((o) => !ids.has(o.id));
    else if (command.type === "duplicate-many") {
      const order = Math.max(-1, ...screen.objects.map((o) => o.order)) + 1;
      objects.forEach((o, i) => {
        const copy = JSON.parse(JSON.stringify(o));
        copy.id = newId();
        copy.x += 20;
        copy.y += 20;
        copy.order = order + i;
        screen.objects.push(copy);
      });
    } else {
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
    }
  } else if (command.type === "add" || command.type === "add-symbol") {
    const base = {
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
      rotation: 0,
      x: 40,
      y: 40,
      fill: canvasColors(definitionId ? "#0b1220" : targetScreen!.background)[
        command.type === "add" && command.kind === "text"
          ? "newText"
          : "newShape"
      ],
    };
    if (command.type === "add-symbol") {
      if (definitionId)
        throw new Error("Symbol 定義の入れ子には対応していません");
      const definition = builtins[
        command.template
      ] as unknown as SymbolDefinition;
      if (!next.symbols.some((s) => s.id === definition.id))
        next.symbols.push(JSON.parse(JSON.stringify(definition)));
      screen.objects.push({
        ...base,
        width: 100,
        height: 100,
        shape: {
          type: "symbol",
          colorMode: "monochrome",
          symbolId: definition.id,
        },
      });
    } else if (command.kind === "line" || command.kind === "pipe") {
      screen.objects.push({
        ...base,
        shape: {
          type: "polyline",
          points:
            command.kind === "line"
              ? [
                  { x: 0, y: 0 },
                  { x: 180, y: 0 },
                ]
              : [
                  { x: 0, y: 0 },
                  { x: 120, y: 0 },
                  { x: 120, y: 100 },
                  { x: 240, y: 100 },
                ],
          strokeWidth: command.kind === "line" ? 2 : 8,
          arrow: "none",
        },
      });
    } else {
      screen.objects.push({
        ...base,
        width: 160,
        height: command.kind === "text" ? 40 : 100,
        shape:
          command.kind === "text"
            ? {
                type: "text",
                text: "テキスト",
                style: { fontSize: 22.4, fontWeight: "normal", align: "left" },
              }
            : {
                type: command.kind,
                paint: {
                  fill: {
                    enabled: true,
                    paint: { type: "solid", color: base.fill, alpha: 1 },
                  },
                  stroke: null,
                },
              },
      });
    }
    if (definitionId) {
      const added = screen.objects.at(-1)!;
      added.x = screen.width * 0.1;
      added.y = screen.height * 0.1;
      if ("width" in added) {
        added.width = Math.min(added.width, screen.width * 0.6);
        added.height = Math.min(added.height, screen.height * 0.6);
      } else {
        const bounds = getBounds(added);
        const scale = Math.min(
          1,
          (screen.width * 0.6) / bounds.width,
          (screen.height * 0.6) / bounds.height,
        );
        added.shape.points = added.shape.points.map((p) => ({
          x: p.x * scale,
          y: p.y * scale,
        }));
      }
    }
    const added = screen.objects.at(-1)!;
    if (added.shape.type === "rectangle" || added.shape.type === "ellipse")
      delete added.fill;
    centerObject(added, command.center);
  } else {
    const index = screen.objects.findIndex((o) => o.id === command.objectId);
    if (index < 0) throw new Error("図形が見つかりません");
    if (command.type === "replace-image") {
      const object = screen.objects[index];
      if (definitionId || object.shape.type !== "image")
        throw new Error("画面上の画像配置だけを差し替えられます。");
      const assetId = registerAsset(next, command.asset);
      if (assetId !== object.shape.assetId) delete object.shape.crop;
      object.shape.assetId = assetId;
    } else if (command.type === "set-image-crop") {
      const object = screen.objects[index];
      if (definitionId || object.shape.type !== "image")
        throw new Error("画面上の画像配置だけをトリミングできます。");
      const asset = next.assets.find(
        (a) => object.shape.type === "image" && a.id === object.shape.assetId,
      )!;
      const crop = normalizeImageCrop(asset, command.crop ?? undefined);
      if (crop) object.shape.crop = crop;
      else delete object.shape.crop;
    } else if (command.type === "reset-image-ratio") {
      const object = screen.objects[index];
      if (!("width" in object) || object.shape.type !== "image")
        throw new Error("画像配置だけを元比率に戻せます");
      const assetId = object.shape.assetId;
      const asset = next.assets.find((a) => a.id === assetId)!;
      const source = imageCropViewBox(asset, object.shape.crop);
      const height = object.width * (source.height / source.width);
      object.y += (object.height - height) / 2;
      object.height = height;
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
      const ordered = [...screen.objects].sort((a, b) => a.order - b.order);
      const from = ordered.findIndex((o) => o.id === command.objectId);
      const to =
        command.direction === "front"
          ? ordered.length - 1
          : command.direction === "back"
            ? 0
            : command.direction === "forward"
              ? Math.min(ordered.length - 1, from + 1)
              : Math.max(0, from - 1);
      if (from === to) return project;
      const [object] = ordered.splice(from, 1);
      ordered.splice(to, 0, object);
      ordered.forEach((o, i) => (o.order = i));
      screen.objects = ordered;
    } else if (command.type === "remove") screen.objects.splice(index, 1);
    else {
      const {
        name,
        text,
        binding,
        symbolId,
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
        if (
          object.shape.type !== "rectangle" &&
          object.shape.type !== "ellipse"
        )
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
      if (symbolId !== undefined) {
        if (definitionId || object.shape.type !== "symbol")
          throw new Error("参照先は画面上の Symbol 配置にだけ設定できます");
        if (!next.symbols.some((item) => item.id === symbolId))
          throw new Error("Symbol 定義が見つかりません");
        object.shape.symbolId = symbolId;
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
    }
  }
  return finish(project, next);
}
function finish(project: Project, next: Project): Project {
  const usedAssets = referencedAssets(next);
  next.assets = next.assets.filter((asset) => usedAssets.has(asset.id));

  if (next.symbols.some((s) => s.objects.length === 0))
    throw new Error("Symbol 定義には図形を 1 つ以上残してください");
  // Validate first; invalid values must never disappear into a no-op comparison.
  serializeProject(next);
  if (projectContent(next) === projectContent(project)) return project;
  next.manifest.projectRevision++;
  return parseProject(JSON.stringify(next));
}
