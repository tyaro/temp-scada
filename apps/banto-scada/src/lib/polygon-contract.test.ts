import { expect, it } from "vitest";
import processSample from "../../../../examples/process.project.json";
import stateColorSample from "../../../../examples/state-color.project.json";
import cases from "../../../../examples/polygon-cases.json";
import {
  parseProject,
  serializeProject,
  validatePolygonPoints,
  type Point,
} from "./project";

const samples: Record<string, unknown> = {
  process: processSample,
  stateColor: stateColorSample,
};

for (const test of cases) {
  it(`polygon contract: ${test.name}`, () => {
    const project: any = structuredClone(samples[test.sample]);
    const object = test.target
      .split("/")
      .slice(1)
      .reduce((node: any, key) => node[key], project);
    object.shape = structuredClone(test.shape);
    if ("objectPatch" in test) Object.assign(object, test.objectPatch);
    if (test.valid) {
      const value = parseProject(JSON.stringify(project));
      expect(parseProject(serializeProject(value))).toEqual(value);
    } else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
}

it("accepts 1e0 written as an exponent in the JSON text", () => {
  const project: any = structuredClone(processSample);
  project.screens[0].objects[2].shape = {
    type: "polygon",
    points: [
      { x: 0, y: 1 },
      { x: 0.5, y: 0 },
      { x: 1, y: 1 },
    ],
    paint: (processSample.screens[0].objects[2].shape as any).paint,
  };
  const text = JSON.stringify(project).replace(
    '{"x":1,"y":1}',
    '{"x":1e0,"y":1e0}',
  );
  expect(text).toContain("1e0");
  expect(() => parseProject(text)).not.toThrow();
});

it("rejects non-finite polygon coordinates", () => {
  const triangle: Point[] = [
    { x: 0, y: 1 },
    { x: 0.5, y: 0 },
    { x: 1, y: 1 },
  ];
  expect(() => validatePolygonPoints(triangle)).not.toThrow();
  for (const bad of [NaN, Infinity, -Infinity])
    expect(() =>
      validatePolygonPoints([...triangle, { x: bad, y: 0.5 }]),
    ).toThrow("有限");
});
