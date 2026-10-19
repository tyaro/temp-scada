import { expect, it } from "vitest";
import {
  screenReferences,
  MAX_SCREEN_VIEWS,
  MAX_EXPANDED_PLACEMENTS,
} from "./screen-references";
const screens = [
    { id: "A", baseCost: 3 },
    { id: "B", baseCost: 10 },
    { id: "C", baseCost: 2 },
  ],
  ref = (
    screenId: string,
    targetScreenId: string,
    objectId = `${screenId}-${targetScreenId}`,
  ) => ({ screenId, targetScreenId, objectId });
it("keeps shared source references and counts every view wrapper and repeated target", () => {
  const references = [
      ref("A", "B", "view1"),
      ref("A", "B", "view2"),
      ref("C", "B", "view3"),
    ],
    before = JSON.stringify({ screens, references });
  const graph = screenReferences(screens, references);
  expect(graph.byTarget.get("B")?.map((row) => row.objectId)).toEqual([
    "view1",
    "view2",
    "view3",
  ]);
  expect(graph.expandedCosts.get("A")).toBe(25);
  expect(graph.expandedCosts.get("C")).toBe(13);
  expect(graph.expandedCosts.get("B")).toBe(10);
  expect(JSON.stringify({ screens, references })).toBe(before);
});
it("rejects missing owners and targets, self references, duplicate IDs, cycles and global depth changes", () => {
  for (const references of [
    [ref("A", "missing")],
    [ref("missing", "B")],
    [ref("A", "A")],
    [ref("A", "B", "same"), ref("C", "B", "same")],
    [ref("A", "B"), ref("B", "A")],
    [ref("A", "B"), ref("B", "C")],
    [ref("B", "C"), ref("A", "B")],
  ])
    expect(() => screenReferences(screens, references)).toThrow();
});
it("accepts the exact per-screen view count and rejects one more including repeated references", () => {
  const refs = Array.from({ length: MAX_SCREEN_VIEWS }, (_, i) =>
    ref("A", "B", String(i)),
  );
  expect(screenReferences(screens, refs).bySource.get("A")).toHaveLength(
    MAX_SCREEN_VIEWS,
  );
  expect(() =>
    screenReferences(screens, [...refs, ref("A", "B", "extra")]),
  ).toThrow(/32/);
});
it("bounds expanded placements rather than just view count; plain screens keep their existing contract", () => {
  const cost = [
    { id: "A", baseCost: 1 },
    { id: "B", baseCost: MAX_EXPANDED_PLACEMENTS - 2 },
  ];
  expect(screenReferences(cost, [ref("A", "B")]).expandedCosts.get("A")).toBe(
    MAX_EXPANDED_PLACEMENTS,
  );
  expect(() =>
    screenReferences([{ id: "A", baseCost: 2 }, cost[1]], [ref("A", "B")]),
  ).toThrow(/20,000/);
  expect(
    screenReferences(
      [{ id: "A", baseCost: MAX_EXPANDED_PLACEMENTS + 1 }],
      [],
    ).expandedCosts.get("A"),
  ).toBe(MAX_EXPANDED_PLACEMENTS + 1);
});
it("accepts an empty source screen but rejects duplicate screens and non-finite or fractional costs", () => {
  expect(
    screenReferences(
      [
        { id: "A", baseCost: 0 },
        { id: "B", baseCost: 0 },
      ],
      [ref("A", "B")],
    ).expandedCosts.get("A"),
  ).toBe(1);
  expect(() => screenReferences([screens[0], screens[0]], [])).toThrow(/重複/);
  for (const baseCost of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => screenReferences([{ id: "A", baseCost }], [])).toThrow(/不正/);
});
