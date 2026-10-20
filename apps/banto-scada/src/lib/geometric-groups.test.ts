import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import cases from "../../../../examples/geometric-group-cases.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { projectContent } from "./save-state";
import {
  canvasSelectionIds,
  expandGroupSelection,
  selectionUnits,
  unitBounds,
} from "./geometric-groups";
import { copyObjects, parseClipboard } from "./clipboard";

const fresh = () => parseProject(JSON.stringify(sample));
const selection = (project = fresh()) => ({
  screenId: project.screens[0].id,
  objectIds: project.screens[0].objects.slice(0, 2).map((object) => object.id),
});
const grouped = () =>
  applyCommand(
    fresh(),
    { type: "group", ...selection(), name: "設備" },
    "edit",
  );
it.each(cases)("shares group contract with Rust: $name", (entry) => {
  const value: any = structuredClone(sample);
  value.screens[0].groups = entry.groups;
  if ("foldered" in entry) {
    value.screens[0].folders = [
      { id: "0199f200-0000-7000-8000-000000000001", name: "部分", order: 0 },
    ];
    value.screens[0].objects[0].folderId = value.screens[0].folders[0].id;
  }
  if (entry.valid) expect(parseProject(JSON.stringify(value))).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});
it("groups and ungroups without modifying placements; each is one undo step", () => {
  const original = fresh(),
    before = structuredClone(original.screens[0].objects);
  const state = recordEdit(
    original,
    emptyHistory(),
    { type: "group", ...selection(), name: " 設備 " },
    "edit",
  );
  expect(state.project.screens[0].objects).toEqual(before);
  expect(state.project.screens[0].groups[0].name).toBe("設備");
  expect(original.screens[0].groups).toEqual([]);
  expect(state.history.past).toHaveLength(1);
  const undone = travelHistory(state.project, state.history, "undo", "edit");
  expect(projectContent(undone.project)).toBe(projectContent(original));
  const next = applyCommand(
    state.project,
    {
      type: "ungroup",
      screenId: selection().screenId,
      groupId: state.project.screens[0].groups[0].id,
    },
    "edit",
  );
  expect(next.screens[0].objects).toEqual(before);
  expect(next.screens[0].groups).toEqual([]);
});
it("rejects partial edits, state changes and nested groups atomically", () => {
  const original = grouped(),
    before = structuredClone(original),
    history = emptyHistory(),
    scope = selection();
  for (const command of [
    {
      type: "update" as const,
      screenId: scope.screenId,
      objectId: scope.objectIds[0],
      patch: { x: 1 },
    },
    {
      type: "set-lock" as const,
      screenId: scope.screenId,
      objectId: scope.objectIds[0],
      locked: false,
    },
    { type: "remove-many" as const, ...scope, objectIds: [scope.objectIds[0]] },
    { type: "group" as const, ...scope },
    { type: "set-color" as const, ...scope, fill: "#ffffff" },
  ])
    expect(() => recordEdit(original, history, command, "edit")).toThrow();
  expect(original).toEqual(before);
  expect(history).toEqual(emptyHistory());
});
it("moves the whole group and preserves relative positions and shape data over four rotations", () => {
  let project = grouped();
  project.screens[0].objects[0].rotation = 37;
  project.screens[0].objects[1].rotation = 121;
  const before = structuredClone(project.screens[0].objects);
  project = applyCommand(
    project,
    { type: "move-many", ...selection(), dx: 10, dy: -5 },
    "edit",
  );
  expect(project.screens[0].objects[0].x).toBe(before[0].x + 10);
  for (let i = 0; i < 4; i++)
    project = applyCommand(
      project,
      { type: "rotate-groups", ...selection(), delta: 90 },
      "edit",
    );
  project.screens[0].objects.slice(0, 2).forEach((object, index) => {
    expect(object.x).toBeCloseTo(before[index].x + 10, 9);
    expect(object.y).toBeCloseTo(before[index].y - 5, 9);
    expect(object.shape).toEqual(before[index].shape);
    expect(object.rotation).toBe(before[index].rotation);
  });
});
it("duplicates memberships and deletes all members together", () => {
  const project = grouped(),
    copy = applyCommand(
      project,
      { type: "duplicate-many", ...selection() },
      "edit",
    );
  const groups = copy.screens[0].groups;
  expect(groups).toHaveLength(2);
  expect(groups[1].id).not.toBe(groups[0].id);
  expect(
    groups[1].memberIds.every((id) => !groups[0].memberIds.includes(id)),
  ).toBe(true);
  const removed = applyCommand(
    copy,
    {
      type: "remove-many",
      screenId: selection().screenId,
      objectIds: groups[1].memberIds,
    },
    "edit",
  );
  expect(removed.screens[0].groups).toEqual(project.screens[0].groups);
  expect(removed.screens[0].objects).toEqual(project.screens[0].objects);
});
it("remaps group membership on screen duplication", () => {
  const project = grouped(),
    copy = applyCommand(
      project,
      { type: "duplicate-screen", screenId: selection().screenId },
      "edit",
    );
  const screen = copy.screens[1];
  expect(screen.groups[0].id).not.toBe(project.screens[0].groups[0].id);
  expect(screen.groups[0].memberIds).toEqual(
    screen.objects.slice(0, 2).map((object) => object.id),
  );
});
it("treats groups as blocks when moving an independent placement through their order", () => {
  const project = grouped(),
    third = project.screens[0].objects[2];
  const next = applyCommand(
    project,
    {
      type: "reorder",
      screenId: selection().screenId,
      objectId: third.id,
      direction: "backward",
    },
    "edit",
  );
  expect(next.screens[0].objects.map((object) => object.id)).toEqual([
    third.id,
    ...selection().objectIds,
  ]);
});
it("supports whole-group unlock and refuses mutations while any member is locked", () => {
  const project = grouped(),
    groupId = project.screens[0].groups[0].id,
    screenId = selection().screenId;
  project.screens[0].objects[0].locked = true;
  expect(() =>
    applyCommand(project, { type: "ungroup", screenId, groupId }, "edit"),
  ).toThrow("ロック");
  expect(() =>
    applyCommand(
      project,
      { type: "move-many", ...selection(), dx: 1, dy: 1 },
      "edit",
    ),
  ).toThrow("ロック");
  const unlocked = applyCommand(
    project,
    { type: "set-group-state", screenId, groupId, locked: false },
    "edit",
  );
  expect(unlocked.screens[0].objects.every((object) => !object.locked)).toBe(
    true,
  );
});
it("expands selection and aligns groups without changing their internal spacing", () => {
  const project = grouped(),
    scope = selection(),
    ids = project.screens[0].objects.map((object) => object.id);
  expect(
    expandGroupSelection(project.screens[0], [scope.objectIds[0]]),
  ).toEqual(scope.objectIds);
  expect(selectionUnits(project.screens[0], ids)).toHaveLength(2);
  const before =
    project.screens[0].objects[1].x - project.screens[0].objects[0].x;
  const next = applyCommand(
    project,
    {
      type: "align",
      screenId: scope.screenId,
      objectIds: ids,
      alignment: "right",
    },
    "edit",
  );
  expect(next.screens[0].objects[1].x - next.screens[0].objects[0].x).toBe(
    before,
  );
  const units = selectionUnits(next.screens[0], ids).map(unitBounds);
  expect(units[0].x + units[0].width).toBe(units[1].x + units[1].width);
});
it("copies group metadata with an explicit v3 envelope and remaps all IDs on paste", () => {
  const project = grouped(),
    scope = selection(),
    text = copyObjects(project, scope.screenId, scope.objectIds, "test");
  const payload = parseClipboard(text);
  expect(payload.version).toBe(3);
  expect(payload.images).toEqual([]);
  expect(payload.project.screens[0].groups).toEqual(project.screens[0].groups);
  const next = applyCommand(
    project,
    {
      type: "paste",
      screenId: scope.screenId,
      text,
      origin: "test",
      center: { x: 400, y: 300 },
    },
    "edit",
  );
  expect(next.screens[0].groups).toHaveLength(2);
  expect(next.screens[0].groups[1].id).not.toBe(next.screens[0].groups[0].id);
  expect(next.screens[0].groups[1].memberIds).toEqual(
    next.screens[0].objects.slice(-2).map((object) => object.id),
  );
  expect(() =>
    copyObjects(project, scope.screenId, [scope.objectIds[0]], "test"),
  ).toThrow("グループ全体");
  const malformed = JSON.parse(text);
  malformed.version = 1;
  delete malformed.images;
  expect(() => parseClipboard(JSON.stringify(malformed))).toThrow("v3");
});
it("renames a group without changing children and preserves identity on no-op", () => {
  const project = grouped(),
    command = {
      type: "rename-group" as const,
      screenId: selection().screenId,
      groupId: project.screens[0].groups[0].id,
      name: "設備",
    };
  expect(applyCommand(project, command, "edit")).toBe(project);
  const next = applyCommand(project, { ...command, name: "ポンプ" }, "edit");
  expect(next.screens[0].objects).toEqual(project.screens[0].objects);
  expect(next.screens[0].groups[0].name).toBe("ポンプ");
});
it("copies reactive Proxy memberships through the JSON snapshot boundary", () => {
  const project = grouped(),
    scope = selection();
  const group = project.screens[0].groups[0];
  group.memberIds = new Proxy(group.memberIds, {});
  project.screens[0].groups[0] = new Proxy(group, {});
  const copied = parseClipboard(
    copyObjects(project, scope.screenId, scope.objectIds, "test"),
  );
  expect(copied.project.screens[0].groups).toEqual([group]);
});
it("keeps explicit default flags on effective no-op group state changes", () => {
  const project = grouped(),
    screenId = selection().screenId;
  project.screens[0].objects[0].locked = false;
  project.screens[0].objects[0].visible = true;
  const command = {
    type: "set-group-state" as const,
    screenId,
    groupId: project.screens[0].groups[0].id,
    locked: false,
    visible: true,
  };
  const state = recordEdit(project, emptyHistory(), command, "edit");
  expect(state.project).toBe(project);
  expect(state.history.past).toEqual([]);
  project.screens[0].objects[1].locked = true;
  const unlocked = applyCommand(project, command, "edit");
  expect(unlocked.screens[0].objects[0].locked).toBe(false);
  expect(unlocked.screens[0].objects[0].visible).toBe(true);
  expect(unlocked.screens[0].objects[1].locked).toBeUndefined();
});
it("uses schema Unicode code point limits for group names", () => {
  const project = grouped(),
    groupId = project.screens[0].groups[0].id,
    screenId = selection().screenId;
  const next = applyCommand(
    project,
    { type: "rename-group", screenId, groupId, name: "🙂".repeat(200) },
    "edit",
  );
  expect(next.screens[0].groups[0].name).toBe("🙂".repeat(200));
  expect(
    applyCommand(
      next,
      { type: "rename-group", screenId, groupId, name: "🙂".repeat(200) },
      "edit",
    ),
  ).toBe(next);
  expect(() =>
    applyCommand(
      project,
      { type: "rename-group", screenId, groupId, name: "🙂".repeat(201) },
      "edit",
    ),
  ).toThrow();
});
it("selects complete unlocked visible units on canvas and excludes partial or mixed units", () => {
  const project = grouped(),
    screen = project.screens[0],
    ids = screen.objects.map((object) => object.id);
  expect(canvasSelectionIds(screen, [ids[0]])).toEqual([]);
  expect(canvasSelectionIds(screen, ids)).toEqual(ids);
  screen.objects[1].locked = true;
  expect(canvasSelectionIds(screen, ids)).toEqual([ids[2]]);
  delete screen.objects[1].locked;
  screen.objects[1].visible = false;
  expect(canvasSelectionIds(screen, ids)).toEqual([ids[2]]);
});
it("round-trips rotation of Text, Polyline, cropped Image and shared Symbol without changing shape data", () => {
  let project = fresh();
  const screenId = project.screens[0].id;
  project = applyCommand(
    project,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "add", screenId, kind: "line" },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "add-image",
      screenId,
      asset: {
        id: "0199f400-0000-7000-8000-000000000001",
        sha256: "0".repeat(64),
        mime: "image/png",
        byteLength: 100,
        width: 400,
        height: 200,
        name: "crop.png",
      },
      frame: { x: 100, y: 300, width: 120, height: 70 },
    },
    "edit",
  );
  const image = project.screens[0].objects.at(-1)!;
  if (image.shape.type !== "image") throw new Error("fixture");
  image.shape.crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  project.screens[0].objects.forEach(
    (object, index) => (object.rotation = 17 + index * 31),
  );
  const ids = project.screens[0].objects.map((object) => object.id);
  project = applyCommand(
    project,
    { type: "group", screenId, objectIds: ids },
    "edit",
  );
  const before = structuredClone(project);
  for (let index = 0; index < 4; index++)
    project = applyCommand(
      project,
      { type: "rotate-groups", screenId, objectIds: ids, delta: 90 },
      "edit",
    );
  project.screens[0].objects.forEach((object, index) => {
    expect(object.x).toBeCloseTo(before.screens[0].objects[index].x, 9);
    expect(object.y).toBeCloseTo(before.screens[0].objects[index].y, 9);
    expect(object.shape).toEqual(before.screens[0].objects[index].shape);
    expect(object.rotation).toBe(before.screens[0].objects[index].rotation);
  });
  expect(project.assets).toEqual(before.assets);
  expect(project.symbols).toEqual(before.symbols);
});
