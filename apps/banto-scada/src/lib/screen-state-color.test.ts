import { describe, expect, it } from "vitest";
import sample from "../../../../examples/state-color.project.json";
import { parseProject, serializeProject, type ScreenObject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import { renewOwnerIds } from "./editor/model-helpers";
import {
  resolveScreenStateColor,
  stateColorSources,
  stateColorUsages,
  UNRESOLVED_STATE_COLOR,
} from "./state-color";
import { stateColorCommand } from "./designer/forms/state-color";
import type { NumericReading } from "./tag-presentation";
import { screenJunctions } from "./line-junction";

const T = "0199f600-0000-7000-8000-000000000b01";
const R = "0199f600-0000-7000-8000-000000000b02";
const L = "0199f600-0000-7000-8000-000000000b03";
const OTHER = "0199f600-0000-7000-8000-000000000b04";
const display = {
  true: { text: "運転", color: "#16a34a" },
  false: { text: "停止", color: "#64748b" },
  unknownColor: "#d97706",
};
const text = (id: string, order: number, shape = {}): ScreenObject =>
  ({
    id,
    order,
    x: 40,
    y: 20,
    width: 120,
    height: 30,
    rotation: 0,
    fill: "#334155",
    shape: {
      type: "text",
      text: "P-1",
      style: { fontSize: 16, fontWeight: "bold", align: "left" },
      binding: { externalName: "Demo.Value" },
      boolDisplay: display,
      ...shape,
    },
  }) as ScreenObject;
const rect = (id: string, order: number, textId = T): ScreenObject =>
  ({
    id,
    order,
    x: 40,
    y: 80,
    width: 100,
    height: 40,
    rotation: 0,
    shape: {
      type: "rectangle",
      stateColor: { textId },
      paint: {
        fill: {
          enabled: true,
          paint: { type: "solid", color: "#abcdef", alpha: 1 },
        },
        stroke: { color: "#112233", width: 2, alpha: 1 },
      },
    },
  }) as ScreenObject;
const line = (id: string, order: number, textId = T): ScreenObject =>
  ({
    id,
    order,
    x: 0,
    y: 0,
    rotation: 0,
    fill: "#83bfcd",
    shape: {
      type: "polyline",
      points: [
        { x: 10, y: 200 },
        { x: 150, y: 200 },
      ],
      strokeWidth: 6,
      arrow: "none",
      stateColor: { textId },
    },
  }) as ScreenObject;
const fresh = () => {
  const project = parseProject(JSON.stringify(sample));
  project.screens[0].objects = [
    text(T, 0),
    rect(R, 1),
    line(L, 2),
    text(OTHER, 3, { boolDisplay: undefined }),
  ];
  return parseProject(serializeProject(project));
};
const good = (boolValue: boolean): NumericReading => ({
  state: "resolved",
  quality: "good",
  numericValue: null,
  boolValue,
  provenance: {
    catalogRevision: 1,
    runId: 1,
    collectionMode: "configured",
    valueSource: "real",
    sourceTimestampMs: 0,
  },
});
const update = (screenId: string, objectId: string, patch: any) => ({
  type: "update" as const,
  screenId,
  objectId,
  patch,
});

describe("screen state color", () => {
  it("paints the junction dot of a following pipe with its resolved color", () => {
    const pipe = line(L, 2);
    const branch = {
      ...line("0199f600-0000-7000-8000-000000000b05", 4),
      shape: {
        type: "polyline",
        points: [
          { x: 80, y: 120 },
          { x: 80, y: 200 },
        ],
        strokeWidth: 6,
        arrow: "none",
      },
    } as ScreenObject;
    const objects = [text(T, 0), branch, pipe];
    const dotColor = (reading?: NumericReading) =>
      [
        ...screenJunctions(
          objects,
          new Map(reading ? [["Demo.Value", reading]] : []),
        ).values(),
      ].flat()[0].color;
    expect(dotColor(good(true))).toBe("#16a34a");
    expect(dotColor(good(false))).toBe("#64748b");
    expect(dotColor()).toBe("#d97706");
  });
  it("lists only bound boolDisplay Texts as sources and counts followers", () => {
    const screen = fresh().screens[0];
    expect(stateColorSources(screen).map((o) => o.id)).toEqual([T]);
    expect(stateColorUsages(screen, T).map((o) => o.id)).toEqual([R, L]);
  });

  it("resolves like the source Text: known colors, unknownColor otherwise, unresolved when the source is invalid", () => {
    const { objects } = fresh().screens[0];
    const follower = objects[1];
    const color = (reading?: NumericReading) =>
      resolveScreenStateColor(
        follower,
        objects,
        new Map(reading ? [["Demo.Value", reading]] : []),
      );
    expect(color(good(true))).toBe("#16a34a");
    expect(color(good(false))).toBe("#64748b");
    expect(color()).toBe("#d97706");
    expect(
      color({ state: "resolved", quality: "bad", numericValue: null }),
    ).toBe("#d97706");
    expect(color({ state: "resolved", quality: "good", numericValue: 1 })).toBe(
      "#d97706",
    );
    expect(resolveScreenStateColor(objects[0], objects)).toBeUndefined();
    expect(resolveScreenStateColor(follower, [follower])).toBe(
      UNRESOLVED_STATE_COLOR,
    );
    expect(resolveScreenStateColor(follower, undefined)).toBe(
      UNRESOLVED_STATE_COLOR,
    );
  });

  it("refuses to drop the source atomically, then detaches with Undo", () => {
    const project = fresh(),
      screen = project.screens[0],
      before = serializeProject(project);
    for (const patch of [
      { boolDisplay: null },
      { binding: null },
      { binding: null, boolDisplay: null },
    ])
      expect(() =>
        applyCommand(project, update(screen.id, T, patch), "edit"),
      ).toThrow(/配色元/);
    expect(() =>
      applyCommand(
        project,
        { type: "remove", screenId: screen.id, objectId: T },
        "edit",
      ),
    ).toThrow(/配色元/);
    expect(() =>
      applyCommand(
        project,
        update(screen.id, R, {
          paint: {
            ...(screen.objects[1].shape as any).paint,
            fill: {
              enabled: false,
              paint: { type: "solid", color: "#abcdef", alpha: 1 },
            },
          },
        }),
        "edit",
      ),
    ).toThrow();
    expect(serializeProject(project)).toBe(before);
    const detached = recordEdit(
      project,
      emptyHistory(),
      update(screen.id, R, { stateColor: null }),
      "edit",
    );
    expect(detached.project.screens[0].objects[1].shape).not.toHaveProperty(
      "stateColor",
    );
    expect(
      travelHistory(detached.project, detached.history, "undo", "edit").project
        .screens,
    ).toEqual(project.screens);
    const removed = applyCommand(
      project,
      { type: "remove-many", screenId: screen.id, objectIds: [T, R, L] },
      "edit",
    );
    expect(removed.screens[0].objects).toHaveLength(1);
  });

  it("remaps references when the source and followers are duplicated together", () => {
    const project = fresh(),
      screen = project.screens[0];
    const duplicated = applyCommand(
      project,
      { type: "duplicate-many", screenId: screen.id, objectIds: [T, R, L] },
      "edit",
    );
    const added = duplicated.screens[0].objects.slice(screen.objects.length);
    const newSource = added.find((o) => o.shape.type === "text")!;
    expect(newSource.id).not.toBe(T);
    expect(
      added
        .filter((o) => "stateColor" in o.shape)
        .map((o) => (o.shape as any).stateColor.textId),
    ).toEqual([newSource.id, newSource.id]);
    const single = applyCommand(
      project,
      { type: "duplicate", screenId: screen.id, objectId: R },
      "edit",
    );
    expect(single.screens[0].objects.at(-1)!.shape).toMatchObject({
      stateColor: { textId: T },
    });
    const copy = renewOwnerIds(structuredClone(screen));
    const copiedSource = copy.objects.find((o) => o.shape.type === "text")!;
    expect(copiedSource.id).not.toBe(T);
    expect(stateColorUsages(copy, copiedSource.id)).toHaveLength(2);
  });

  it("copies a follower only together with its source and remaps on paste", () => {
    const project = fresh(),
      screen = project.screens[0];
    expect(() => copyObjects(project, screen.id, [R], "test")).toThrow(
      /配色元/,
    );
    expect(() => copyObjects(project, screen.id, [R, OTHER], "test")).toThrow(
      /配色元/,
    );
    const pasted = applyCommand(
      project,
      {
        type: "paste",
        screenId: screen.id,
        text: copyObjects(project, screen.id, [T, R, L], "test"),
        origin: "test",
        center: { x: 300, y: 300 },
      },
      "edit",
    );
    const added = pasted.screens[0].objects.slice(screen.objects.length);
    const newSource = added.find((o) => o.shape.type === "text")!;
    expect(newSource.id).not.toBe(T);
    expect(
      added
        .filter((o) => "stateColor" in o.shape)
        .map((o) => (o.shape as any).stateColor.textId),
    ).toEqual([newSource.id, newSource.id]);
  });

  it("guards the form target and sources", () => {
    const project = fresh(),
      owner = project.screens[0],
      data = new FormData();
    data.set("stateColorTextId", T);
    const base = {
      generation: 3,
      screenId: owner.id,
      definition: false,
      selected: owner.objects[1],
      owner,
    };
    const input = { data, targetKey: `3:${owner.id}:false`, objectId: R };
    expect(stateColorCommand(input, base)).toMatchObject({
      patch: { stateColor: { textId: T } },
    });
    expect(() =>
      stateColorCommand(input, { ...base, definition: true }),
    ).toThrow();
    expect(() =>
      stateColorCommand(input, { ...base, generation: 4 }),
    ).toThrow();
    data.set("stateColorTextId", OTHER);
    expect(() => stateColorCommand(input, base)).toThrow();
    data.set("stateColorTextId", R);
    expect(() => stateColorCommand(input, base)).toThrow();
    data.set("stateColorTextId", "");
    expect(stateColorCommand(input, base)).toMatchObject({
      patch: { stateColor: null },
    });
  });
});
