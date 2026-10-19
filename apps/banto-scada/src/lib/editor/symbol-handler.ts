import type { Project } from "../project";
import { canvasColors } from "../canvas-colors";
import type { SymbolCommand } from "./commands";
import {
  centerObject,
  copySymbol,
  newId,
  screenName,
  symbolUsage,
} from "./model-helpers";
import { unhandledCommand } from "./unhandled-command";

/** Mutates only the candidate. Validation and revision updates belong to applyCommand. */
export function applySymbolCommand(
  next: Project,
  command: SymbolCommand,
): void {
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
          rotation: 0,
          x: command.width * 0.2,
          y: command.height * 0.2,
          width: command.width * 0.6,
          height: command.height * 0.6,
          shape: {
            type: "rectangle",
            paint: {
              fill: {
                enabled: true,
                paint: { type: "solid", color: "#83bfcd", alpha: 1 },
              },
              stroke: null,
            },
          },
        },
      ],
      folders: [],
    });
    return;
  }
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
  } else if (command.type === "place-symbol") {
    const target = next.screens.find((s) => s.id === command.screenId);
    if (!target) throw new Error("画面が見つかりません");
    target.objects.push({
      id: newId(),
      order: Math.max(-1, ...target.objects.map((o) => o.order)) + 1,
      rotation: 0,
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
  } else return unhandledCommand(command);
}
