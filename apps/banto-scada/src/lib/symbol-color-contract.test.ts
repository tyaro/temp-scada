import { it, expect } from "vitest";
import cases from "../../../../examples/symbol-color-cases.json";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
for (const test of cases)
  it(test.name, () => {
    const project: any = structuredClone(sample);
    let object = project.screens[0].objects.find(
      (object: any) => object.shape.type === "symbol",
    );
    if (test.primitive) {
      object = project.screens[0].objects.find(
        (object: any) =>
          object.shape.type ===
          (test.primitive === "ellipse" ? "rectangle" : test.primitive),
      );
      if (test.primitive === "ellipse")
        object.shape = {
          type: "ellipse",
          paint: { fillEnabled: true, stroke: null },
        };
      if (test.definition) {
        const child = structuredClone(object);
        child.id = project.symbols[0].objects[0].id;
        project.symbols[0].objects[0] = child;
        object = child;
      }
    }
    if (test.omitMode) delete object.shape.colorMode;
    else object.shape.colorMode = test.mode;
    if (test.omitFill) delete object.fill;
    if (test.fill) object.fill = test.fill;
    if (test.extra) object.shape.extra = true;
    if (test.valid) {
      const parsed = parseProject(JSON.stringify(project));
      expect(parseProject(serializeProject(parsed))).toEqual(parsed);
      expect(parsed.screens[0].objects).toEqual(project.screens[0].objects);
    } else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });

it("round-trips the rich color sample without losing child colors or placement modes", async () => {
  const { default: sample } =
    await import("../../../../examples/symbol-color.project.json");
  const project = parseProject(JSON.stringify(sample));
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(
    project.screens[0].objects
      .filter((object) => object.shape.type === "symbol")
      .map((object) =>
        object.shape.type === "symbol" ? object.shape.colorMode : "",
      ),
  ).toEqual(["monochrome", "definition", "definition"]);
});
