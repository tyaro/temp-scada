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
