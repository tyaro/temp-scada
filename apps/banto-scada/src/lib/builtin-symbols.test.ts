import { describe, expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import {
  BUILTIN_PARTS,
  builtinDefinition,
  isBuiltinTemplate,
} from "./builtin-symbols";
import { availableFavorites, parseFavorites } from "./designer/favorites";

const fresh = () => parseProject(JSON.stringify(sample));

describe("built-in parts", () => {
  it("lists the flow-diagram parts after the pump and valve", () => {
    expect(BUILTIN_PARTS.map((part) => part.name)).toEqual([
      "ポンプ",
      "バルブ",
      "ブロワー",
      "槽",
      "塔",
      "サイクロン",
      "熱交換器",
      "撹拌機",
      "コンベヤ",
      "スクリュー",
      "モーター",
    ]);
  });

  it("keeps every id unique across the library", () => {
    const ids = BUILTIN_PARTS.flatMap(({ template }) => {
      const definition = builtinDefinition(template);
      return [definition.id, ...definition.objects.map((object) => object.id)];
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILTIN_PARTS.map((part) => [part.template]))(
    "%s draws inside its frame",
    (template) => {
      const definition = builtinDefinition(template);
      for (const object of definition.objects) {
        if (object.shape.type !== "polyline") continue;
        for (const point of object.shape.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(definition.width);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(definition.height);
        }
      }
    },
  );

  it.each(BUILTIN_PARTS.map((part) => [part.template]))(
    "%s is placed at its own size and survives a save round trip",
    (template) => {
      const project = fresh();
      const screenId = project.screens[0].id;
      const next = applyCommand(
        project,
        { type: "add-symbol", screenId, template },
        "edit",
      );
      const definition = builtinDefinition(template);
      const placed = next.screens[0].objects.at(-1)!;
      expect(placed.shape).toMatchObject({
        type: "symbol",
        symbolId: definition.id,
      });
      expect(placed).toMatchObject({
        width: definition.width,
        height: definition.height,
      });
      expect(next.symbols.find((s) => s.id === definition.id)).toEqual(
        definition,
      );
      expect(parseProject(serializeProject(next))).toEqual(next);
    },
  );

  it("recognises only library keys as templates", () => {
    expect(isBuiltinTemplate("tower")).toBe(true);
    expect(isBuiltinTemplate("toString")).toBe(false);
    expect(isBuiltinTemplate("boiler")).toBe(false);
  });

  it("keeps favorites of any built-in part", () => {
    const keys = parseFavorites(
      JSON.stringify(["builtin:cyclone", "builtin:boiler", "builtin:motor"]),
    );
    expect(keys).toEqual(["builtin:cyclone", "builtin:motor"]);
    expect(
      availableFavorites(keys, "p", [], true).map((item) => item.label),
    ).toEqual(["サイクロン", "モーター"]);
  });
});
