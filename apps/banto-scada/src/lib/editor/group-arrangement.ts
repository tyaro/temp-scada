import type { Screen, SymbolDefinition } from "../project";
import { selectionUnits, unitBounds } from "../geometric-groups";
import type { SelectionCommand } from "./commands";

export function arrangeUnits(
  owner: Screen | SymbolDefinition,
  command: Extract<SelectionCommand, { type: "align" | "distribute" }>,
): "finish" | "unchanged" {
  const units = selectionUnits(owner, command.objectIds).map((objects) => ({
    objects,
    bounds: unitBounds(objects),
  }));
  if (command.type === "distribute") {
    if (units.length < 3)
      throw new Error("等間隔に配置する単位を3件以上選択してください");
    if (command.axis !== "x" && command.axis !== "y")
      throw new Error("等間隔配置の方向が不正です");
    const axis = command.axis,
      dimension = axis === "x" ? "width" : "height";
    const entries = units
      .map((unit) => ({
        ...unit,
        center: unit.bounds[axis] + unit.bounds[dimension] / 2,
      }))
      .sort((a, b) => a.center - b.center);
    const start = entries[0].center,
      end = entries.at(-1)!.center;
    if (start === end) return "unchanged";
    entries.slice(1, -1).forEach((entry, index) => {
      const fraction = (index + 1) / (entries.length - 1),
        target = start * (1 - fraction) + end * fraction;
      if (
        Math.abs(target - entry.center) >
        Number.EPSILON *
          Math.max(1, Math.abs(target), Math.abs(entry.center)) *
          4
      )
        entry.objects.forEach(
          (object) => (object[axis] += target - entry.center),
        );
    });
  } else {
    const left = Math.min(...units.map((unit) => unit.bounds.x)),
      right = Math.max(
        ...units.map((unit) => unit.bounds.x + unit.bounds.width),
      );
    const top = Math.min(...units.map((unit) => unit.bounds.y)),
      bottom = Math.max(
        ...units.map((unit) => unit.bounds.y + unit.bounds.height),
      );
    for (const { objects, bounds: b } of units) {
      let dx = 0,
        dy = 0;
      if (command.alignment === "left") dx = left - b.x;
      else if (command.alignment === "right") dx = right - b.x - b.width;
      else if (command.alignment === "center-x")
        dx = (left + right) / 2 - b.x - b.width / 2;
      else if (command.alignment === "top") dy = top - b.y;
      else if (command.alignment === "bottom") dy = bottom - b.y - b.height;
      else dy = (top + bottom) / 2 - b.y - b.height / 2;
      objects.forEach((object) => {
        object.x += dx;
        object.y += dy;
      });
    }
  }
  return "finish";
}
