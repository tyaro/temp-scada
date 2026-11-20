import { describe, expect, it } from "vitest";
import minimal from "../../../../examples/minimal.project.json";
import polygonSymbols from "../../../../examples/polygon-symbols.project.json";
import { applyCommand } from "./editor";
import {
  parseProject,
  strokeOverflowIds,
  validatePolygonPoints,
} from "./project";
import {
  POLYGON_PRESETS,
  isPolygonPreset,
  polygonPresetIcon,
  polygonPresetPoints,
  type PolygonPresetKind,
} from "./polygon-presets";

const kinds = Object.keys(POLYGON_PRESETS) as PolygonPresetKind[];

describe("多角形の初期形", () => {
  it("どの初期形も保存形式の検証を通る", () => {
    expect(kinds).toEqual([
      "polygon",
      "trapezoid",
      "diamond",
      "arrowTag",
      "manualBox",
    ]);
    for (const kind of kinds)
      expect(() =>
        validatePolygonPoints(polygonPresetPoints(kind)),
      ).not.toThrow();
  });
  it("初期形の種類だけを多角形として扱う", () => {
    expect(isPolygonPreset("trapezoid")).toBe(true);
    expect(isPolygonPreset("rectangle")).toBe(false);
    expect(isPolygonPreset("toString")).toBe(false);
  });
  it("頂点は写しを返し、定数を変えさせない", () => {
    const points = polygonPresetPoints("diamond");
    points[0].x = 0.3;
    expect(POLYGON_PRESETS.diamond.points[0].x).toBe(0.5);
  });
  it("手入力の箱は上辺が右上がりの四角形", () => {
    expect(polygonPresetPoints("manualBox")).toEqual([
      { x: 0, y: 0.25 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(
      polygonPresetIcon("manualBox", { x: 8, y: 6, width: 40, height: 20 }),
    ).toBe("8,11 48,6 48,26 8,26");
  });
  it("アイコンは初期形を箱へ当てはめる", () => {
    expect(
      polygonPresetIcon("arrowTag", { x: 8, y: 6, width: 40, height: 20 }),
    ).toBe("8,6 40,6 48,16 40,26 8,26");
  });

  const original = parseProject(JSON.stringify(minimal));
  const screenId = original.screens[0].id;
  for (const kind of kinds)
    it(`${kind} を画面へ挿入でき、保存しても形が変わらない`, () => {
      const added = applyCommand(
        original,
        { type: "add", screenId, kind, center: { x: 600, y: 400 } },
        "edit",
      ).screens[0].objects.at(-1)!;
      expect(added).toMatchObject({
        width: 160,
        height: 100,
        shape: { type: "polygon", points: polygonPresetPoints(kind) },
      });
      // 保存して読み直しても同じ形。
      const saved = parseProject(
        JSON.stringify(
          applyCommand(
            original,
            { type: "add", screenId, kind, center: { x: 600, y: 400 } },
            "edit",
          ),
        ),
      );
      expect(saved.screens[0].objects.at(-1)!.shape).toEqual(added.shape);
    });
  it("初期形を Symbol 定義の中にも置ける", () => {
    const withDefinition = applyCommand(
      original,
      { type: "create-symbol", name: "ホッパー", width: 200, height: 200 },
      "edit",
    );
    const definitionId = withDefinition.symbols.at(-1)!.id;
    const project = applyCommand(
      withDefinition,
      { type: "add", definitionId, screenId, kind: "trapezoid" },
      "edit",
    );
    const inside = project.symbols.at(-1)!.objects.at(-1)!;
    expect(inside.shape).toMatchObject({
      type: "polygon",
      points: polygonPresetPoints("trapezoid"),
    });
    // 定義の大きさに収める（矩形と同じ扱い）。
    expect(inside).toMatchObject({ width: 120, height: 100 });
  });
});

describe("多角形の部品のサンプル", () => {
  const project = parseProject(JSON.stringify(polygonSymbols));
  it("ホッパー・サイロ・行き先の札を多角形と既存の図形だけで作る", () => {
    expect(project.symbols.map((d) => d.name)).toEqual([
      "ホッパー",
      "サイロ",
      "行き先の札",
    ]);
    for (const definition of project.symbols) {
      const types = new Set(definition.objects.map((o) => o.shape.type));
      expect(types.has("polygon")).toBe(true);
      for (const type of types)
        expect(["polygon", "rectangle", "ellipse", "text"]).toContain(type);
      // 角の先端も定義の枠に収め、警告を出さない。
      expect(strokeOverflowIds(definition)).toEqual([]);
    }
  });
  it("画面に定義の色と単色の配置を並べる", () => {
    const modes = project.screens[0].objects.flatMap((o) =>
      o.shape.type === "symbol" ? [o.shape.colorMode] : [],
    );
    expect(modes).toContain("definition");
    expect(modes).toContain("monochrome");
  });
});
