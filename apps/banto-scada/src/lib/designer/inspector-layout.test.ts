import { expect, it } from "vitest";
import {
  parseInspectorPlacement,
  visibleInspectorRect,
  supportsFloatingInspector,
  initialInspectorPlacement,
  adjustedInspectorRect,
  type InspectorPlacement,
} from "./inspector-layout";
const area = { width: 1920, height: 1080, top: 108 };
const saved: InspectorPlacement = {
  layoutVersion: 1,
  panelId: "inspector",
  mode: "floating",
  rect: { x: 1500, y: 180, width: 320, height: 600 },
};
it("roundtrips an explicit versioned Inspector slot, independent of Project and visibility", () => {
  const parsed = parseInspectorPlacement(JSON.stringify(saved));
  expect(parsed).toEqual(saved);
  expect(parsed).not.toBe(saved);
  expect(parsed!.rect).not.toBe(saved.rect);
  expect(
    parseInspectorPlacement(JSON.stringify({ ...saved, mode: "docked" }))?.mode,
  ).toBe("docked");
  expect(initialInspectorPlacement(area).mode).toBe("docked");
});
it("rejects damaged, unknown-version, wrong-panel and unbounded settings as an absent slot", () => {
  for (const raw of [
    undefined,
    null,
    "not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...saved, layoutVersion: 2 }),
    JSON.stringify({ ...saved, panelId: "sidebar" }),
    JSON.stringify({ ...saved, mode: "unknown" }),
    JSON.stringify({ ...saved, visible: true }),
    JSON.stringify({ ...saved, rect: { ...saved.rect, width: 279 } }),
    JSON.stringify({ ...saved, rect: { ...saved.rect, height: 901 } }),
    JSON.stringify({ ...saved, rect: { ...saved.rect, x: -1 } }),
    JSON.stringify({ ...saved, rect: { ...saved.rect, y: null } }),
    JSON.stringify({ ...saved, rect: { ...saved.rect, assetId: "unused" } }),
    JSON.stringify({ ...saved, rect: { x: 1, y: 1, width: 640 } }),
  ])
    expect(parseInspectorPlacement(raw)).toBeNull();
});
it("clamps a displayed rectangle while preserving the desired and saved positions", () => {
  const source = { x: 3000, y: 2800, width: 640, height: 900 };
  Object.freeze(source);
  const current = visibleInspectorRect(source, area)!;
  expect(current).toEqual({ x: 1272, y: 172, width: 640, height: 900 });
  expect(source).toEqual({ x: 3000, y: 2800, width: 640, height: 900 });
  expect(
    visibleInspectorRect(source, { width: 3840, height: 4320, top: 108 }),
  ).toEqual(source);
  const small = visibleInspectorRect(
    { x: 0, y: 0, width: 100, height: 100 },
    area,
  )!;
  expect(small).toEqual({ x: 8, y: 116, width: 280, height: 240 });
});
it("temporarily declines floating on narrow or short screens without altering the saved request", () => {
  const raw = JSON.stringify(saved);
  for (const viewport of [
    { width: 1099, height: 1080, top: 108 },
    { width: 1920, height: 479, top: 108 },
    { width: 1920, height: 800, top: 700 },
    { width: NaN, height: 1080, top: 108 },
  ]) {
    expect(supportsFloatingInspector(viewport)).toBe(false);
    expect(visibleInspectorRect(saved.rect, viewport)).toBeNull();
  }
  expect(JSON.stringify(saved)).toBe(raw);
  expect(visibleInspectorRect(saved.rect, area)).toEqual(saved.rect);
  expect(
    supportsFloatingInspector({ width: 1100, height: 480, top: 108 }),
  ).toBe(true);
});
it("moves and resizes from a fixed starting rectangle, clamps boundaries and retains fractional pixels", () => {
  const rect = { x: 300, y: 180, width: 320, height: 600 };
  expect(adjustedInspectorRect(rect, "move", 12.5, 8.25, area)).toEqual({
    ...rect,
    x: 312.5,
    y: 188.25,
  });
  expect(adjustedInspectorRect(rect, "resize", 24, 32, area)).toEqual({
    ...rect,
    width: 344,
    height: 632,
  });
  expect(adjustedInspectorRect(rect, "move", -1000, -1000, area)).toEqual({
    ...rect,
    x: 8,
    y: 116,
  });
  expect(adjustedInspectorRect(rect, "resize", -1000, -1000, area)).toEqual({
    ...rect,
    width: 280,
    height: 240,
  });
  expect(adjustedInspectorRect(rect, "resize", Infinity, 0, area)).toBeNull();
  expect(
    visibleInspectorRect({ x: NaN, y: 0, width: 320, height: 600 }, area),
  ).toBeNull();
  expect(rect).toEqual({ x: 300, y: 180, width: 320, height: 600 });
});

it("keeps the top-left fixed when bottom-right resizing reaches a viewport edge", () => {
  const start = { x: 1592, y: 472, width: 320, height: 600 };
  expect(adjustedInspectorRect(start, "resize", 300, 300, area)).toEqual(start);
  expect(adjustedInspectorRect(start, "resize", -40, -40, area)).toEqual({
    ...start,
    width: 280,
    height: 560,
  });
});
