import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { Point, PolylineObject, Screen } from "./project";
import cases from "../../../../examples/line-hop-cases.json";
import process from "../../../../examples/process.project.json";
import { parseProject } from "./project";
import { SegmentIndex, worldLines } from "./line-junction";
import {
  hopMinRadius,
  hopPath,
  hopRadius,
  hopSide,
  lineHopSpans,
  screenHopPaths,
} from "./line-hop";
import { objectToWorld } from "./rotation";
import ScreenPainting from "./ScreenPainting.svelte";
import ScreenView from "./ScreenView.svelte";

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
const spans = (...objects: PolylineObject[]) => {
  const lines = worldLines(objects);
  return new Map(
    [...lineHopSpans(lines)].map(([line, list]) => [lines[line].id, list]),
  );
};
/** パスの弧（A）を、ローカル座標の始点・終点・頂点にする。 */
function arcs(d: string) {
  const tokens = d.split(" ");
  const result: { start: Point; end: Point; apex: Point; radius: number }[] =
    [];
  let current: Point = { x: 0, y: 0 };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i];
    if (command === "M" || command === "L") {
      current = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) };
      i += 3;
    } else if (command === "A") {
      const radius = Number(tokens[i + 1]),
        sweep = Number(tokens[i + 5]),
        end = { x: Number(tokens[i + 6]), y: Number(tokens[i + 7]) };
      const middle = {
          x: (current.x + end.x) / 2,
          y: (current.y + end.y) / 2,
        },
        half = { x: (end.y - current.y) / 2, y: -(end.x - current.x) / 2 };
      const sign = sweep === 1 ? 1 : -1;
      result.push({
        start: current,
        end,
        radius,
        apex: { x: middle.x + sign * half.x, y: middle.y + sign * half.y },
      });
      current = end;
      i += 8;
    } else throw new Error(`unexpected ${command}`);
  }
  return result;
}

describe("lineHopSpans", () => {
  it("hops the later pipe over a true crossing", () => {
    const first = pipe([
        [0, 50],
        [100, 50],
      ]),
      second = pipe([
        [50, 0],
        [50, 100],
      ]);
    const result = spans(first, second);
    expect(result.has(first.id)).toBe(false);
    const radius = hopRadius(2, 2);
    expect(result.get(second.id)).toEqual([
      { segment: 0, from: 50 - radius, to: 50 + radius },
    ]);
  });

  it("uses the order, not the array position", () => {
    const later = pipe(
        [
          [0, 50],
          [100, 50],
        ],
        { order: 99 },
      ),
      earlier = pipe(
        [
          [50, 0],
          [50, 100],
        ],
        { order: 1 },
      );
    const result = spans(later, earlier);
    expect([...result.keys()]).toEqual([later.id]);
  });

  it("ignores ends, T junctions, corners, parallel and overlapping pipes", () => {
    const main = pipe([
      [0, 50],
      [100, 50],
    ]);
    // T 字（端が途中に乗る）、曲がり角が線上、平行、重なり、端点同士。
    const t = pipe([
      [30, 50],
      [30, 0],
    ]);
    const corner = pipe([
      [60, 0],
      [60, 50],
      [70, 0],
    ]);
    const parallel = pipe([
      [0, 60],
      [100, 60],
    ]);
    const overlap = pipe([
      [10, 50],
      [90, 50],
    ]);
    const touch = pipe([
      [100, 50],
      [100, 0],
    ]);
    expect(spans(main, t, corner, parallel, overlap, touch).size).toBe(0);
  });

  it("skips a crossing covered by a junction dot", () => {
    const first = pipe([
        [0, 50],
        [100, 50],
      ]),
      second = pipe([
        [50, 0],
        [50, 100],
      ]),
      // 3 本目の端が交差点に乗る（分岐の点が描かれる）。
      branch = pipe([
        [50, 50],
        [90, 90],
      ]);
    expect(spans(first, second, branch).size).toBe(0);
  });

  it("does not hop a pipe over itself", () => {
    const self = pipe([
      [0, 50],
      [100, 50],
      [50, 0],
      [50, 100],
    ]);
    expect(spans(self).size).toBe(0);
  });

  it("scales the radius with the wider stroke and keeps a minimum", () => {
    expect(hopRadius(1, 1)).toBe(hopMinRadius);
    expect(hopRadius(2, 6)).toBe(12);
    const thick = pipe(
        [
          [0, 50],
          [100, 50],
        ],
        {},
        6,
      ),
      thin = pipe([
        [50, 0],
        [50, 100],
      ]);
    expect(spans(thick, thin).get(thin.id)).toEqual([
      { segment: 0, from: 38, to: 62 },
    ]);
  });

  it("shrinks near a segment end and skips when too short", () => {
    const crossing = (y: number) =>
      pipe([
        [0, y],
        [100, y],
      ]);
    const near = pipe(
      [
        [50, 0],
        [50, 100],
      ],
      { order: 10000 },
    );
    // 端から 3 の所の交差は半径 3 に縮める。
    expect(spans(crossing(3), near).get(near.id)).toEqual([
      { segment: 0, from: 0, to: 6 },
    ]);
    // 端から 1 の所では縮めても最小の半分未満なので、またがない。
    expect(spans(crossing(1), near).size).toBe(0);
  });

  it("merges hops that would overlap into one semicircle", () => {
    const hopper = pipe([
      [0, 0],
      [100, 0],
    ]);
    hopper.order = 10000;
    const a = pipe([
        [40, -20],
        [40, 20],
      ]),
      b = pipe([
        [46, -20],
        [46, 20],
      ]),
      far = pipe([
        [80, -20],
        [80, 20],
      ]);
    expect(spans(a, b, far, hopper).get(hopper.id)).toEqual([
      { segment: 0, from: 36, to: 50 },
      { segment: 0, from: 76, to: 84 },
    ]);
  });

  it("stops a hop before a nearby junction dot on the hopper", () => {
    // 太い縦の配管を細い横の配管がまたぐ（半径 12）。横の配管の x=58 に枝の T 字（点の半径 3）。
    // またぎが点の下の直線を消さないよう、半径を |58-50| - (3 + 0.5) = 4.5 に縮める。
    const crossed = pipe(
        [
          [50, 0],
          [50, 100],
        ],
        {},
        6,
      ),
      hopper = pipe([
        [0, 50],
        [100, 50],
      ]),
      branch = pipe([
        [58, 50],
        [58, 90],
      ]);
    const [span, ...rest] = spans(crossed, hopper, branch).get(hopper.id)!;
    expect(rest).toEqual([]);
    expect(span.segment).toBe(0);
    expect(span.from).toBeCloseTo(45.5, 9);
    expect(span.to).toBeCloseTo(54.5, 9);
  });

  it("skips a hop squeezed too small by a junction dot", () => {
    const crossed = pipe([
        [50, 0],
        [50, 100],
      ]),
      hopper = pipe([
        [0, 50],
        [100, 50],
      ]),
      branch = pipe([
        [54, 50],
        [54, 90],
      ]);
    // 点の半径 3＋許容値 0.5 で、残りは 0.5。最小の半分（2）未満なのでまたがない。
    expect(spans(crossed, hopper, branch).get(hopper.id)).toBeUndefined();
  });

  it("indexes each hop by its segment", () => {
    const hopper = pipe(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      { order: 10000 },
    );
    const cross = pipe([
      [50, 50],
      [150, 50],
    ]);
    expect(spans(cross, hopper).get(hopper.id)).toEqual([
      { segment: 1, from: 46, to: 54 },
    ]);
  });

  it("checks only nearby segments with 1000 pipes, not every pair", () => {
    // 500 個の十字（横と縦の短い配管）を並べる。交差は 500。
    const objects: PolylineObject[] = [];
    for (let i = 0; i < 500; i++) {
      const x = (i % 25) * 120,
        y = Math.floor(i / 25) * 120;
      objects.push(
        pipe([
          [x, y + 50],
          [x + 100, y + 50],
        ]),
        pipe([
          [x + 50, y],
          [x + 50, y + 100],
        ]),
      );
    }
    expect(screenHopPaths(objects, true).size).toBe(500);
    // 時間ではなく、線分ごとに調べる候補の線分の数で全組合せでないことを確かめる（CI の負荷に左右されない）。
    const index = new SegmentIndex(worldLines(objects));
    const candidates = index.segments.map(
      (segment) => index.alongSegment(segment.a, segment.b).length,
    );
    expect(Math.max(...candidates)).toBeLessThanOrEqual(10);
    expect(candidates.reduce((sum, n) => sum + n, 0)).toBeLessThan(
      objects.length * 10,
    );
  });
});

describe("hopSide", () => {
  it("bulges up, or right for vertical segments, whatever the direction", () => {
    const side = (a: Point, b: Point) => {
      const n = hopSide(a, b);
      return [n.x + 0, n.y + 0];
    };
    expect(side({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual([0, -1]);
    expect(side({ x: 10, y: 0 }, { x: 0, y: 0 })).toEqual([0, -1]);
    expect(side({ x: 0, y: 0 }, { x: 0, y: 10 })).toEqual([1, 0]);
    expect(side({ x: 0, y: 10 }, { x: 0, y: 0 })).toEqual([1, 0]);
    const diagonal = hopSide({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(diagonal.y).toBeLessThan(0);
    expect(diagonal.x).toBeGreaterThan(0);
  });
});

describe("hopPath", () => {
  const crossingPair = (extra: Partial<PolylineObject>) => {
    const first = pipe([
      [0, 50],
      [100, 50],
    ]);
    const hopper = pipe(
      [
        [0, 0],
        [100, 0],
      ],
      { x: 0, y: 50, order: 10000, ...extra },
    );
    // hopper は回転・反転の中心（50, 0）で world の (50, 50) を通る垂直・水平の線。
    const second = pipe([
      [50, 0],
      [50, 100],
    ]);
    return { first, hopper, second };
  };

  it("draws straight runs and a semicircle in local coordinates", () => {
    const { first, second, hopper } = crossingPair({});
    const paths = screenHopPaths([first, second, hopper], true);
    expect(paths.get(hopper.id)).toBe("M 0 0 L 46 0 A 4 4 0 0 1 54 0 L 100 0");
    const [arc] = arcs(paths.get(hopper.id)!);
    expect(arc.apex).toEqual({ x: 50, y: -4 });
  });

  for (const [label, extra, expected] of [
    ["rotated 90", { rotation: 90 }, "right"],
    ["rotated 180", { rotation: 180 }, "up"],
    ["flipped vertically", { flipY: true }, "up"],
    ["flipped horizontally", { flipX: true }, "up"],
    ["rotated 90 and flipped", { rotation: 90, flipX: true }, "right"],
  ] as const)
    it(`keeps the world bulge direction when ${label}`, () => {
      const { first, second, hopper } = crossingPair(
        extra as Partial<PolylineObject>,
      );
      const paths = screenHopPaths([first, second, hopper], true);
      const d = paths.get(hopper.id);
      expect(d).toBeDefined();
      const [arc] = arcs(d!);
      const middle = objectToWorld(hopper, {
        x: (arc.start.x + arc.end.x) / 2,
        y: (arc.start.y + arc.end.y) / 2,
      });
      const apex = objectToWorld(hopper, arc.apex);
      if (expected === "up") {
        expect(apex.y).toBeCloseTo(middle.y - arc.radius);
        expect(apex.x).toBeCloseTo(middle.x);
      } else {
        expect(apex.x).toBeCloseTo(middle.x + arc.radius);
        expect(apex.y).toBeCloseTo(middle.y);
      }
    });

  it("returns nothing when the screen setting is off", () => {
    const { second, hopper } = crossingPair({});
    expect(screenHopPaths([second, hopper], false).size).toBe(0);
  });

  it("ignores hidden pipes", () => {
    const { second, hopper } = crossingPair({});
    second.visible = false;
    expect(screenHopPaths([second, hopper], true).size).toBe(0);
  });

  it("returns the original vertices when there is no span", () => {
    const line = pipe([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(hopPath(line, [])).toBe("M 0 0 L 10 0 L 10 10");
  });
});

describe("painting", () => {
  const screenWith = (lineHops: boolean) => {
    const first = pipe([
        [0, 50],
        [100, 50],
      ]),
      second = pipe([
        [50, 0],
        [50, 100],
      ]);
    second.shape.arrow = "end";
    second.shape.lineStyle = "dashed";
    return {
      second,
      screen: {
        id: "s",
        name: "s",
        width: 200,
        height: 200,
        background: "#ffffff",
        folders: [],
        groups: [],
        objects: [first, second],
        ...(lineHops ? { lineHops: true } : {}),
      } as unknown as Screen,
    };
  };

  it("replaces the polyline with a hop path in the screen painting", () => {
    const { screen, second } = screenWith(true);
    const { body } = render(ScreenPainting, {
      props: { screen, screens: [screen], symbols: [] },
    });
    const path = body.match(/<path[^>]*data-line-hop="([^"]+)"[^>]*>/);
    expect(path?.[1]).toBe(second.id);
    expect(path?.[0]).toContain("stroke-dasharray");
    // 矢印は保存の points のまま。
    expect(body).toContain("<polygon");
    const off = render(ScreenPainting, {
      props: {
        screen: screenWith(false).screen,
        screens: [screen],
        symbols: [],
      },
    });
    expect(off.body).not.toContain("data-line-hop");
  });

  it("draws the same hops in an embedded screen", () => {
    const { screen, second } = screenWith(true);
    const { body } = render(ScreenView, {
      props: { source: screen, width: 200, height: 200, symbols: [] },
    });
    expect(body).toContain(`data-line-hop="${second.id}"`);
  });
});

describe("lineHops contract shared with Rust", () => {
  for (const entry of cases.cases)
    it(entry.name, () => {
      const project: any = structuredClone(process);
      Object.assign(project[entry.owner][0], entry.set);
      const parse = () => parseProject(JSON.stringify(project));
      if (entry.valid) expect(parse).not.toThrow();
      else expect(parse).toThrow();
    });
});
