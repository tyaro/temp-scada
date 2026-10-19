import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/opacity-cases.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
import { compositedOpacity } from "./opacity";
import Primitive from "./Primitive.svelte";
it("shares colorAlpha and stroke alpha limits with Rust and forbids duplicate shape root alpha", () => {
  for (const owners of ["screens", "symbols"] as const)
    for (const [index, original] of sample[owners][0].objects.entries())
      for (const field of ["colorAlpha", "strokeAlpha"])
        for (const entry of cases) {
          if (
            field === "strokeAlpha" &&
            !["rectangle", "ellipse"].includes(original.shape.type)
          )
            continue;
          const project: any = structuredClone(sample),
            object = project[owners][0].objects[index];
          const target =
            field === "colorAlpha"
              ? object
              : (object.shape.paint.stroke ??= { color: "#334155", width: 4 });
          const key = field === "colorAlpha" ? "colorAlpha" : "alpha";
          if ("missing" in entry) delete target[key];
          else target[key] = entry.value;
          if (
            entry.valid &&
            !(
              field === "colorAlpha" &&
              ["rectangle", "ellipse"].includes(original.shape.type) &&
              !("missing" in entry)
            )
          )
            expect(parseProject(JSON.stringify(project))).toEqual(project);
          else expect(() => parseProject(JSON.stringify(project))).toThrow();
        }
});
it("composites line/arrow, text and monochrome Symbol once, independently of shape fill/stroke", () => {
  const project = parseProject(JSON.stringify(sample));
  for (const object of [
    ...project.screens[0].objects,
    ...project.symbols[0].objects,
  ]) {
    object.opacity = 0.5;
    object.colorAlpha = 0.4;
    if (object.shape.type === "symbol") object.shape.colorMode = "monochrome";
    expect(compositedOpacity(object)).toBe(
      ["rectangle", "ellipse"].includes(object.shape.type) ? 0.5 : 0.2,
    );
    if (object.shape.type === "symbol") {
      object.shape.colorMode = "definition";
      expect(compositedOpacity(object)).toBe(0.5);
    }
    if (object.shape.type === "rectangle" || object.shape.type === "ellipse") {
      object.shape.paint.fill.paint = {
        type: "solid",
        color: "#507482",
        alpha: 0.4,
      };
      delete object.colorAlpha;
      object.shape.paint.stroke = { color: "#334155", width: 4, alpha: 0.7 };
      const html = render(Primitive, { props: { object } }).body;
      expect(html).toContain('fill-opacity="0.4"');
      expect(html).toContain('stroke-opacity="0.7"');
    }
  }
});
it("no-op defaults, RGB-only bulk edits, line styles and modes preserve independent alpha", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    object = owner.objects.find((o) => o.shape.type === "rectangle")!;
  const command = {
    type: "update" as const,
    screenId: owner.id,
    objectId: object.id,
    patch: {
      paint:
        object.shape.type === "rectangle"
          ? structuredClone(object.shape.paint)
          : undefined,
    },
  };
  expect(applyCommand(project, command, "edit")).toBe(project);
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.fill.paint = {
    type: "solid",
    color: "#507482",
    alpha: 0.3,
  };
  object.opacity = 0.8;
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.stroke = { color: "#334155", width: 4, alpha: 0.2 };
  const next = applyCommand(
    project,
    {
      type: "set-color",
      screenId: owner.id,
      objectIds: [object.id],
      fill: "#123456",
    },
    "edit",
  );
  const changed = next.screens[0].objects.find((o) => o.id === object.id)!;
  expect(
    changed.shape.type === "rectangle" && changed.shape.paint.fill.paint,
  ).toMatchObject({ alpha: 0.3 });
  expect(changed.opacity).toBe(0.8);
  if (changed.shape.type !== "rectangle") throw new Error("fixture");
  expect(changed.shape.paint.stroke?.alpha).toBe(0.2);
  for (const colorAlpha of [NaN, Infinity, -1, 2])
    expect(() =>
      applyCommand(project, { ...command, patch: { colorAlpha } }, "edit"),
    ).toThrow();
});
