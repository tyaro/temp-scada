import { expect, it } from "vitest";
import type { LayoutObject, Point, PolylineObject } from "./project";
import { objectToWorld } from "./rotation";
import {
  CONNECTION_ANCHORS,
  CONNECTION_EPSILON,
  connectionAnchorPoint,
  polygonAnchorRatio,
  followPolylineEndpoints,
  sameConnectionPoint,
} from "./connection-geometry";
const symbol = (rotation = 0): LayoutObject => ({
  id: "symbol",
  order: 0,
  x: 100,
  y: 200,
  width: 80,
  height: 40,
  rotation,
  shape: { type: "symbol", symbolId: "definition", colorMode: "definition" },
});
const line = (rotation = 0): PolylineObject => ({
  id: "line",
  name: "配管",
  order: 1,
  x: -50,
  y: 30,
  rotation,
  opacity: 0.4,
  fill: "#123456",
  shape: {
    type: "polyline",
    points: [
      { x: -40, y: 25 },
      { x: 10, y: -20 },
      { x: 70, y: 15 },
      { x: 90, y: 60 },
    ],
    strokeWidth: 3,
    arrow: "end",
    lineStyle: "dashed",
  },
});
function near(actual: Point, expected: Point) {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
}
const world = (object: PolylineObject) =>
  object.shape.points.map((p) => objectToWorld(object, p));
it("uses frame edge midpoints and center, with exact cardinal rotation around the placement center", () => {
  expect(
    CONNECTION_ANCHORS.map((a) => connectionAnchorPoint(symbol(), a)),
  ).toEqual([
    { x: 140, y: 200 },
    { x: 180, y: 220 },
    { x: 140, y: 240 },
    { x: 100, y: 220 },
    { x: 140, y: 220 },
  ]);
  expect(
    CONNECTION_ANCHORS.map((a) => connectionAnchorPoint(symbol(90), a)),
  ).toEqual([
    { x: 160, y: 220 },
    { x: 140, y: 260 },
    { x: 120, y: 220 },
    { x: 140, y: 180 },
    { x: 140, y: 220 },
  ]);
});
it("tracks translation, non-square frame resize and general rotation independently of definition artwork", () => {
  const target = {
    ...symbol(33),
    x: -70,
    y: -40,
    width: 200,
    height: 30,
    locked: true,
    visible: false,
  };
  const before = structuredClone(target);
  near(connectionAnchorPoint(target, "right"), {
    x: 113.8670567945424,
    y: 29.46390350150271,
  });
  expect(connectionAnchorPoint(target, "center")).toEqual({ x: 30, y: -25 });
  expect(target).toEqual(before);
});
for (const rotation of [0, 90, 180, 270, 33, 359.99]) {
  it(`moves both endpoints simultaneously and keeps world-space intermediate vertices at ${rotation} degrees`, () => {
    const original = line(rotation),
      before = structuredClone(original),
      positions = world(original);
    const start = { x: 180, y: -160 },
      end = { x: -120, y: 250 };
    const result = followPolylineEndpoints(original, { start, end });
    const after = world(result);
    near(after[0], start);
    near(after.at(-1)!, end);
    near(after[1], positions[1]);
    near(after[2], positions[2]);
    expect(original).toEqual(before);
    expect({
      ...result,
      x: original.x,
      y: original.y,
      shape: original.shape,
    }).toEqual(original);
    expect(result.shape.strokeWidth).toBe(3);
    expect(result.shape.arrow).toBe("end");
    expect(result.shape.lineStyle).toBe("dashed");
    expect(followPolylineEndpoints(result, { start, end })).toBe(result);
  });
  it(`keeps a free endpoint and all bends fixed when only one end follows at ${rotation} degrees`, () => {
    for (const endpoint of ["start", "end"] as const) {
      const original = line(rotation),
        before = world(original),
        index = endpoint === "start" ? 0 : before.length - 1;
      const result = followPolylineEndpoints(original, {
        [endpoint]: { x: -240, y: 300 },
      });
      world(result).forEach((point, i) =>
        near(point, i === index ? { x: -240, y: 300 } : before[i]),
      );
    }
  });
}
it("does not double-translate endpoints when the line and its targets move together", () => {
  const original = line(47),
    positions = world(original),
    dx = 120,
    dy = -60;
  const translated = { ...original, x: original.x + dx, y: original.y + dy };
  const result = followPolylineEndpoints(translated, {
    start: { x: positions[0].x + dx, y: positions[0].y + dy },
    end: { x: positions.at(-1)!.x + dx, y: positions.at(-1)!.y + dy },
  });
  expect(result).toBe(translated);
});
it("preserves free vertices in the supplied transformed line before resolving connections", () => {
  const transformed = line(61),
    positions = world(transformed);
  const result = followPolylineEndpoints(transformed, {
    start: connectionAnchorPoint(symbol(15), "bottom"),
  });
  world(result)
    .slice(1)
    .forEach((p, i) => near(p, positions[i + 1]));
});
it("leaves unchanged input as the same object, including sub-tolerance floating point differences", () => {
  const original = line(33),
    positions = world(original);
  expect(followPolylineEndpoints(original, {})).toBe(original);
  expect(
    followPolylineEndpoints(original, {
      start: { x: positions[0].x + CONNECTION_EPSILON / 2, y: positions[0].y },
    }),
  ).toBe(original);
  expect(
    sameConnectionPoint({ x: 0, y: 0 }, { x: CONNECTION_EPSILON * 2, y: 0 }),
  ).toBe(false);
});
it("supports coincident connected ends when bends remain, and rejects an entirely collapsed line", () => {
  const original = line(33),
    point = { x: 200, y: -100 };
  const result = followPolylineEndpoints(original, {
    start: point,
    end: point,
  });
  near(world(result)[0], point);
  near(world(result).at(-1)!, point);
  const two = {
    ...original,
    shape: { ...original.shape, points: original.shape.points.slice(0, 2) },
  };
  expect(() =>
    followPolylineEndpoints(two, { start: point, end: point }),
  ).toThrow(/異なる2点/);
  expect(two.shape.points).toEqual(original.shape.points.slice(0, 2));
});
it("rejects invalid anchors, non-Symbol targets, nonfinite geometry and invalid point arrays without mutation", () => {
  expect(() => connectionAnchorPoint(symbol(), "unknown" as any)).toThrow();
  expect(() =>
    connectionAnchorPoint(
      { ...symbol(), shape: { type: "image", assetId: "a", fit: "contain" } },
      "left",
    ),
  ).toThrow(/Symbol/);
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(() =>
      connectionAnchorPoint({ ...symbol(), width: bad }, "right"),
    ).toThrow();
    expect(() =>
      followPolylineEndpoints(line(), { start: { x: bad, y: 0 } }),
    ).toThrow();
    expect(() =>
      followPolylineEndpoints({ ...line(), rotation: bad }, {}),
    ).toThrow();
    expect(() =>
      sameConnectionPoint({ x: bad, y: 0 }, { x: 0, y: 0 }),
    ).toThrow();
  }
  expect(() =>
    connectionAnchorPoint({ ...symbol(), height: 0 }, "center"),
  ).toThrow();
  for (const points of [
    [],
    [{ x: 0, y: 0 }],
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    [
      { x: NaN, y: 0 },
      { x: 0, y: 0 },
    ],
  ])
    expect(() =>
      followPolylineEndpoints(
        { ...line(), shape: { ...line().shape, points } },
        {},
      ),
    ).toThrow();
});

it("rejects finite large-coordinate updates when endpoint or bend preservation exceeds the absolute tolerance", () => {
  const original = { ...line(33), x: 1e12, y: 1e12 };
  const before = structuredClone(original);
  expect(() =>
    followPolylineEndpoints(original, {
      start: { x: 1e12 + 180, y: 1e12 - 160 },
      end: { x: 1e12 - 120, y: 1e12 + 250 },
    }),
  ).toThrow(/精度/);
  expect(original).toEqual(before);
});
it("keeps representable large-coordinate updates without imposing a new coordinate limit", () => {
  const original = { ...line(90), x: 1e12, y: 1e12 },
    before = world(original);
  const start = { x: 1e12 + 180, y: 1e12 - 160 },
    end = { x: 1e12 - 120, y: 1e12 + 250 };
  const after = world(followPolylineEndpoints(original, { start, end }));
  expect(after).toEqual([start, before[1], before[2], end]);
});

const paint = {
  fill: {
    enabled: true,
    paint: { type: "solid", color: "#83bfcd", alpha: 1 },
  },
  stroke: null,
} as const;
const area = (
  shape: LayoutObject["shape"],
  extra: Partial<LayoutObject> = {},
): LayoutObject =>
  ({ ...symbol(), id: "area", ...extra, shape }) as LayoutObject;
const polygon = (points: [number, number][], extra?: Partial<LayoutObject>) =>
  area(
    {
      type: "polygon",
      points: points.map(([x, y]) => ({ x, y })),
      paint,
    } as LayoutObject["shape"],
    extra,
  );
it("uses the frame edge midpoints and center for rectangles and ellipses, with rotation and flips", () => {
  const frame = CONNECTION_ANCHORS.map((a) =>
    connectionAnchorPoint(symbol(), a),
  );
  for (const type of ["rectangle", "ellipse"] as const) {
    const target = area({ type, paint } as LayoutObject["shape"]);
    expect(
      CONNECTION_ANCHORS.map((a) => connectionAnchorPoint(target, a)),
    ).toEqual(frame);
    expect(connectionAnchorPoint({ ...target, rotation: 90 }, "top")).toEqual({
      x: 160,
      y: 220,
    });
    near(connectionAnchorPoint({ ...target, flipX: true }, "left"), {
      x: 180,
      y: 220,
    });
  }
});
it("matches hand values for polygons whose frame edge midpoints lie on the outline", () => {
  const frame = CONNECTION_ANCHORS.map((a) =>
    connectionAnchorPoint(symbol(), a),
  );
  const square = polygon([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  const diamond = polygon([
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ]);
  for (const target of [square, diamond])
    expect(
      CONNECTION_ANCHORS.map((a) => connectionAnchorPoint(target, a)),
    ).toEqual(frame);
  // center stays the frame center even when it lies outside a concave outline.
  const u = polygon([
    [0, 0],
    [0.25, 0],
    [0.25, 0.75],
    [0.75, 0.75],
    [0.75, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  expect(connectionAnchorPoint(u, "center")).toEqual({ x: 140, y: 220 });
});
it("intersects the polygon outline with the frame center lines in ratio space", () => {
  const cases: [
    [number, number][],
    "top" | "right" | "bottom" | "left",
    Point,
  ][] = [
    // centre line through a vertex (touching counts as an intersection)
    [
      [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      "bottom",
      { x: 0.5, y: 1 },
    ],
    // an edge lying on the centre line contributes both of its ends
    [
      [
        [0, 0],
        [1, 0],
        [1, 0.4],
        [0.5, 0.4],
        [0.5, 1],
        [0, 1],
      ],
      "bottom",
      { x: 0.5, y: 1 },
    ],
    // concave outline whose frame center lies outside: nearest to the top edge
    [
      [
        [0, 0],
        [0.25, 0],
        [0.25, 0.75],
        [0.75, 0.75],
        [0.75, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      "top",
      { x: 0.5, y: 0.75 },
    ],
    // self-intersecting bow tie: the crossing point
    [
      [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      "top",
      { x: 0.5, y: 0.5 },
    ],
  ];
  for (const [points, anchor, ratio] of cases) {
    expect(
      polygonAnchorRatio(
        points.map(([x, y]) => ({ x, y })),
        anchor,
      ),
    ).toEqual(ratio);
    expect(connectionAnchorPoint(polygon(points), anchor)).toEqual({
      x: 100 + ratio.x * 80,
      y: 200 + ratio.y * 40,
    });
  }
});
it("puts the regular pentagon's left anchor on the slanted edge at half height, not on the vertex", () => {
  const pentagon: [number, number][] = [
    [0.5, 0],
    [1, 0.381966],
    [0.809017, 1],
    [0.190983, 1],
    [0, 0.381966],
  ];
  const ratio = polygonAnchorRatio(
    pentagon.map(([x, y]) => ({ x, y })),
    "left",
  );
  const t = (0.5 - 1) / (0.381966 - 1);
  expect(ratio).toEqual({ x: 0.190983 + t * (0 - 0.190983), y: 0.5 });
  expect(ratio.x).toBeGreaterThan(0);
  expect(
    polygonAnchorRatio(
      pentagon.map(([x, y]) => ({ x, y })),
      "top",
    ),
  ).toEqual({ x: 0.5, y: 0 });
});
it("throws for polygons that break the outline preconditions and for non-area targets", () => {
  for (const points of [
    [
      [0, 0],
      [1, 1],
    ],
    [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 0],
      [0, 1],
    ],
  ] as [number, number][][])
    expect(() => connectionAnchorPoint(polygon(points), "left")).toThrow();
  expect(() =>
    connectionAnchorPoint(
      area({
        type: "text",
        text: "x",
        style: { fontSize: 16, fontWeight: "normal", align: "left" },
      } as LayoutObject["shape"]),
      "left",
    ),
  ).toThrow(/矩形・楕円・多角形/);
});
