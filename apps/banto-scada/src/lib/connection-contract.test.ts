import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import cases from "../../../../examples/connection-cases.json";
import { parseProject, serializeProject } from "./project";
for (const c of cases)
  it(`shares saved connection contract with Rust: ${c.name}`, () => {
    const project = structuredClone(sample);
    for (const patch of c.patches) {
      const keys = patch.path.slice(1).split("/");
      let parent: any = project;
      for (const key of keys.slice(0, -1)) parent = parent[key];
      parent[keys.at(-1)!] = structuredClone(patch.value);
    }
    const json = JSON.stringify(project);
    if (c.valid)
      expect(parseProject(serializeProject(parseProject(json)))).toEqual(
        project,
      );
    else expect(() => parseProject(json)).toThrow();
  });
