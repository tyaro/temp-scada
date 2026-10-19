import { expect, it } from "vitest";
import { objectsInRange } from "./range-selection";
import { parseProject, type ScreenObject } from "./project";
import sample from "../../../../examples/minimal.project.json";
const objects = () => parseProject(JSON.stringify(sample)).screens[0].objects;
it("selects full bounds in either drag direction, including edges, in stacking order", () => {
  const items = objects().reverse();
  const expected = objects()
    .slice(0, 2)
    .map((o) => o.id);
  expect(objectsInRange(items, { x: 100, y: 170 }, { x: 710, y: 350 })).toEqual(
    expected,
  );
  expect(objectsInRange(items, { x: 710, y: 350 }, { x: 100, y: 170 })).toEqual(
    expected,
  );
  expect(objectsInRange(items, { x: 101, y: 171 }, { x: 709, y: 349 })).toEqual(
    [],
  );
});
it("uses object-local negative pipe points with stroke and arrow bounds", () => {
  const pipe: ScreenObject = {
    rotation: 0,
    id: "pipe",
    order: 0,
    x: 100,
    y: 100,
    fill: "#000000",
    shape: {
      type: "polyline",
      points: [
        { x: -20, y: -10 },
        { x: 20, y: 10 },
      ],
      strokeWidth: 4,
      arrow: "end",
    },
  };
  expect(objectsInRange([pipe], { x: 68, y: 78 }, { x: 132, y: 122 })).toEqual([
    "pipe",
  ]);
  expect(objectsInRange([pipe], { x: 69, y: 78 }, { x: 132, y: 122 })).toEqual(
    [],
  );
});
it("treats shared-symbol placement size as the selectable bounds, without selecting definition children", () => {
  const symbol: ScreenObject = {
    ...objects()[0],
    id: "symbol",
    width: 260,
    height: 180,
    shape: { type: "symbol", colorMode: "monochrome", symbolId: "definition" },
  };
  expect(
    objectsInRange([symbol], { x: 90, y: 160 }, { x: 370, y: 360 }),
  ).toEqual(["symbol"]);
  expect(
    objectsInRange([symbol], { x: 100, y: 170 }, { x: 100, y: 170 }),
  ).toEqual([]);
  expect(objectsInRange([], { x: 0, y: 0 }, { x: 960, y: 540 })).toEqual([]);
});
