import { parseProject, serializeProject, type Project } from "./project";
import builtins from "./symbol-library.json";
import type { Point, SymbolDefinition } from "./project";
export type AddKind = "rectangle" | "ellipse" | "text" | "line" | "pipe";
export interface ObjectPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  text?: string;
  points?: Point[];
  strokeWidth?: number;
  arrow?: "none" | "end";
}
export type EditCommand =
  | { type: "add"; screenId: string; kind: AddKind }
  | { type: "add-symbol"; screenId: string; template: "pump" | "valve" }
  | { type: "update"; screenId: string; objectId: string; patch: ObjectPatch }
  | { type: "remove"; screenId: string; objectId: string };

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
  const screen = next.screens.find((s) => s.id === command.screenId);
  if (!screen) throw new Error("画面が見つかりません");
  if (command.type === "add" || command.type === "add-symbol") {
    const base = {
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
      x: 40,
      y: 40,
      fill: "#2dd4bf",
    };
    if (command.type === "add-symbol") {
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
  } else {
    const index = screen.objects.findIndex((o) => o.id === command.objectId);
    if (index < 0) throw new Error("図形が見つかりません");
    if (command.type === "remove") screen.objects.splice(index, 1);
    else {
      const { text, points, strokeWidth, arrow, ...geometry } = command.patch;
      const object = screen.objects[index];
      Object.assign(object, geometry);
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
  next.manifest.projectRevision++;
  return parseProject(JSON.stringify(next));
}
