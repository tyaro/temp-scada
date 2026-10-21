import { expect, it } from "vitest";
import cases from "../../../../examples/image-reference-cases.json";
import { imageAssetReferences } from "./asset-references";
import { referencedAssets, type Project, type ScreenObject } from "./project";
import { clipboardDependencies } from "./clipboard-dependencies";

// Deliberately projection-only owners; these are not importable Project fixtures.
for (const c of cases.cases)
  it(`projects image references: ${c.name}`, () => {
    const project = c.project as unknown as Project;
    const before = JSON.stringify(project);
    expect([...referencedAssets(project)].sort()).toEqual(
      [...c.expected].sort(),
    );
    expect(JSON.stringify(project)).toBe(before);
  });
it("retains every usage identity rather than collapsing shared originals", () => {
  const project = cases.cases[3].project as unknown as Project;
  expect(imageAssetReferences(project)).toEqual([
    { assetId: "background", owner: "screen", ownerId: "screen" },
    {
      assetId: "direct-original",
      owner: "screen",
      ownerId: "screen",
      objectId: "direct",
    },
    {
      assetId: "direct-original",
      owner: "symbol",
      ownerId: "definition",
      objectId: "image",
    },
    {
      assetId: "symbol-original",
      owner: "symbol",
      ownerId: "definition",
      objectId: "other",
    },
  ]);
});
const shape = (id: string, type: string, target: string) =>
  ({
    id,
    shape:
      type === "image"
        ? { type, assetId: target }
        : type === "symbol"
          ? { type, symbolId: target }
          : { type, screenId: target },
  }) as ScreenObject;
it("copies only reachable definitions and their originals, including an embedded source's background", () => {
  const selected = [
    shape("selected", "symbol", "used"),
    shape("view", "screenView", "source"),
    shape("repeated", "symbol", "used"),
  ];
  const project = {
    screens: [
      {
        id: "source",
        backgroundImage: { assetId: "bg" },
        objects: [shape("a", "symbol", "source-symbol")],
      },
    ],
    symbols: [
      { id: "used", objects: [shape("hidden", "image", "shared")] },
      {
        id: "source-symbol",
        objects: [
          shape("b", "image", "shared"),
          shape("c", "image", "another"),
        ],
      },
      { id: "unrelated", objects: [shape("d", "image", "unrelated-asset")] },
    ],
  } as unknown as Project;
  const before = JSON.stringify(project);
  const result = clipboardDependencies(project, selected);
  expect([...result.symbols]).toEqual(["used", "source-symbol"]);
  expect([...result.screens]).toEqual(["source"]);
  expect([...result.assets]).toEqual(["shared", "bg", "another"]);
  expect(JSON.stringify(project)).toBe(before);
  expect(clipboardDependencies(project, []).assets.size).toBe(0);
});
it("terminates repeated/cyclic prospective references but leaves structural validation to the Project validator", () => {
  const project = {
    screens: [],
    symbols: [
      {
        id: "cycle",
        objects: [
          shape("cycle-ref", "symbol", "cycle"),
          shape("image", "image", "original"),
        ],
      },
    ],
  } as unknown as Project;
  expect([
    ...clipboardDependencies(project, [shape("a", "symbol", "cycle")]).assets,
  ]).toEqual(["original"]);
});
it("rejects missing definition or embedded source instead of producing an incomplete dependency fragment", () => {
  const project = { screens: [], symbols: [] } as unknown as Project;
  expect(() =>
    clipboardDependencies(project, [shape("a", "symbol", "missing")]),
  ).toThrow(/Symbol/);
  expect(() =>
    clipboardDependencies(project, [shape("a", "screenView", "missing")]),
  ).toThrow(/埋込画面/);
});
