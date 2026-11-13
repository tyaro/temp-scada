import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { PolylineObject, Point, Screen } from "./project";
import {
  junctionDiameter,
  junctionTolerance,
  lineJunctions,
  screenJunctions,
  SegmentIndex,
  segmentCells,
  worldLines,
} from "./line-junction";
import ScreenPainting from "./ScreenPainting.svelte";

let next = 0;
const pipe = (
  points: [number, number][],
  extra: Partial<PolylineObject> = {},
  strokeWidth = 2,
): PolylineObject => ({
  id: `p${++next}`,
  order: next,
  rotation: 0,
  x: 0,
  y: 0,
  fill: "#112233",
  shape: {
    type: "polyline",
    points: points.map(([x, y]): Point => ({ x, y })),
    strokeWidth,
    arrow: "none",
  },
  ...extra,
});
const junctions = (...objects: PolylineObject[]) =>
  lineJunctions(worldLines(objects));

describe("lineJunctions", () => {
  it("draws a dot where an end meets the middle of another pipe", () => {
    const main = pipe([
        [0, 0],
        [100, 0],
      ]),
      branch = pipe(
        [
          [50, 0],
          [50, 60],
        ],
        { fill: "#ff0000" },
        4,
      );
    expect(junctions(main, branch)).toEqual([
      {
        x: 50,
        y: 0,
        diameter: junctionDiameter(4),
        color: "#112233",
        opacity: undefined,
        afterId: branch.id,
      },
    ]);
  });

  it("draws after the later pipe even when the through pipe is on top", () => {
    const branch = pipe([
        [50, 60],
        [50, 0.4],
      ]),
      main = pipe(
        [
          [0, 0],
          [100, 0],
        ],
        { fill: "#00ff00", opacity: 0.5 },
      );
    const [dot] = junctions(main, branch);
    expect(dot).toMatchObject({
      x: 50,
      y: 0,
      color: "#00ff00",
      opacity: 0.5,
      afterId: main.id,
    });
  });

  it("treats an inner vertex of the other pipe as its middle", () => {
    const corner = pipe([
        [0, 0],
        [100, 0],
        [100, 100],
      ]),
      branch = pipe([
        [100, 0],
        [200, 0],
      ]);
    expect(junctions(corner, branch)).toHaveLength(1);
  });

  it("does not draw for a simple continuation or a near miss", () => {
    const a = pipe([
      [0, 0],
      [100, 0],
    ]);
    expect(
      junctions(
        a,
        pipe([
          [100, 0],
          [200, 0],
        ]),
      ),
    ).toEqual([]);
    expect(
      junctions(
        a,
        pipe([
          [50, junctionTolerance + 0.1],
          [50, 60],
        ]),
      ),
    ).toEqual([]);
    // 線の上の位置（投影点）が相手の端から許容値以内なら途中ではない（端点からの距離は 0.57 でも）。
    expect(
      junctions(
        a,
        pipe([
          [0.4, 0.4],
          [0.4, 60],
        ]),
      ),
    ).toEqual([]);
    // 交差（どちらの端点も相手に乗らない）はまたぎの対象で、分岐の点は描かない。
    expect(
      junctions(
        a,
        pipe([
          [50, -50],
          [50, 50],
        ]),
      ),
    ).toEqual([]);
  });

  it("draws one dot where three or more ends meet", () => {
    const dots = junctions(
      pipe([
        [0, 0],
        [100, 0],
      ]),
      pipe([
        [100, 0],
        [200, 0],
      ]),
      pipe(
        [
          [100.3, 0],
          [100, 80],
        ],
        { fill: "#abcdef" },
      ),
    );
    expect(dots).toHaveLength(1);
    expect(dots[0]).toMatchObject({ color: "#abcdef", diameter: 6 });
    expect(dots[0].x).toBeCloseTo(100.1);
  });

  it("uses rotated and flipped world coordinates", () => {
    const main = pipe([
      [0, 0],
      [100, 0],
    ]);
    // 横線 (20,30)-(80,30) を中心で 90 度回すと縦線 (50,0)-(50,60) になる。
    const turned = pipe(
      [
        [20, 30],
        [80, 30],
      ],
      { rotation: 90 },
    );
    expect(junctions(main, turned)[0]).toMatchObject({ x: 50, y: 0 });
    // L 字 (50,0)-(50,60)-(90,60) を左右反転すると始点が (90,0) へ移る。
    const flipped = pipe(
      [
        [50, 0],
        [50, 60],
        [90, 60],
      ],
      { flipX: true },
    );
    expect(junctions(main, flipped)[0]).toMatchObject({ x: 90, y: 0 });
    const moved = pipe(
      [
        [0, 0],
        [0, 60],
      ],
      { x: 30 },
    );
    expect(junctions(main, moved)[0]).toMatchObject({ x: 30, y: 0 });
  });

  it("skips hidden pipes and non-polyline objects", () => {
    const main = pipe([
      [0, 0],
      [100, 0],
    ]);
    const hidden = pipe(
      [
        [50, 0],
        [50, 60],
      ],
      { visible: false },
    );
    expect(screenJunctions([main, hidden]).size).toBe(0);
  });

  it("checks only nearby segments on a screen with many pipes", () => {
    const objects: PolylineObject[] = [];
    for (let i = 0; i < 500; i++) {
      const y = i * 10;
      objects.push(
        pipe([
          [0, y],
          [1000, y],
        ]),
      );
      objects.push(
        pipe([
          [(i % 90) * 10 + 5, y],
          [(i % 90) * 10 + 5, y + 5],
        ]),
      );
    }
    const result = screenJunctions(objects);
    expect([...result.values()].flat()).toHaveLength(500);
    // 時間ではなく、端点ごとに調べる線分の数で全組合せでないことを確かめる（CI の負荷に左右されない）。
    const lines = worldLines(objects),
      index = new SegmentIndex(lines);
    const candidates = lines
      .flatMap((line) => [line.points[0], line.points.at(-1)!])
      .map((point) => index.near(point).length);
    expect(Math.max(...candidates)).toBeLessThanOrEqual(20);
    expect(candidates.reduce((sum, n) => sum + n, 0)).toBeLessThan(
      objects.length * 20,
    );
  });
});

describe("segmentCells", () => {
  it("covers only cells along a long diagonal, not its bounding box", () => {
    // 外接矩形なら (1000000/64)^2 ≒ 2.4 億格子。線分に沿う格子だけなら数万。
    const keys = segmentCells({ x: 0, y: 0 }, { x: 1000000, y: 1000000 }, 0.5);
    expect(keys.length).toBeLessThan(100000);
    expect(keys).toContain("0,0");
    expect(keys).toContain("15625,15625");
    expect(keys).not.toContain("0,15625");
  });

  it("finds a junction on the middle of a long diagonal pipe", () => {
    const main = pipe([
        [0, 0],
        [1000000, 1000000],
      ]),
      branch = pipe([
        [500000, 500000],
        [500000, 600000],
      ]);
    expect(junctions(main, branch)).toHaveLength(1);
  });

  it("includes cells reached only through the margin and vertical segments", () => {
    expect(segmentCells({ x: 63.8, y: 10 }, { x: 63.8, y: 200 }, 0.5)).toEqual(
      expect.arrayContaining(["0,0", "0,3", "1,0", "1,3"]),
    );
  });
});

describe("rendering", () => {
  it("paints the dot right after the later pipe", () => {
    const main = pipe([
        [0, 0],
        [100, 0],
      ]),
      branch = pipe([
        [50, 0],
        [50, 60],
      ]);
    const screen = {
      id: "s",
      name: "s",
      width: 200,
      height: 200,
      background: "#ffffff",
      objects: [branch, main],
    } as unknown as Screen;
    const { body } = render(ScreenPainting, {
      props: { screen, screens: [screen], symbols: [] },
    });
    const circle = body.match(/<circle[^>]*data-line-junction="([^"]+)"[^>]*>/);
    expect(circle?.[1]).toBe(branch.id);
    expect(circle?.[0]).toContain('cx="50"');
    expect(circle?.[0]).toContain('r="3"');
    // 後に描かれる線（branch）の <g> の後ろにある。
    expect(body.indexOf("data-line-junction")).toBeGreaterThan(
      body.indexOf(`data-projected-object-id="${branch.id}"`),
    );
  });
});
