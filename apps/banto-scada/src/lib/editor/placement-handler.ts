import {
  getBounds,
  type Project,
  type Screen,
  type SymbolDefinition,
} from "../project";
import { canvasColors } from "../canvas-colors";
import builtins from "../symbol-library.json";
import type {
  ObjectCreationCommand,
  ScreenViewPlacementCommand,
} from "./commands";
import { newId, centerObject } from "./model-helpers";

export function applyScreenViewPlacement(
  screen: Screen | SymbolDefinition,
  command: ScreenViewPlacementCommand,
  definitionId?: string,
): void {
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
}

export function applyObjectCreation(
  next: Project,
  screen: Screen | SymbolDefinition,
  command: ObjectCreationCommand,
  definitionId: string | undefined,
  targetScreen: Screen | undefined,
): void {
  const base = {
    id: newId(),
    order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
    rotation: 0,
    x: 40,
    y: 40,
    fill: canvasColors(definitionId ? "#0b1220" : targetScreen!.background)[
      command.type === "add" && command.kind === "text" ? "newText" : "newShape"
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
}
