import { describe, expect, it } from "vitest";
import cases from "../../../../examples/flip-cases.json";
import shapePaint from "../../../../examples/shape-paint.project.json";
import process from "../../../../examples/process.project.json";
import symbolImage from "../../../../examples/symbol-image.project.json";
import trend from "../../../../examples/trend.project.json";
import connection from "../../../../examples/connection.project.json";
import {
  getBounds,
  parseProject,
  type PolylineObject,
  type ScreenObject,
} from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  objectToWorld,
  objectTransform,
  readableChild,
  replaceRotatedVertex,
  resizeRotated,
  rotatedResizeCursor,
  rotationTransform,
  worldToObject,
} from "./rotation";
import { symbolAnchorPoint } from "./connection-geometry";

const samples: Record<string, unknown> = {
  "shape-paint": shapePaint,
  process,
  "symbol-image": symbolImage,
  trend,
};

describe("flip contract shared with Rust", () => {
  for (const entry of cases.placements)
    it(entry.name, () => {
      const project: any = structuredClone(samples[entry.sample]);
      const owners = project[entry.owner];
      if ("object" in entry) owners[0].objects.push(entry.object);
      else {
        const object = owners
          .flatMap((owner: any) => owner.objects)
          .find((o: any) => o.shape.type === entry.shape);
        Object.assign(object, entry.set);
      }
      const json = JSON.stringify(project);
      if (entry.valid) expect(parseProject(json)).toEqual(project);
      else expect(() => parseProject(json)).toThrow();
    });
  for (const entry of cases.anchors)
    it(`anchor world: ${entry.name}`, () => {
      const object = {
        id: "0199f6aa-0000-7000-8000-000000000999",
        order: 0,
        ...cases.target,
        rotation: entry.rotation,
        ...("flipX" in entry ? { flipX: entry.flipX } : {}),
        ...("flipY" in entry ? { flipY: entry.flipY } : {}),
        fill: "#000000",
        shape: { type: "symbol", symbolId: "x", colorMode: "definition" },
      } as unknown as Parameters<typeof symbolAnchorPoint>[0];
      const world = symbolAnchorPoint(object, entry.anchor as "left");
      expect(world.x).toBeCloseTo(entry.world.x, 9);
      expect(world.y).toBeCloseTo(entry.world.y, 9);
    });
});

describe("mirror transform", () => {
  const box = { x: 10, y: 20, width: 40, height: 30, rotation: 0 };
  it("keeps the unflipped, unrotated output", () => {
    expect(rotationTransform(box)).toBeUndefined();
    expect(objectTransform(box)).toBe("translate(10 20)");
    expect(objectTransform({ ...box, rotation: 90 })).toBe(
      "translate(10 20) rotate(90 20 15)",
    );
  });
  it("mirrors around the pivot before rotating", () => {
    expect(objectTransform({ ...box, flipX: true })).toBe(
      "translate(10 20) matrix(-1 0 0 1 40 0)",
    );
    expect(rotationTransform({ ...box, rotation: 90, flipY: true })).toBe(
      "rotate(90 20 15) matrix(1 0 0 -1 0 30)",
    );
  });
  it("round-trips world and local points with any flip and angle", () => {
    for (const flip of [
      { flipX: true },
      { flipY: true },
      { flipX: true, flipY: true },
    ])
      for (const rotation of [0, 90, 37]) {
        const object = { ...box, ...flip, rotation };
        const point = { x: 3, y: 7 };
        const back = worldToObject(object, objectToWorld(object, point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    expect(objectToWorld({ ...box, flipX: true }, { x: 0, y: 0 })).toEqual({
      x: 50,
      y: 20,
    });
  });
  it("mirrors the resize cursor before rotating", () => {
    expect(rotatedResizeCursor("e", 0, { flipX: true })).toBe("w-resize");
    expect(rotatedResizeCursor("ne", 0, { flipY: true })).toBe("se-resize");
    expect(rotatedResizeCursor("e", 90, { flipX: true })).toBe("n-resize");
  });
  it("keeps the opposite world edge while resizing a flipped placement", () => {
    const object = { ...box, flipX: true };
    // The local east handle lies on the world west side.
    const result = resizeRotated(object, "e", { x: -10, y: 0 }, null);
    expect(result.width).toBeCloseTo(50, 9);
    const fixedBefore = objectToWorld(object, { x: 0, y: 15 });
    const fixedAfter = objectToWorld(
      { ...result, rotation: 0, flipX: true },
      { x: 0, y: 15 },
    );
    expect(fixedAfter.x).toBeCloseTo(fixedBefore.x, 9);
    expect(fixedAfter.y).toBeCloseTo(fixedBefore.y, 9);
  });
  it("keeps untouched vertices while moving one of a flipped line", () => {
    const line = {
      x: 5,
      y: 5,
      rotation: 30,
      flipY: true,
      shape: {
        points: [
          { x: 0, y: 0 },
          { x: 40, y: 10 },
          { x: 20, y: 30 },
        ],
      },
    };
    const next = replaceRotatedVertex(line, 2, { x: 60, y: 50 });
    for (const index of [0, 1]) {
      const before = objectToWorld(line, line.shape.points[index]);
      const after = objectToWorld(
        { ...line, ...next, shape: { points: next.points } },
        next.points[index],
      );
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });
  it("keeps Text readable inside a mirrored Symbol", () => {
    const text = { shape: { type: "text" } };
    expect(readableChild(text, { flipX: true })).toEqual({
      ...text,
      flipX: true,
      flipY: false,
    });
    expect(readableChild(text, {})).toBe(text);
    const table = { shape: { type: "table" } };
    expect(readableChild(table, { flipY: true })).toEqual({
      ...table,
      flipX: false,
      flipY: true,
    });
    const rectangle = { shape: { type: "rectangle" } };
    expect(readableChild(rectangle, { flipX: true })).toBe(rectangle);
  });
});

describe("flip command", () => {
  const project = parseProject(JSON.stringify(shapePaint));
  const screen = project.screens[0];
  const rectangle = screen.objects.find((o) => o.shape.type === "rectangle")!;
  const ellipse = screen.objects.find((o) => o.shape.type === "ellipse")!;
  const text = screen.objects.find((o) => o.shape.type === "text")!;
  const find = (p: typeof project, id: string) =>
    p.screens[0].objects.find((o) => o.id === id)!;

  it("toggles the axis, negates the angle and keeps the placement", () => {
    const turned = applyCommand(
      project,
      {
        type: "update",
        screenId: screen.id,
        objectId: rectangle.id,
        patch: { rotation: 30 },
      },
      "edit",
    );
    const before = getBounds(find(turned, rectangle.id));
    const flipped = applyCommand(
      turned,
      {
        type: "flip",
        screenId: screen.id,
        objectIds: [rectangle.id],
        axis: "x",
      },
      "edit",
    );
    const object = find(flipped, rectangle.id);
    expect(object.flipX).toBe(true);
    expect(object.rotation).toBe(330);
    const after = getBounds(object);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBeCloseTo(
      before.y + before.height / 2,
    );
    const back = applyCommand(
      flipped,
      {
        type: "flip",
        screenId: screen.id,
        objectIds: [rectangle.id],
        axis: "x",
      },
      "edit",
    );
    expect(find(back, rectangle.id)).toEqual(find(turned, rectangle.id));
    expect("flipX" in find(back, rectangle.id)).toBe(false);
  });
  it("flips a multiple selection in one history entry and undoes it", () => {
    const command = {
      type: "flip" as const,
      screenId: screen.id,
      objectIds: [rectangle.id, ellipse.id],
      axis: "y" as const,
    };
    const { project: next, history } = recordEdit(
      project,
      emptyHistory(),
      command,
      "edit",
    );
    expect(history.past).toHaveLength(1);
    expect(find(next, rectangle.id).flipY).toBe(true);
    expect(find(next, ellipse.id).flipY).toBe(true);
    const undone = travelHistory(next, history, "undo", "edit").project;
    expect(undone.screens).toEqual(project.screens);
  });
  it("rejects Text, Trend and locked placements", () => {
    expect(() =>
      applyCommand(
        project,
        { type: "flip", screenId: screen.id, objectIds: [text.id], axis: "x" },
        "edit",
      ),
    ).toThrow(/反転できません/);
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: screen.id,
          objectId: text.id,
          patch: { flipY: true },
        },
        "edit",
      ),
    ).toThrow(/反転できません/);
    const trendProject = parseProject(JSON.stringify(trend));
    const trendObject = trendProject.screens[0].objects.find(
      (o) => o.shape.type === "trend",
    )!;
    expect(() =>
      applyCommand(
        trendProject,
        {
          type: "flip",
          screenId: trendProject.screens[0].id,
          objectIds: [trendObject.id],
          axis: "x",
        },
        "edit",
      ),
    ).toThrow(/反転できません/);
    const locked = applyCommand(
      project,
      {
        type: "set-lock",
        screenId: screen.id,
        objectId: rectangle.id,
        locked: true,
      },
      "edit",
    );
    expect(() =>
      applyCommand(
        locked,
        {
          type: "flip",
          screenId: screen.id,
          objectIds: [rectangle.id],
          axis: "x",
        },
        "edit",
      ),
    ).toThrow(/ロック/);
  });
  it("stores only true and removes the key when the inspector clears it", () => {
    const update = (p: typeof project, flipX: boolean) =>
      applyCommand(
        p,
        {
          type: "update",
          screenId: screen.id,
          objectId: rectangle.id,
          patch: { flipX },
        },
        "edit",
      );
    const on = update(project, true);
    expect(find(on, rectangle.id).flipX).toBe(true);
    expect(find(on, rectangle.id).rotation).toBe(rectangle.rotation);
    const off = update(on, false);
    expect("flipX" in find(off, rectangle.id)).toBe(false);
    expect(update(project, false)).toBe(project);
  });
  it("lets connected pipe endpoints follow a flipped Symbol", () => {
    const source = parseProject(JSON.stringify(connection));
    const owner = source.screens[0];
    const [target] = owner.objects;
    const next = applyCommand(
      source,
      { type: "flip", screenId: owner.id, objectIds: [target.id], axis: "x" },
      "edit",
    );
    const symbol = next.screens[0].objects[0] as ScreenObject & {
      width: number;
      height: number;
    };
    const pipe = next.screens[0].objects[2] as PolylineObject;
    const start = objectToWorld(pipe, pipe.shape.points[0]);
    const anchor = symbolAnchorPoint(symbol as never, "right");
    expect(start.x).toBeCloseTo(anchor.x, 9);
    expect(start.y).toBeCloseTo(anchor.y, 9);
    expect(anchor.x).toBeCloseTo(target.x, 9);
  });
});
