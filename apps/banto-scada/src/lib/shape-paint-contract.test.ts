import { it, expect } from "vitest";
import sample from "../../../../examples/process.project.json";
import paintSample from "../../../../examples/shape-paint.project.json";
import cases from "../../../../examples/shape-paint-cases.json";
import { parseProject, serializeProject } from "./project";
for (const test of cases) {
  it(test.name, () => {
    const project: any = structuredClone(sample);
    const kind = test.kind ?? "rectangle";
    const object = project.screens[0].objects.find(
      (o: any) => o.shape.type === (kind === "ellipse" ? "rectangle" : kind),
    );
    if (kind === "ellipse") object.shape.type = kind;
    let target = object;
    if (test.definition) {
      target = structuredClone(object);
      target.id = project.symbols[0].objects[0].id;
      target.order = project.symbols[0].objects[0].order;
      project.symbols[0].objects[0] = target;
    }
    if (test.omit) delete target.shape.paint;
    else target.shape.paint = test.paint;
    if (test.valid) {
      const value = parseProject(JSON.stringify(project));
      expect(parseProject(serializeProject(value))).toEqual(value);
    } else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
}

it("round-trips the independent paint sample", () => {
  const project = parseProject(JSON.stringify(paintSample));
  expect(parseProject(serializeProject(project))).toEqual(project);
});
