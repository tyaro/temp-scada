import { parseClipboard } from "./clipboard";
import { canvasColors } from "./canvas-colors";
import {
  parseProject,
  serializeProject,
  getBounds,
  type Project,
  type TagBinding,
  type ShapePaint,
} from "./project";
import builtins from "./symbol-library.json";
import type { Point, SymbolDefinition, ScreenObject, Screen } from "./project";
export type AddKind = "rectangle" | "ellipse" | "text" | "line" | "pipe";
export interface ObjectPatch {
  paint?: ShapePaint;
  name?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  text?: string;
  binding?: TagBinding | null;
  symbolId?: string;
  colorMode?: "monochrome" | "definition";
  points?: Point[];
  strokeWidth?: number;
  arrow?: "none" | "end";
}
export interface OutlineStylePatch {
  mode?: "none" | "enabled";
  color?: string;
  width?: number;
}
export type AlignMode =
  "left" | "right" | "top" | "bottom" | "center-x" | "center-y";
type ScreenCommand =
  | {
      type: "create-screen";
      name: string;
      width: number;
      height: number;
      background?: string;
    }
  | {
      type: "update-screen";
      background?: string;
      screenId: string;
      name: string;
      width: number;
      height: number;
    }
  | { type: "reorder-screen"; screenId: string; direction: "up" | "down" }
  | { type: "duplicate-screen"; screenId: string }
  | { type: "remove-screen"; screenId: string };
export type ObjectCommand = (
  | {
      type: "create-folder";
      screenId: string;
      name: string;
      parentId: string | null;
    }
  | { type: "rename-folder"; screenId: string; folderId: string; name: string }
  | {
      type: "move-folder";
      screenId: string;
      folderId: string;
      parentId: string | null;
    }
  | { type: "remove-folder"; screenId: string; folderId: string }
  | {
      type: "set-folder";
      screenId: string;
      objectIds: string[];
      folderId: string | null;
    }
  | {
      type: "distribute";
      screenId: string;
      objectIds: string[];
      axis: "x" | "y";
    }
  | {
      type: "set-outline-style";
      screenId: string;
      objectIds: string[];
      patch: OutlineStylePatch;
    }
  | {
      type: "set-line-style";
      screenId: string;
      objectIds: string[];
      patch: { strokeWidth?: number; arrow?: "none" | "end" };
    }
  | {
      type: "set-color";
      screenId: string;
      objectIds: string[];
      fill: string;
      convertDefinitionSymbols?: boolean;
    }
  | {
      type: "set-visibility";
      screenId: string;
      objectId: string;
      visible: boolean;
    }
  | { type: "set-lock"; screenId: string; objectId: string; locked: boolean }
  | {
      type: "paste";
      screenId: string;
      text: string;
      origin: string;
      center: Point;
      offset?: number;
    }
  | {
      type: "move-vertex";
      screenId: string;
      objectId: string;
      index: number;
      point: Point;
    }
  | {
      type: "move-many";
      screenId: string;
      objectIds: string[];
      dx: number;
      dy: number;
    }
  | {
      type: "duplicate-many";
      screenId: string;
      objectIds: string[];
    }
  | {
      type: "align";
      screenId: string;
      objectIds: string[];
      alignment: AlignMode;
    }
  | { type: "remove-many"; screenId: string; objectIds: string[] }
  | { type: "add"; screenId: string; kind: AddKind; center?: Point }
  | {
      type: "add-symbol";
      screenId: string;
      template: "pump" | "valve";
      center?: Point;
    }
  | { type: "update"; screenId: string; objectId: string; patch: ObjectPatch }
  | { type: "make-symbol-unique"; screenId: string; objectId: string }
  | { type: "duplicate"; screenId: string; objectId: string }
  | {
      type: "reorder";
      screenId: string;
      objectId: string;
      direction: "front" | "back" | "forward" | "backward";
    }
  | { type: "remove"; screenId: string; objectId: string }
) & { definitionId?: string };

export type EditCommand =
  | { type: "update-project"; name: string }
  | ScreenCommand
  | ObjectCommand
  | { type: "create-symbol"; name: string; width: number; height: number }
  | {
      type: "update-symbol";
      symbolId: string;
      name: string;
      width: number;
      height: number;
    }
  | { type: "duplicate-symbol"; symbolId: string }
  | { type: "remove-symbol"; symbolId: string }
  | {
      type: "place-symbol";
      symbolId: string;
      screenId: string;
      center?: Point;
    };

export function isObjectCommand(
  command: EditCommand,
): command is ObjectCommand {
  return [
    "create-folder",
    "rename-folder",
    "move-folder",
    "remove-folder",
    "set-folder",
    "distribute",
    "set-color",
    "set-line-style",
    "set-outline-style",
    "set-visibility",
    "set-lock",
    "paste",
    "move-vertex",
    "move-many",
    "duplicate-many",
    "align",
    "remove-many",
    "add",
    "add-symbol",
    "update",
    "duplicate",
    "make-symbol-unique",
    "reorder",
    "remove",
  ].includes(command.type);
}
export function symbolUsage(project: Project, symbolId: string): number {
  return project.screens
    .flatMap((s) => s.objects)
    .filter((o) => o.shape.type === "symbol" && o.shape.symbolId === symbolId)
    .length;
}

/** RFC 9562 UUID v7。ID は順序として使わない。 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** 変更はコピー上で検証し、失敗時は元の Project を保持する。 */
export function applyCommand(
  project: Project,
  command: EditCommand,
  mode: "edit" | "preview",
): Project {
  if (mode !== "edit") throw new Error("表示プレビューでは編集できません");
  const next = parseProject(serializeProject(project));
  if (command.type === "update-project") {
    const name = command.name.trim();
    if (!name) throw new Error("プロジェクト名を入力してください");
    next.manifest.name = name;
    return finish(project, next);
  }
  if (command.type === "create-symbol") {
    next.symbols.push({
      id: newId(),
      name: screenName(command.name),
      width: command.width,
      height: command.height,
      objects: [
        {
          id: newId(),
          order: 0,
          x: command.width * 0.2,
          y: command.height * 0.2,
          width: command.width * 0.6,
          height: command.height * 0.6,
          fill: "#83bfcd",
          shape: {
            type: "rectangle",
            paint: { fillEnabled: true, stroke: null },
          },
        },
      ],
      folders: [],
    });
    return finish(project, next);
  }
  if (
    command.type === "update-symbol" ||
    command.type === "duplicate-symbol" ||
    command.type === "remove-symbol" ||
    command.type === "place-symbol"
  ) {
    const definition = next.symbols.find((s) => s.id === command.symbolId);
    if (!definition) throw new Error("Symbol 定義が見つかりません");
    if (command.type === "update-symbol")
      Object.assign(definition, {
        name: screenName(command.name),
        width: command.width,
        height: command.height,
      });
    else if (command.type === "duplicate-symbol") {
      next.symbols.push(copySymbol(definition));
    } else if (command.type === "remove-symbol") {
      if (symbolUsage(next, definition.id))
        throw new Error("配置で使用中の Symbol 定義は削除できません");
      next.symbols = next.symbols.filter((s) => s.id !== definition.id);
    } else {
      const target = next.screens.find((s) => s.id === command.screenId);
      if (!target) throw new Error("画面が見つかりません");
      target.objects.push({
        id: newId(),
        order: Math.max(-1, ...target.objects.map((o) => o.order)) + 1,
        x: 40,
        y: 40,
        width: definition.width,
        height: definition.height,
        fill: canvasColors(target.background).newShape,
        shape: {
          type: "symbol",
          colorMode: "monochrome",
          symbolId: definition.id,
        },
      });
      centerObject(target.objects.at(-1)!, command.center);
    }
    return finish(project, next);
  }
  if (command.type === "create-screen") {
    next.screens.push({
      id: newId(),
      name: screenName(command.name),
      width: command.width,
      height: command.height,
      background: command.background ?? "#ffffff",
      objects: [],
      folders: [],
    });
    return finish(project, next);
  }
  const definitionId = isObjectCommand(command)
    ? command.definitionId
    : undefined;
  const targetScreen = next.screens.find((s) => s.id === command.screenId);
  const screen = definitionId
    ? next.symbols.find((s) => s.id === definitionId)
    : targetScreen;
  if (!screen) throw new Error("画面が見つかりません");
  if (command.type === "create-folder") {
    if (
      command.parentId !== null &&
      !screen.folders.some((folder) => folder.id === command.parentId)
    )
      throw new Error("同じ所有先の親フォルダーが見つかりません");
    screen.folders.push({
      id: newId(),
      name: folderName(command.name),
      order: Math.max(-1, ...screen.folders.map((folder) => folder.order)) + 1,
      ...(command.parentId === null ? {} : { parentId: command.parentId }),
    });
    return finish(project, next);
  }
  if (
    command.type === "rename-folder" ||
    command.type === "move-folder" ||
    command.type === "remove-folder"
  ) {
    const folder = screen.folders.find(
      (folder) => folder.id === command.folderId,
    );
    if (!folder) throw new Error("フォルダーが見つかりません");
    if (command.type === "rename-folder")
      folder.name = folderName(command.name);
    else if (command.type === "move-folder") {
      if (
        command.parentId !== null &&
        !screen.folders.some((item) => item.id === command.parentId)
      )
        throw new Error("同じ所有先の親フォルダーが見つかりません");
      if (command.parentId === null) delete folder.parentId;
      else folder.parentId = command.parentId;
    } else {
      if (
        screen.folders.some((child) => child.parentId === folder.id) ||
        screen.objects.some((object) => object.folderId === folder.id)
      )
        throw new Error(
          "子フォルダーまたは配置があるため削除できません。空のフォルダーだけ削除できます。",
        );
      screen.folders = screen.folders.filter((item) => item.id !== folder.id);
    }
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
          (o.shape.type === "text" && o.shape.binding),
      )
    )
      throw new Error(
        "Symbol定義にはSymbol配置やタグ付きTextを貼り付けできません",
      );
    if (
      !Number.isFinite(command.center.x) ||
      !Number.isFinite(command.center.y) ||
      !Number.isFinite(command.offset ?? 0)
    )
      throw new Error("貼り付け先は有限の座標にしてください");
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
        screen.objects.push(copy);
      });
    return finish(project, next);
  }
  if (command.type === "update-screen") {
    if (command.background !== undefined)
      Object.assign(screen, { background: command.background });
    Object.assign(screen, {
      name: screenName(command.name),
      width: command.width,
      height: command.height,
    });
    return finish(project, next);
  }
  if (command.type === "reorder-screen") {
    const from = next.screens.findIndex((item) => item.id === screen.id);
    const to =
      command.direction === "up"
        ? Math.max(0, from - 1)
        : Math.min(next.screens.length - 1, from + 1);
    if (from === to) return project;
    const [item] = next.screens.splice(from, 1);
    next.screens.splice(to, 0, item);
    return finish(project, next);
  }
  if (command.type === "duplicate-screen") {
    const copy = renewOwnerIds(JSON.parse(JSON.stringify(screen)) as Screen);
    copy.name = screen.name.slice(0, 196) + " コピー";
    next.screens.push(copy);
    return finish(project, next);
  }
  if (command.type === "remove-screen") {
    if (next.screens.length === 1)
      throw new Error("最後の画面は削除できません");
    next.screens = next.screens.filter((s) => s.id !== screen.id);
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
          (key) => !["mode", "color", "width"].includes(key),
        )
      )
        throw new Error("枠線のスタイル指定が不正です");
      const { mode, color, width } = command.patch;
      if (mode === undefined && color === undefined && width === undefined)
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
      if (mode === "none" && (color !== undefined || width !== undefined))
        throw new Error(
          "枠線なしと色・幅は同時に指定できません。色・幅の指定を解除してください",
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
      }
    } else if (command.type === "set-line-style") {
      if (
        !command.patch ||
        typeof command.patch !== "object" ||
        Array.isArray(command.patch) ||
        Object.keys(command.patch).some(
          (key) => !["strokeWidth", "arrow"].includes(key),
        )
      )
        throw new Error("線・配管のスタイル指定が不正です");
      const { strokeWidth, arrow } = command.patch;
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
        }
    } else if (command.type === "set-folder") {
      if (
        command.folderId !== null &&
        !screen.folders.some((folder) => folder.id === command.folderId)
      )
        throw new Error("同じ所有先の所属フォルダーが見つかりません");
      for (const object of objects) {
        if (command.folderId === null) delete object.folderId;
        else object.folderId = command.folderId;
      }
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
            !object.shape.paint.fillEnabled &&
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
            object.shape.paint.fillEnabled &&
            object.fill.toLowerCase() !== fill
          )
            object.fill = fill;
          if (
            object.shape.paint.stroke &&
            object.shape.paint.stroke.color.toLowerCase() !== fill
          )
            object.shape.paint.stroke.color = fill;
        } else if (object.fill.toLowerCase() !== fill) object.fill = fill;
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
            ? { type: "text", text: "テキスト" }
            : {
                type: command.kind,
                paint: { fillEnabled: true, stroke: null },
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
    centerObject(screen.objects.at(-1)!, command.center);
  } else {
    const index = screen.objects.findIndex((o) => o.id === command.objectId);
    if (index < 0) throw new Error("図形が見つかりません");
    if (command.type === "make-symbol-unique") {
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
      shape.points[command.index] = { ...command.point };
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
        colorMode,
        paint,
        points,
        strokeWidth,
        arrow,
        ...geometry
      } = command.patch;
      const object = screen.objects[index];
      Object.assign(object, geometry);
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
      if (text !== undefined) {
        if (object.shape.type !== "text")
          throw new Error("Text 以外に文字列は設定できません");
        object.shape.text = text;
      }
      if (
        points !== undefined ||
        strokeWidth !== undefined ||
        arrow !== undefined
      ) {
        if (object.shape.type !== "polyline")
          throw new Error("折れ線以外に頂点や線幅は設定できません");
        if (points !== undefined) object.shape.points = points;
        if (strokeWidth !== undefined) object.shape.strokeWidth = strokeWidth;
        if (arrow !== undefined) object.shape.arrow = arrow;
      }
    }
  }
  return finish(project, next);
}
function copySymbol(definition: SymbolDefinition): SymbolDefinition {
  const copy = renewOwnerIds(
    JSON.parse(JSON.stringify(definition)) as SymbolDefinition,
  );
  copy.name = definition.name.slice(0, 196) + " コピー";
  return copy;
}
function renewOwnerIds<T extends Screen | SymbolDefinition>(copy: T): T {
  copy.id = newId();
  const folders = new Map(copy.folders.map((folder) => [folder.id, newId()]));
  for (const folder of copy.folders) {
    folder.id = folders.get(folder.id)!;
    if (folder.parentId) folder.parentId = folders.get(folder.parentId)!;
  }
  for (const object of copy.objects) {
    object.id = newId();
    if (object.folderId) object.folderId = folders.get(object.folderId)!;
  }
  return copy;
}
function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("フォルダー名を入力してください");
  return trimmed;
}
function screenName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("画面名を入力してください");
  return trimmed;
}
function finish(project: Project, next: Project): Project {
  if (next.symbols.some((s) => s.objects.length === 0))
    throw new Error("Symbol 定義には図形を 1 つ以上残してください");
  if (serializeProject(next) === serializeProject(project)) return project;
  next.manifest.projectRevision++;
  return parseProject(JSON.stringify(next));
}

function centerObject(object: ScreenObject, center?: Point) {
  if (!center) return;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y))
    throw new Error("配置先は有限の座標にしてください");
  const bounds = getBounds(object);
  object.x = center.x - bounds.x - bounds.width / 2;
  object.y = center.y - bounds.y - bounds.height / 2;
}
