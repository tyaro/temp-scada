import { expect, it } from "vitest";
import sample from "../../../../../examples/minimal.project.json";
import { parseProject } from "../project";
import {
  commonFolderId,
  folderAncestors,
  folderDestinations,
  folderPath,
  layerTree,
} from "./layer-tree";
function fixture() {
  const owner = parseProject(JSON.stringify(sample)).screens[0];
  owner.folders = [
    { id: "a", name: "設備", order: 0 },
    { id: "b", name: "ポンプ", order: 1, parentId: "a" },
    { id: "c", name: "空", order: 2 },
    { id: "d", name: "ポンプ", order: 3, parentId: "a" },
  ];
  owner.objects[0].folderId = "b";
  owner.objects[1].folderId = "d";
  owner.objects[2].locked = true;
  owner.objects[0].visible = false;
  return owner;
}
const label = (object: { id: string }) => object.id;
it("keeps folder hierarchy separate from drawing order, including hidden and locked placements", () => {
  const owner = fixture();
  const tree = layerTree(owner, "", new Set(), label);
  expect(
    tree.rows.map((row) =>
      row.kind === "folder" ? row.folder.id : row.object.id,
    ),
  ).toEqual([
    "a",
    "b",
    owner.objects[0].id,
    "d",
    owner.objects[1].id,
    "c",
    owner.objects[2].id,
  ]);
  expect(tree.rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 2, 0, 0]);
  expect(owner.objects.map((object) => object.order)).toEqual([3, 4, 5]);
  const collapsed = layerTree(owner, "", new Set(["a"]), label);
  expect(collapsed.rows).toHaveLength(3);
  expect(collapsed.matchingObjects).toHaveLength(3);
});
it("search temporarily opens matching paths and restores disclosure without changing saved state", () => {
  const owner = fixture(),
    closed = new Set(["a", "b"]);
  const result = layerTree(owner, "ポンプ", closed, label);
  expect(result.matchingObjects).toHaveLength(2);
  expect(
    result.rows
      .filter((row) => row.kind === "folder")
      .map((row) => row.folder.id),
  ).toEqual(["a", "b", "d"]);
  expect(result.rows.every((row) => row.kind !== "folder" || row.open)).toBe(
    true,
  );
  expect([...closed]).toEqual(["a", "b"]);
  expect(layerTree(owner, "", closed, label).rows).toHaveLength(3);
  expect(layerTree(owner, "空", closed, label).rows).toEqual([
    { kind: "folder", folder: owner.folders[2], depth: 0, open: true },
  ]);
  expect(
    layerTree(owner, owner.objects[0].id, closed, label).rows,
  ).toHaveLength(3);
  expect(layerTree(owner, "設備", closed, label).matchingObjects).toHaveLength(
    2,
  );
});
it("identifies duplicate folder paths by order and excludes self, descendants, and excessive depth destinations", () => {
  const owner = fixture();
  expect(folderPath(owner.folders, "b")).toBe("設備 / ポンプ");
  expect(
    folderAncestors(owner.folders, "b").map((folder) => folder.id),
  ).toEqual(["a", "b"]);
  const targets = folderDestinations(owner.folders, "a");
  expect(targets.map((target) => target.id)).toEqual(["", "c"]);
  const duplicates = folderDestinations(owner.folders).filter((target) =>
    ["b", "d"].includes(target.id),
  );
  expect(duplicates[0].label).not.toBe(duplicates[1].label);
  const chain = Array.from({ length: 16 }, (_, i) => ({
    id: String(i),
    name: `階層${i}`,
    order: i,
    ...(i ? { parentId: String(i - 1) } : {}),
  }));
  expect(folderDestinations(chain, undefined, true).at(-1)?.disabled).toBe(
    true,
  );
  expect(folderDestinations(chain, undefined, true).at(-2)?.disabled).toBe(
    false,
  );
  expect(folderDestinations(chain).at(-1)?.disabled).toBe(false);
});

it("distinguishes common membership, explicit root, and mixed or missing destinations", () => {
  expect(commonFolderId([{ folderId: "a" }, { folderId: "a" }])).toBe("a");
  expect(commonFolderId([{}, {}])).toBe("");
  expect(commonFolderId([{ folderId: "a" }, {}])).toBeUndefined();
  expect(commonFolderId([])).toBeUndefined();
});
