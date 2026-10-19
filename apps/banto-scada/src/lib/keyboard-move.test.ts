import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, getBounds, type ScreenObject } from "./project";
import { selectionNudge } from "./keyboard-move";
const objects = () => parseProject(JSON.stringify(sample)).screens[0].objects;
it("nudges all selected objects from one top/left anchor and retains relative positions", () => {
  const selected = objects();
  selected[0].x = 3;
  selected[0].y = -7;
  expect(selectionNudge(selected, { x: 1, y: 0 }, null)).toEqual({
    x: 1,
    y: 0,
  });
  expect(selectionNudge(selected, { x: 0, y: -1 }, null, true)).toEqual({
    x: 0,
    y: -10,
  });
  expect(selectionNudge(selected, { x: 1, y: 0 }, 10)).toEqual({ x: 7, y: 0 });
  expect(selectionNudge(selected, { x: 1, y: 0 }, 10, true)).toEqual({
    x: 97,
    y: 0,
  });
  expect(selectionNudge(selected, { x: -1, y: 0 }, 10)).toEqual({
    x: -3,
    y: 0,
  });
  expect(selectionNudge(selected, { x: 0, y: -1 }, 10)).toEqual({
    x: 0,
    y: -3,
  });
  expect(selected[0].x).toBe(3);
});
it("accounts for pipe strokes and arrows, negative coordinates and floating grid boundaries", () => {
  const pipe: ScreenObject = {
    rotation: 0,
    id: objects()[0].id,
    order: 0,
    x: -3,
    y: 17,
    fill: "#000000",
    shape: {
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 120, y: 0 },
      ],
      strokeWidth: 3,
      arrow: "end",
    },
  };
  const bounds = getBounds(pipe);
  const delta = selectionNudge([pipe], { x: 1, y: 0 }, 10);
  expect(pipe.x + bounds.x + delta.x).toBe(-10);
  for (const x of [10 - 1e-12, 10, 10 + 1e-12]) {
    const selected = objects();
    selected[0].x = x;
    expect(x + selectionNudge([selected[0]], { x: 1, y: 0 }, 10).x).toBeCloseTo(
      20,
    );
    expect(
      x + selectionNudge([selected[0]], { x: -1, y: 0 }, 10).x,
    ).toBeCloseTo(0);
  }
  expect(() => selectionNudge(objects(), { x: 1, y: 1 }, 10)).toThrow();
});
