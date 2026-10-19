import { describe, expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import cases from "../../../../examples/contract-cases.json";
import { parseProject, serializeProject } from "./project";
describe("Project contract shared with Rust", () => {
  it("round-trips without changing identity or revision", () => {
    const project = parseProject(JSON.stringify(sample));
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
  for (const test of cases)
    it(test.name, () => {
      const value = structuredClone(sample);
      const parts = test.path.slice(1).split("/");
      let target: any = value;
      for (const key of parts.slice(0, -1)) target = target[key];
      target[parts.at(-1)!] = test.value;
      if (test.valid)
        expect(() => parseProject(JSON.stringify(value))).not.toThrow();
      else expect(() => parseProject(JSON.stringify(value))).toThrow();
    });
  it("rejects unknown properties instead of dropping data", () => {
    expect(() =>
      parseProject(JSON.stringify({ ...sample, futureFeature: true })),
    ).toThrow();
  });
});

import processSample from "../../../../examples/process.project.json";
import processCases from "../../../../examples/process-contract-cases.json";
import legacy from "../../../../examples/legacy.project.json";
import { getBounds, parsePoints } from "./project";
it("migrates the validated legacy format without changing identity, geometry or revision", () => {
  const next = parseProject(JSON.stringify(legacy));
  expect(next.manifest.schemaVersion).toBe("0.22.0");
  expect(next.manifest.minRuntimeVersion).toBe("0.22.0");
  expect(next.manifest.projectId).toBe(legacy.manifest.projectId);
  expect(next.manifest.projectRevision).toBe(legacy.manifest.projectRevision);
  expect(next.screens).toEqual(
    legacy.screens.map((screen) => ({
      ...screen,
      background: "#0b1220",
      folders: [],
      groups: [],
      objects: screen.objects.map((object) => ({
        ...Object.fromEntries(
          Object.entries(object).filter(
            ([key]) =>
              key !== "fill" ||
              !["rectangle", "ellipse"].includes(object.shape.type),
          ),
        ),
        rotation: 0,
        shape:
          object.shape.type === "rectangle" || object.shape.type === "ellipse"
            ? {
                ...object.shape,
                paint: {
                  fill: {
                    enabled: true,
                    paint: {
                      type: "solid" as const,
                      color: object.fill,
                      alpha: 1,
                    },
                  },
                  stroke: null,
                },
              }
            : object.shape.type === "text"
              ? {
                  ...object.shape,
                  style: {
                    fontSize: object.height * 0.7,
                    fontWeight: "normal",
                    align: "left",
                  },
                }
              : object.shape,
      })),
    })),
  );
  expect(next.symbols).toEqual([]);
  expect(() =>
    parseProject(JSON.stringify({ ...legacy, futureFeature: true })),
  ).toThrow();
});
it("round-trips the process Project and shared Symbol definitions", () => {
  const project = parseProject(JSON.stringify(processSample));
  expect(parseProject(serializeProject(project))).toEqual(project);
});
for (const test of processCases)
  it(test.name, () => {
    const value = structuredClone(processSample);
    const parts = test.path.slice(1).split("/");
    let target: any = value;
    for (const key of parts.slice(0, -1)) target = target[key];
    target[parts.at(-1)!] = test.value;
    if (test.valid)
      expect(() => parseProject(JSON.stringify(value))).not.toThrow();
    else expect(() => parseProject(JSON.stringify(value))).toThrow();
  });
it("supports negative local bounds and validates point text", () => {
  expect(parsePoints("-20,-10\n80,0")).toEqual([
    { x: -20, y: -10 },
    { x: 80, y: 0 },
  ]);
  expect(() => parsePoints("1,2,3")).toThrow();
  expect(() => parsePoints("1,")).toThrow();
  expect(() => parsePoints("Infinity,0")).toThrow();
  expect(
    getBounds({
      rotation: 0,
      id: "test",
      order: 0,
      x: 0,
      y: 0,
      fill: "#ffffff",
      shape: {
        type: "polyline",
        points: [
          { x: -20, y: -10 },
          { x: 80, y: -10 },
        ],
        strokeWidth: 4,
        arrow: "none",
      },
    }),
  ).toEqual({ x: -22, y: -12, width: 104, height: 4 });
  expect(
    getBounds({
      rotation: 0,
      id: "test",
      order: 0,
      x: 0,
      y: 0,
      fill: "#ffffff",
      shape: {
        type: "polyline",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        strokeWidth: 4,
        arrow: "end",
      },
    }),
  ).toEqual({ x: -12, y: -12, width: 124, height: 24 });
});

it("requires screen background and keeps Symbol definitions transparent", () => {
  const missing: any = structuredClone(sample);
  delete missing.screens[0].background;
  expect(() => parseProject(JSON.stringify(missing))).toThrow();
  const symbolBackground: any = structuredClone(processSample);
  symbolBackground.symbols[0].background = "#ffffff";
  expect(() => parseProject(JSON.stringify(symbolBackground))).toThrow();
});
