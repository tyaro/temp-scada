import { describe, expect, it } from "vitest";
import {
  polygonHitStrokeWidth,
  polygonLocalPoints,
  polygonStrokeBounds,
} from "./polygon";
import minimal from "../../../../examples/minimal.project.json";
import { applyCommand } from "./editor";
import {
  getLocalBounds,
  parseProject,
  strokeOverflowIds,
  type ScreenObject,
} from "./project";

function polygonObject(
  points: { x: number; y: number }[],
  stroke: number | null,
  frame = { x: 0, y: 0, width: 100, height: 100 },
): ScreenObject {
  return {
    id: "p",
    order: 0,
    rotation: 0,
    ...frame,
    shape: {
      type: "polygon",
      points,
      paint: {
        fill: {
          enabled: true,
          paint: { type: "solid", color: "#336699", alpha: 1 },
        },
        stroke:
          stroke === null
            ? null
            : { color: "#000000", alpha: 1, width: stroke, lineStyle: "solid" },
      },
    },
  } as ScreenObject;
}

/** 頂角 2α の二等辺三角形（頂点は上）。sin α を与える。 */
function isoceles(sinAlpha: number, height = 100) {
  const tan = sinAlpha / Math.sqrt(1 - sinAlpha * sinAlpha);
  const half = height * tan;
  return [
    { x: half, y: 0 },
    { x: 2 * half, y: height },
    { x: 0, y: height },
  ];
}

describe("polygonLocalPoints", () => {
  it("割合の頂点を枠の実寸へ直す", () => {
    expect(
      polygonLocalPoints({
        width: 200,
        height: 50,
        shape: {
          type: "polygon",
          points: [
            { x: 0.5, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      }),
    ).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 50 },
      { x: 0, y: 50 },
    ]);
  });
});

describe("polygonStrokeBounds", () => {
  it("includes the round caps of dots at the vertices for a dotted outline", () => {
    // 10×100 の細い三角形・線幅 10。実線・破線の上端は miter を超えて bevel になり -0.25 付近だが、
    // 点線は頂点 (5, 0) に半径 5 の点が乗るので -5 まで出る。
    const points = [
      { x: 5, y: 0 },
      { x: 10, y: 100 },
      { x: 0, y: 100 },
    ];
    const solid = polygonStrokeBounds(points, 10);
    const dashed = polygonStrokeBounds(points, 10, "dashed");
    const dotted = polygonStrokeBounds(points, 10, "dotted");
    expect(solid.y).toBeGreaterThan(-1);
    expect(dashed).toEqual(solid);
    expect(dotted.y).toBe(-5);
    expect(dotted.x).toBeLessThanOrEqual(-5);
    expect(dotted.x + dotted.width).toBeGreaterThanOrEqual(15);
    expect(dotted.y + dotted.height).toBeGreaterThanOrEqual(105);
  });
  it("枠線がなければ頂点の外接矩形（＝枠）", () => {
    expect(
      polygonStrokeBounds(
        [
          { x: 50, y: 0 },
          { x: 100, y: 80 },
          { x: 0, y: 80 },
        ],
        0,
      ),
    ).toEqual({ x: 0, y: 0, width: 100, height: 80 });
  });

  it("直角の三角形は直角と 45° の角の miter の先端まで含む", () => {
    const b = polygonStrokeBounds(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ],
      2,
    );
    // 直角の先端は (-1, -1)。45° の角は比 1/sin(22.5°) ≈ 2.61 で、先端は外へ 1 + √2。
    expect(b.x).toBeCloseTo(-1, 9);
    expect(b.y).toBeCloseTo(-1, 9);
    expect(b.x + b.width).toBeCloseTo(101 + Math.SQRT2, 9);
    expect(b.y + b.height).toBeCloseTo(101 + Math.SQRT2, 9);
  });

  it("limit の境目: 比が 4 以下なら先端を含み、4 を超えれば bevel で辺の長方形だけ", () => {
    const half = 5;
    const under = polygonStrokeBounds(isoceles(1 / 3.99), 2 * half);
    expect(under.y).toBeCloseTo(-3.99 * half, 6);
    const over = polygonStrokeBounds(isoceles(1 / 4.01), 2 * half);
    // bevel のとき頂点の上は辺の法線方向の張り出し（半幅 × sin α）だけ。
    expect(over.y).toBeCloseTo(-half / 4.01, 6);
    expect(over.y).toBeGreaterThan(-half);
  });

  it("180° の頂点（辺の途中の点）は先端を足さず、法線方向の張り出しだけ", () => {
    const b = polygonStrokeBounds(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      4,
    );
    for (const [key, value] of Object.entries({
      x: -2,
      y: -2,
      width: 104,
      height: 104,
    }))
      expect(b[key as keyof typeof b]).toBeCloseTo(value, 9);
  });

  it("ほぼ折り返す角は bevel になり、先端が外へ飛び出さない", () => {
    const b = polygonStrokeBounds(
      [
        { x: 0, y: 0 },
        { x: 100, y: 1 },
        { x: 0, y: 2 },
      ],
      10,
    );
    expect(b.x + b.width).toBeLessThan(100 + 0.5);
    expect(Number.isFinite(b.width) && Number.isFinite(b.height)).toBe(true);
  });
});

describe("多角形の外形と枠線のはみ出し", () => {
  const triangle = [
    { x: 0.5, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it("getLocalBounds は枠線なしで枠、ありで miter の先端を含む", () => {
    expect(getLocalBounds(polygonObject(triangle, null))).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    const stroked = getLocalBounds(polygonObject(triangle, 4));
    // 頂角は 2·atan(0.5) で比 1/sin(atan 0.5) = √5 ≤ 4 なので先端は 2√5 上。
    expect(stroked.y).toBeCloseTo(-2 * Math.sqrt(5), 9);
  });

  it("strokeOverflowIds は鋭い角の先端が枠から出る多角形を拾う", () => {
    const owner = { width: 100, height: 100 };
    expect(
      strokeOverflowIds({ ...owner, objects: [polygonObject(triangle, null)] }),
    ).toEqual([]);
    expect(
      strokeOverflowIds({ ...owner, objects: [polygonObject(triangle, 4)] }),
    ).toEqual(["p"]);
  });

  it("当たり判定の線の幅は max(12, 線幅 + 8)", () => {
    expect(polygonHitStrokeWidth({ paint: { stroke: null } })).toBe(12);
    expect(polygonHitStrokeWidth({ paint: { stroke: { width: 10 } } })).toBe(
      18,
    );
  });
});

describe("多角形の挿入", () => {
  it("add は矩形と同じ枠と塗りの三角形を足し、保存形式の検証を通る", () => {
    const original = parseProject(JSON.stringify(minimal));
    const screenId = original.screens[0].id;
    const add = (kind: "rectangle" | "polygon") =>
      applyCommand(
        original,
        { type: "add", screenId, kind, center: { x: 600, y: 400 } },
        "edit",
      ).screens[0].objects.at(-1)!;
    const polygon = add("polygon"),
      rectangle = add("rectangle");
    expect(polygon).toMatchObject({
      x: rectangle.x,
      y: rectangle.y,
      width: 160,
      height: 100,
      shape: {
        type: "polygon",
        points: [
          { x: 0.5, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        paint:
          rectangle.shape.type === "rectangle" ? rectangle.shape.paint : {},
      },
    });
    expect(polygon).not.toHaveProperty("fill");
  });
});

describe("多角形の頂点の編集（update の polygonVertices）", () => {
  const original = parseProject(JSON.stringify(minimal));
  const screenId = original.screens[0].id;
  const added = applyCommand(
    original,
    { type: "add", screenId, kind: "polygon", center: { x: 600, y: 400 } },
    "edit",
  );
  const polygon = added.screens[0].objects.at(-1)!;
  const update = (patch: Record<string, unknown>) =>
    applyCommand(
      added,
      { type: "update", screenId, objectId: polygon.id, patch },
      "edit",
    ).screens[0].objects.at(-1)!;

  it("枠を作り直して頂点を足し、保存形式の検証を通る", () => {
    const next = update({
      polygonVertices: [
        { keep: 0 },
        { keep: 1 },
        { keep: 2 },
        { x: -40, y: 50 },
      ],
    });
    expect(next).toMatchObject({
      x: polygon.x - 40,
      y: polygon.y,
      width: 200,
      height: 100,
      shape: {
        points: [
          { x: 0.6, y: 0 },
          { x: 1, y: 1 },
          { x: 0.2, y: 1 },
          { x: 0, y: 0.5 },
        ],
      },
    });
    expect(() =>
      parseProject(
        JSON.stringify({
          ...added,
          screens: [
            {
              ...added.screens[0],
              objects: [...added.screens[0].objects.slice(0, -1), next],
            },
            ...added.screens.slice(1),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("拒否した編集は Project を変えない", () => {
    expect(() =>
      update({
        polygonVertices: [
          { x: 0, y: 5 },
          { x: 50, y: 5 },
          { x: 100, y: 5 },
        ],
      }),
    ).toThrow("1以上");
    expect(added.screens[0].objects.at(-1)).toEqual(polygon);
  });

  it("頂点と位置・サイズを同じ確定で変えない", () => {
    expect(() =>
      update({
        width: 300,
        polygonVertices: [{ keep: 0 }, { keep: 1 }, { x: 0, y: 50 }],
      }),
    ).toThrow("別々に");
  });

  it("多角形以外には設定できない", () => {
    const rect = original.screens[0].objects[0];
    expect(() =>
      applyCommand(
        original,
        {
          type: "update",
          screenId,
          objectId: rect.id,
          patch: { polygonVertices: [{ x: 0, y: 0 }] },
        },
        "edit",
      ),
    ).toThrow("多角形以外");
  });
});

describe("多角形の頂点の移動（move-vertex）", () => {
  const original = parseProject(JSON.stringify(minimal));
  const screenId = original.screens[0].id;
  const added = applyCommand(
    original,
    { type: "add", screenId, kind: "polygon", center: { x: 600, y: 400 } },
    "edit",
  );
  const polygon = added.screens[0].objects.at(-1)!;
  const move = (index: number, point: { x: number; y: number }) =>
    applyCommand(
      added,
      { type: "move-vertex", screenId, objectId: polygon.id, index, point },
      "edit",
    ).screens[0].objects.at(-1)!;

  it("実寸の点へ動かし、枠を作り直す", () => {
    expect(move(0, { x: -40, y: -20 })).toMatchObject({
      x: polygon.x - 40,
      y: polygon.y - 20,
      width: 200,
      height: 120,
      shape: {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0.2, y: 1 },
        ],
      },
    });
  });

  it("一直線になる移動は拒否し、Project を変えない", () => {
    expect(() => move(0, { x: 80, y: 100 })).toThrow("1以上");
    expect(added.screens[0].objects.at(-1)).toEqual(polygon);
  });

  it("無い頂点は拒否する", () => {
    expect(() => move(3, { x: 0, y: 0 })).toThrow("頂点が見つかりません");
  });
});
