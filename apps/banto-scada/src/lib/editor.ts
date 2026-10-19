import { parseClipboard } from "./clipboard";
import { canvasColors } from "./canvas-colors";
import {
  parseProject,
  serializeProject,
  getBounds,
  type Project,
  type TagBinding,
} from "./project";
import builtins from "./symbol-library.json";
import type { Point, SymbolDefinition, ScreenObject } from "./project";
export type AddKind = "rectangle" | "ellipse" | "text" | "line" | "pipe";
export interface ObjectPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  text?: string;
  binding?: TagBinding | null;
  symbolId?: string;
  points?: Point[];
  strokeWidth?: number;
  arrow?: "none" | "end";
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
          shape: { type: "rectangle" },
        },
      ],
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
        shape: { type: "symbol", symbolId: definition.id },
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
          const copy = JSON.parse(JSON.stringify(source)) as SymbolDefinition;
          copy.id = newId();
          copy.objects.forEach((o) => (o.id = newId()));
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
    const copy = JSON.parse(JSON.stringify(screen));
    copy.id = newId();
    copy.name = screen.name.slice(0, 196) + " コピー";
    copy.objects.forEach((object: { id: string }) => (object.id = newId()));
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
    if (command.type === "move-many") {
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
        shape: { type: "symbol", symbolId: definition.id },
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
            : { type: command.kind },
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
        text,
        binding,
        symbolId,
        points,
        strokeWidth,
        arrow,
        ...geometry
      } = command.patch;
      const object = screen.objects[index];
      Object.assign(object, geometry);
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
  const copy: SymbolDefinition = JSON.parse(JSON.stringify(definition));
  copy.id = newId();
  copy.name = definition.name.slice(0, 196) + " コピー";
  copy.objects.forEach((object) => (object.id = newId()));
  return copy;
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
