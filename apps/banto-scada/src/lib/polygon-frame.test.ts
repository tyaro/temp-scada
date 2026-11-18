import { describe, expect, it } from "vitest";
import {
  dragPolygonVertex,
  parsePolygonVertexText,
  polygonLayout,
  polygonVertexMove,
  previewPolygonVertex,
  polygonVertexText,
  reframePolygon,
  type PolygonFrame,
  type PolygonVertexEdit,
} from "./polygon-frame";
import { objectToWorld } from "./rotation";
import type { Point } from "./project";

const triangle = [
  { x: 0.5, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
function frame(rotation: number, flipX: boolean, flipY: boolean): PolygonFrame {
  return {
    x: 37.25,
    y: -12.5,
    width: 160,
    height: 100,
    rotation,
    flipX,
    flipY,
    shape: { type: "polygon", points: triangle },
  };
}
/** 配置の中の実寸の頂点の画面上の位置。 */
function world(object: PolygonFrame, index: number): Point {
  const layout = {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    flipX: object.flipX,
    flipY: object.flipY,
  };
  const p = object.shape.points[index];
  return objectToWorld(layout, {
    x: p.x * object.width,
    y: p.y * object.height,
  });
}
function apply(object: PolygonFrame, edits: PolygonVertexEdit[]): PolygonFrame {
  const result = reframePolygon(object, edits);
  if (!result.ok) throw new Error(result.reason);
  return {
    ...object,
    ...result,
    shape: { ...object.shape, points: result.points },
  };
}

describe("reframePolygon", () => {
  for (const rotation of [0, 90, 37])
    for (const flipX of [false, true])
      for (const flipY of [false, true])
        it(`keeps untouched vertices in place (rotation ${rotation}, flipX ${flipX}, flipY ${flipY})`, () => {
          const object = frame(rotation, flipX, flipY);
          // 頂点 0 を枠の外（左上）へ動かし、頂点を 1 つ足す。外接矩形は両軸で広がる。
          const next = apply(object, [
            { x: -40, y: -30 },
            { keep: 1 },
            { keep: 2 },
            { x: 200, y: 50 },
          ]);
          expect(next.width).toBe(240);
          expect(next.height).toBe(130);
          for (const [before, after] of [
            [1, 1],
            [2, 2],
          ]) {
            const a = world(object, before),
              b = world(next, after);
            expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
            expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9);
          }
          // 動かした頂点は、今の枠の左上を原点とした実寸のとおりの位置に来る。
          const layout = { ...object };
          const moved = objectToWorld(layout, { x: -40, y: -30 }),
            got = world(next, 0);
          expect(Math.abs(moved.x - got.x)).toBeLessThan(1e-9);
          expect(Math.abs(moved.y - got.y)).toBeLessThan(1e-9);
        });

  it("keeps untouched ratios bit-for-bit when the frame does not change", () => {
    const object: PolygonFrame = {
      ...frame(37, true, false),
      width: 3,
      height: 7,
      shape: {
        type: "polygon",
        points: [
          { x: 0.1, y: 0 },
          { x: 1, y: 1 / 3 },
          { x: 0.7, y: 1 },
          { x: 0, y: 0.3 },
        ],
      },
    };
    const next = reframePolygon(object, [
      { keep: 0 },
      { keep: 1 },
      { x: 1.5, y: 7 },
      { keep: 3 },
    ]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.x).toBe(object.x);
    expect(next.y).toBe(object.y);
    expect(next.points[0]).toEqual({ x: 0.1, y: 0 });
    expect(Object.is(next.points[1].y, 1 / 3)).toBe(true);
    expect(next.points[3]).toEqual({ x: 0, y: 0.3 });
    expect(next.points[2]).toEqual({ x: 0.5, y: 1 });
  });

  it("keeps ratios on the axis whose extent did not change", () => {
    const object = frame(0, false, false);
    // y だけ広がる編集。x の割合は残す。
    const next = reframePolygon(object, [
      { keep: 0 },
      { keep: 1 },
      { x: 0, y: 150 },
    ]);
    expect(next.ok && next.points.map((p) => p.x)).toEqual([0.5, 1, 0]);
    expect(next.ok && next.height).toBe(150);
  });

  it("returns exact 0 and 1 at the extremes", () => {
    const next = reframePolygon(frame(0, false, false), [
      { x: 0.1, y: 0.3 },
      { x: 10.7, y: 0.3 },
      { x: 3.3, y: 13.9 },
    ]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const xs = next.points.map((p) => p.x),
      ys = next.points.map((p) => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(1);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(1);
  });

  it.each([
    [
      "two vertices",
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      "3〜64",
    ],
    [
      "65 vertices",
      Array.from({ length: 65 }, (_, i) => ({ x: i, y: i % 2 ? 10 : 0 })),
      "3〜64",
    ],
    [
      "horizontal line",
      [
        { x: 0, y: 5 },
        { x: 50, y: 5 },
        { x: 100, y: 5 },
      ],
      "1以上",
    ],
    [
      "vertical line",
      [
        { x: 3, y: 0 },
        { x: 3, y: 50 },
        { x: 3.5, y: 100 },
      ],
      "1以上",
    ],
    [
      "diagonal line",
      [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ],
      "一直線",
    ],
    [
      "same neighbours",
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      "同じ",
    ],
    [
      "non-finite",
      [
        { x: 0, y: 0 },
        { x: NaN, y: 1 },
        { x: 5, y: 5 },
      ],
      "有限",
    ],
    [
      "missing kept vertex",
      [{ keep: 0 }, { keep: 1 }, { keep: 9 }],
      "見つかりません",
    ],
  ] as [string, PolygonVertexEdit[], string][])(
    "rejects %s",
    (_, edits, reason) => {
      const result = reframePolygon(frame(0, false, false), edits);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain(reason);
    },
  );
});

describe("polygon vertex text", () => {
  const object = frame(0, false, false);
  it("formats local vertices and keeps untouched rows", () => {
    const text = polygonVertexText(object);
    expect(text).toBe("80,0\n160,100\n0,100");
    expect(parsePolygonVertexText(text, object)).toBeUndefined();
    expect(parsePolygonVertexText("80,0\n160 , 120\n0,100\n", object)).toEqual([
      { keep: 0 },
      { x: 160, y: 120 },
      { keep: 2 },
    ]);
  });
  it("treats a removed row as a change", () => {
    expect(
      parsePolygonVertexText("80,0\n160,100\n0,100\n0,50", object),
    ).toEqual([{ keep: 0 }, { keep: 1 }, { keep: 2 }, { x: 0, y: 50 }]);
  });
  it("rejects malformed rows", () => {
    expect(() => parsePolygonVertexText("80,0\n160\n0,100", object)).toThrow(
      "x,y",
    );
  });
});

describe("dragPolygonVertex", () => {
  it("returns the local vertex inside the dead zone", () => {
    const object = frame(37, true, false);
    expect(dragPolygonVertex(object, 0, { x: 0.3, y: 0.3 }, null)).toEqual({
      x: 80,
      y: 0,
    });
  });
  for (const rotation of [0, 90, 37])
    for (const flipX of [false, true])
      it(`follows the pointer on screen (rotation ${rotation}, flipX ${flipX})`, () => {
        const object = frame(rotation, flipX, !flipX);
        const delta = { x: 25, y: -40 };
        const point = dragPolygonVertex(object, 0, delta, null);
        const layout = polygonLayout(object);
        const before = objectToWorld(layout, { x: 80, y: 0 }),
          after = objectToWorld(layout, point);
        expect(after.x - before.x).toBeCloseTo(delta.x, 9);
        expect(after.y - before.y).toBeCloseTo(delta.y, 9);
        // 確定すると、動かした頂点はその位置に、ほかの頂点は元の位置に残る。
        const next = apply(object, polygonVertexMove(object, 0, point));
        for (const [i, expected] of [
          [0, after],
          [1, world(object, 1)],
          [2, world(object, 2)],
        ] as const) {
          const got = world(next, i);
          expect(Math.abs(got.x - expected.x)).toBeLessThan(1e-9);
          expect(Math.abs(got.y - expected.y)).toBeLessThan(1e-9);
        }
      });
  it("snaps the screen position to the grid", () => {
    const object = frame(0, false, false);
    const point = dragPolygonVertex(object, 0, { x: 13, y: 9 }, 10);
    expect(object.x + point.x).toBe(130);
    expect(object.y + point.y).toBe(0);
  });
  it("previews without checking the bounding box", () => {
    const object = frame(0, false, false);
    const preview = previewPolygonVertex(object, 0, { x: -40, y: 50 });
    expect(preview.width).toBe(160);
    expect(preview.shape.points[0]).toEqual({ x: -0.25, y: 0.5 });
    expect(preview.shape.points[1]).toBe(object.shape.points[1]);
  });
});
