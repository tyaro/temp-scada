import { expect, it } from "vitest";
import processSample from "../../../../examples/process.project.json";
import minimal from "../../../../examples/minimal.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { copyObjects, parseClipboard } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  parseProject,
  serializeProject,
  type Project,
  type LayerFolder,
} from "./project";
const fresh = () => parseProject(JSON.stringify(processSample));
const folderId = (n: number) =>
  `0199fc00-0000-7000-8000-${String(n + 1).padStart(12, "0")}`;
const folders = (): LayerFolder[] => [
  { id: folderId(0), name: "設備", order: 0 },
  { id: folderId(1), name: "ポンプ", order: 1, parentId: folderId(0) },
];
function withFolders() {
  const p = fresh();
  p.screens[0].folders = folders();
  p.screens[0].objects.forEach((object) => (object.folderId = folderId(1)));
  p.symbols[0].folders = folders().map((folder) => ({
    ...folder,
    id: folder.id.replace("fc00", "fc01"),
    ...(folder.parentId
      ? { parentId: folder.parentId.replace("fc00", "fc01") }
      : {}),
  }));
  p.symbols[0].objects.forEach(
    (object) => (object.folderId = p.symbols[0].folders[1].id),
  );
  return parseProject(serializeProject(p));
}
const screenCommand = (project: Project) => ({
  screenId: project.screens[0].id,
});

it("creates stable folder IDs and trimmed names without changing drawing data, and renames with Undo", () => {
  const original = fresh(),
    history = emptyHistory();
  const created = recordEdit(
    original,
    history,
    {
      type: "create-folder",
      ...screenCommand(original),
      name: "  タンク  ",
      parentId: null,
    },
    "edit",
  );
  const folder = created.project.screens[0].folders[0];
  expect(folder.name).toBe("タンク");
  expect(folder.id).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
  expect(created.project.screens[0].objects).toEqual(
    original.screens[0].objects,
  );
  expect(created.project.symbols).toEqual(original.symbols);
  expect(
    applyCommand(
      created.project,
      {
        type: "rename-folder",
        ...screenCommand(original),
        folderId: folder.id,
        name: " タンク ",
      },
      "edit",
    ),
  ).toBe(created.project);
  const renamed = recordEdit(
    created.project,
    created.history,
    {
      type: "rename-folder",
      ...screenCommand(original),
      folderId: folder.id,
      name: "原水設備",
    },
    "edit",
  );
  const undone = travelHistory(
    renamed.project,
    renamed.history,
    "undo",
    "edit",
  );
  expect(undone.project.screens[0].folders).toEqual([folder]);
  expect(
    travelHistory(undone.project, undone.history, "redo", "edit").project
      .screens[0].folders[0],
  ).toMatchObject({ id: folder.id, name: "原水設備" });
  expect(original).toEqual(fresh());
});
it("moves multiple placements together, preserves geometry and references, clears membership and treats same targets as no-ops", () => {
  const original = withFolders(),
    objects = original.screens[0].objects,
    ids = objects.map((o) => o.id),
    target = folderId(0);
  const command = {
    type: "set-folder" as const,
    ...screenCommand(original),
    objectIds: ids,
    folderId: target,
  };
  const moved = recordEdit(original, emptyHistory(), command, "edit");
  expect(moved.project.screens[0].objects).toEqual(
    objects.map((o) => ({ ...o, folderId: target })),
  );
  expect(moved.project.symbols).toEqual(original.symbols);
  expect(moved.history.past).toHaveLength(1);
  expect(applyCommand(moved.project, command, "edit")).toBe(moved.project);
  expect(
    travelHistory(moved.project, moved.history, "undo", "edit").project.screens,
  ).toEqual(original.screens);
  const cleared = applyCommand(
    moved.project,
    { ...command, folderId: null },
    "edit",
  );
  expect(cleared.screens[0].objects.every((o) => !("folderId" in o))).toBe(
    true,
  );
  expect(applyCommand(cleared, { ...command, folderId: null }, "edit")).toBe(
    cleared,
  );
});
it("rejects mixed locks atomically but permits explicit hidden membership and administrative folder changes", () => {
  const original = withFolders(),
    ids = original.screens[0].objects.slice(0, 2).map((o) => o.id);
  original.screens[0].objects[0].locked = true;
  original.screens[0].objects[1].visible = false;
  const before = serializeProject(original),
    command = {
      type: "set-folder" as const,
      ...screenCommand(original),
      objectIds: ids,
      folderId: folderId(0),
    };
  expect(() => applyCommand(original, command, "edit")).toThrow("ロック");
  expect(serializeProject(original)).toBe(before);
  const hidden = applyCommand(
    original,
    { ...command, objectIds: [ids[1]] },
    "edit",
  );
  expect(hidden.screens[0].objects[1]).toMatchObject({
    visible: false,
    folderId: folderId(0),
  });
  const renamed = applyCommand(
    original,
    {
      type: "rename-folder",
      ...screenCommand(original),
      folderId: folderId(1),
      name: "稼働設備",
    },
    "edit",
  );
  const reparented = applyCommand(
    renamed,
    {
      type: "move-folder",
      ...screenCommand(original),
      folderId: folderId(1),
      parentId: null,
    },
    "edit",
  );
  expect(reparented.screens[0].objects).toEqual(original.screens[0].objects);
  expect(reparented.screens[0].folders[1].parentId).toBeUndefined();
});
it("refuses nonempty deletion, then removes empty folders without deleting or reordering placements", () => {
  const original = withFolders(),
    base = screenCommand(original);
  for (const folderId of original.screens[0].folders.map((f) => f.id))
    expect(() =>
      applyCommand(
        original,
        { type: "remove-folder", ...base, folderId },
        "edit",
      ),
    ).toThrow("空のフォルダー");
  const cleared = applyCommand(
    original,
    {
      type: "set-folder",
      ...base,
      objectIds: original.screens[0].objects.map((o) => o.id),
      folderId: null,
    },
    "edit",
  );
  const removed = recordEdit(
    cleared,
    emptyHistory(),
    { type: "remove-folder", ...base, folderId: folderId(1) },
    "edit",
  );
  expect(removed.project.screens[0].folders).toHaveLength(1);
  expect(removed.project.screens[0].objects).toEqual(
    cleared.screens[0].objects,
  );
  expect(
    travelHistory(removed.project, removed.history, "undo", "edit").project
      .screens,
  ).toEqual(cleared.screens);
  expect(
    applyCommand(
      removed.project,
      { type: "remove-folder", ...base, folderId: folderId(0) },
      "edit",
    ).screens[0].folders,
  ).toEqual([]);
});
it("refuses cycles, cross-owner targets, stale or duplicate IDs, invalid names and preview commands atomically", () => {
  const original = withFolders(),
    base = screenCommand(original),
    ids = original.screens[0].objects.slice(0, 2).map((o) => o.id),
    foreign = original.symbols[0].folders[0].id;
  const commands: EditCommand[] = [
    {
      type: "move-folder",
      ...base,
      folderId: folderId(0),
      parentId: folderId(1),
    },
    {
      type: "move-folder",
      ...base,
      folderId: folderId(0),
      parentId: folderId(0),
    },
    { type: "move-folder", ...base, folderId: folderId(0), parentId: foreign },
    { type: "create-folder", ...base, name: "設備", parentId: foreign },
    { type: "rename-folder", ...base, folderId: foreign, name: "設備" },
    { type: "remove-folder", ...base, folderId: foreign },
    ...[[], [ids[0], ids[0]], [ids[0], folderId(9)]].map((objectIds) => ({
      type: "set-folder" as const,
      ...base,
      objectIds,
      folderId: folderId(0),
    })),
    { type: "set-folder", ...base, objectIds: ids, folderId: foreign },
    ...["", "   ", "改行\nあり", "あ".repeat(201)].map((name) => ({
      type: "rename-folder" as const,
      ...base,
      folderId: folderId(0),
      name,
    })),
  ];
  const before = serializeProject(original);
  for (const command of commands)
    expect(() => applyCommand(original, command, "edit")).toThrow();
  expect(() =>
    applyCommand(
      original,
      { type: "create-folder", ...base, name: "設備", parentId: null },
      "preview",
    ),
  ).toThrow("プレビュー");
  expect(serializeProject(original)).toBe(before);
  const rooted = applyCommand(
    original,
    { type: "move-folder", ...base, folderId: folderId(1), parentId: null },
    "edit",
  );
  expect(
    applyCommand(
      rooted,
      { type: "move-folder", ...base, folderId: folderId(1), parentId: null },
      "edit",
    ),
  ).toBe(rooted);
});
it("checks descendant depth and folder capacity at commit time", () => {
  const original = fresh(),
    owner = original.screens[0],
    base = screenCommand(original);
  owner.folders = Array.from({ length: 15 }, (_, index) => ({
    id: folderId(index),
    name: `階層 ${index + 1}`,
    order: index,
    ...(index ? { parentId: folderId(index - 1) } : {}),
  }));
  owner.folders.push(
    { id: folderId(15), name: "枝", order: 15 },
    { id: folderId(16), name: "子", order: 16, parentId: folderId(15) },
  );
  expect(() =>
    applyCommand(
      original,
      {
        type: "move-folder",
        ...base,
        folderId: folderId(15),
        parentId: folderId(14),
      },
      "edit",
    ),
  ).toThrow("16段");
  const atLimit = applyCommand(
    original,
    { type: "create-folder", ...base, name: "16段目", parentId: folderId(14) },
    "edit",
  );
  expect(() =>
    applyCommand(
      atLimit,
      {
        type: "create-folder",
        ...base,
        name: "17段目",
        parentId: atLimit.screens[0].folders.at(-1)!.id,
      },
      "edit",
    ),
  ).toThrow("16段");
  owner.folders = Array.from({ length: 256 }, (_, index) => ({
    id: folderId(index),
    name: "設備",
    order: index,
  }));
  expect(() =>
    applyCommand(
      original,
      { type: "create-folder", ...base, name: "追加", parentId: null },
      "edit",
    ),
  ).toThrow();
});
it("screen duplication remaps folders, parents and memberships while keeping original geometry and definitions", () => {
  const original = withFolders(),
    source = original.screens[0];
  const result = applyCommand(
      original,
      { type: "duplicate-screen", screenId: source.id },
      "edit",
    ),
    copy = result.screens.at(-1)!;
  expect(result.screens[0]).toEqual(source);
  expect(result.symbols).toEqual(original.symbols);
  expect(
    copy.folders.some((folder) =>
      source.folders.some((old) => old.id === folder.id),
    ),
  ).toBe(false);
  expect(copy.folders[1].parentId).toBe(copy.folders[0].id);
  expect(
    copy.objects.every((object) => object.folderId === copy.folders[1].id),
  ).toBe(true);
  copy.objects.forEach((object, index) =>
    expect({
      ...object,
      id: source.objects[index].id,
      folderId: source.objects[index].folderId,
    }).toEqual(source.objects[index]),
  );
  expect(parseProject(serializeProject(result))).toEqual(result);
});
it("definition duplication and independent-copy remap folder references and never mutate the original definition", () => {
  const original = withFolders(),
    source = original.symbols[0];
  const instance = original.screens[0].objects.find(
    (o) => o.shape.type === "symbol" && o.shape.symbolId === source.id,
  )!;
  for (const command of [
    { type: "duplicate-symbol", symbolId: source.id },
    {
      type: "make-symbol-unique",
      ...screenCommand(original),
      objectId: instance.id,
    },
  ] as EditCommand[]) {
    const result = applyCommand(original, command, "edit"),
      copy = result.symbols.at(-1)!;
    expect(result.symbols[0]).toEqual(source);
    expect(copy.folders[1].parentId).toBe(copy.folders[0].id);
    expect(
      copy.objects.every((object) => object.folderId === copy.folders[1].id),
    ).toBe(true);
    expect(
      copy.folders.some((folder) =>
        source.folders.some((old) => old.id === folder.id),
      ),
    ).toBe(false);
    expect(parseProject(serializeProject(result))).toEqual(result);
  }
});
it("clipboard strips placement membership, reuses live dependencies, remaps foreign dependencies and always pastes at root", () => {
  const original = withFolders(),
    instance = original.screens[0].objects.find(
      (o) => o.shape.type === "symbol",
    )!,
    before = serializeProject(original);
  const text = copyObjects(
      original,
      original.screens[0].id,
      [instance.id],
      "source",
    ),
    fragment = parseClipboard(text);
  expect(fragment.project.screens[0].folders).toEqual([]);
  expect(fragment.project.screens[0].objects[0].folderId).toBeUndefined();
  expect(fragment.project.symbols[0].folders).toEqual(
    original.symbols[0].folders,
  );
  expect(serializeProject(original)).toBe(before);
  const same = applyCommand(
    original,
    {
      type: "paste",
      ...screenCommand(original),
      text,
      origin: "source",
      center: { x: 100, y: 100 },
    },
    "edit",
  );
  expect(same.symbols).toEqual(original.symbols);
  expect(same.screens[0].objects.at(-1)!.folderId).toBeUndefined();
  const target = parseProject(JSON.stringify(minimal));
  // Valid hierarchical clipboard input from another producer still pastes top-level placements at root.
  fragment.project.screens[0].folders = folders();
  fragment.project.screens[0].objects[0].folderId = folderId(1);
  const other = applyCommand(
    target,
    {
      type: "paste",
      ...screenCommand(target),
      text: JSON.stringify(fragment),
      origin: "other",
      center: { x: 100, y: 100 },
    },
    "edit",
  );
  const copied = other.symbols[0];
  expect(other.screens[0].objects.at(-1)!.folderId).toBeUndefined();
  expect(copied.folders[1].parentId).toBe(copied.folders[0].id);
  expect(
    copied.objects.every((object) => object.folderId === copied.folders[1].id),
  ).toBe(true);
  expect(
    copied.folders.some((folder) =>
      original.symbols[0].folders.some((old) => old.id === folder.id),
    ),
  ).toBe(false);
  expect(parseProject(serializeProject(other))).toEqual(other);
});
