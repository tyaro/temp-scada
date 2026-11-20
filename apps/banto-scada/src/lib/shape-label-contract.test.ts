import { expect, it } from "vitest";
import processSample from "../../../../examples/process.project.json";
import stateColorSample from "../../../../examples/state-color.project.json";
import demoWaterSample from "../../../../examples/demo-water.project.json";
import symbolImageSample from "../../../../examples/symbol-image.project.json";
import cases from "../../../../examples/shape-label-cases.json";
import shapeLabelSample from "../../../../examples/shape-label.project.json";
import { parseProject, serializeProject } from "./project";

// 面の図形の文字（#305 L1a）の保存契約。Rust の scada-model も同じ契約ケースを読む。
const samples: Record<string, unknown> = {
  process: processSample,
  stateColor: stateColorSample,
  demoWater: demoWaterSample,
  symbolImage: symbolImageSample,
};

const at = (root: unknown, pointer: string): any =>
  pointer
    .split("/")
    .slice(1)
    .reduce((node: any, key) => node[key], root);

for (const test of cases as any[]) {
  it(`shape label contract: ${test.name}`, () => {
    const project: any = structuredClone(samples[test.sample]);
    const object = at(project, test.target);
    if ("shape" in test) object.shape = structuredClone(test.shape);
    if ("shapePatch" in test) Object.assign(object.shape, test.shapePatch);
    if ("objectPatch" in test) Object.assign(object, test.objectPatch);
    if (test.valid) {
      const value = parseProject(JSON.stringify(project));
      expect(parseProject(serializeProject(value))).toEqual(value);
      if ("expectedText" in test)
        expect(at(value, test.target).shape.label.text).toBe(test.expectedText);
    } else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
}

it("shape label sample project parses and round-trips", () => {
  const value = parseProject(JSON.stringify(shapeLabelSample));
  expect(parseProject(serializeProject(value))).toEqual(value);
});
