import { expect, it } from "vitest";
import legacy from "../../../../examples/legacy.project.json";
import sample from "../../../../examples/minimal.project.json";
import lineCases from "../../../../examples/text-line-cases.json";
import cases from "../../../../examples/text-style-cases.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit } from "./history";
import { fitText } from "./text-layout";
it("shares required text style and canonical newline contracts with Rust for screens and definitions", () => {
  const project: any = structuredClone(sample),
    text = project.screens[0].objects.find((o: any) => o.shape.type === "text");
  project.symbols = [
    {
      id: "0199fc00-0000-7000-8000-000000000010",
      name: "Text",
      width: 400,
      height: 100,
      folders: [],
      objects: [
        {
          ...structuredClone(text),
          id: "0199fc00-0000-7000-8000-000000000011",
        },
      ],
    },
  ];
  for (const owner of ["screens", "symbols"])
    for (const entry of cases) {
      const value = structuredClone(project),
        object = value[owner][0].objects.find(
          (o: any) => o.shape.type === "text",
        );
      if ("missing" in entry) delete object.shape.style;
      else object.shape.style = entry.value;
      if (entry.valid)
        expect(parseProject(JSON.stringify(value))).toEqual(value);
      else expect(() => parseProject(JSON.stringify(value))).toThrow();
    }
  for (const entry of lineCases) {
    const value = structuredClone(project);
    value.screens[0].objects.find(
      (o: any) => o.shape.type === "text",
    ).shape.text = entry.text;
    if (entry.valid) {
      const expected = structuredClone(value);
      expected.screens[0].objects.find(
        (o: any) => o.shape.type === "text",
      ).shape.text = "normalized" in entry ? entry.normalized : entry.text;
      expect(parseProject(JSON.stringify(value))).toEqual(expected);
    } else expect(() => parseProject(JSON.stringify(value))).toThrow();
  }
  const large: any = structuredClone(legacy);
  large.screens[0].objects.find((o: any) => o.shape.type === "text").height =
    1000;
  const migrated = parseProject(JSON.stringify(large)).screens[0].objects.find(
    (o) => o.shape.type === "text",
  )!;
  expect((migrated as any).height).toBe(1000);
  expect((migrated.shape as any).style.fontSize).toBe(512);
  project.manifest.schemaVersion = project.manifest.minRuntimeVersion =
    "0.11.0";
  expect(() => parseProject(JSON.stringify(project))).toThrow();
});
it("edits text styling atomically, rejects other types and keeps style independent of resize", () => {
  const project = parseProject(JSON.stringify(sample)),
    screen = project.screens[0],
    text = screen.objects.find((o) => o.shape.type === "text")!;
  const command = {
    type: "update" as const,
    screenId: screen.id,
    objectId: text.id,
    patch: {
      textStyle: {
        fontSize: 27.5,
        fontWeight: "bold" as const,
        align: "center" as const,
      },
    },
  };
  const next = applyCommand(project, command, "edit"),
    styled = next.screens[0].objects.find((o) => o.id === text.id)!;
  expect(styled).toEqual({
    ...text,
    shape: { ...text.shape, style: command.patch.textStyle },
  });
  const resized = applyCommand(
    next,
    { ...command, patch: { width: 10, height: 10 } as any },
    "edit",
  );
  expect(
    (resized.screens[0].objects.find((o) => o.id === text.id)!.shape as any)
      .style,
  ).toEqual(command.patch.textStyle);
  expect(recordEdit(next, emptyHistory(), command, "edit").project).toBe(next);
  expect(() =>
    applyCommand(
      project,
      { ...command, objectId: screen.objects[0].id },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      project,
      { ...command, patch: { fontSize: Infinity } },
      "edit",
    ),
  ).toThrow();
});
const measure = (value: string) => ({
  x: -1,
  y: -8,
  width: [...value].length * 10,
  height: 10,
});
it("fits exact ink bounds and ellipsizes complete graphemes without saving display strings", () => {
  expect(fitText("abc", 34, 20, 10, false, measure)).toEqual({
    text: "abc",
    mode: "full",
    baseline: 13,
    left: -1,
    inkWidth: 30,
  });
  expect(fitText("abcdef", 34, 20, 10, false, measure).text).toBe("ab…");
  const measured: string[] = [];
  const family = "👨‍👩‍👧‍👦";
  const fitted = fitText(family + "xyz", 24, 20, 10, false, (value) => {
    measured.push(value);
    return {
      ...measure(value),
      width:
        [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            value,
          ),
        ].length * 10,
    };
  });
  expect(fitted.text).toBe(family + "…");
  expect(
    measured.every((value) => !value.includes("👨") || value.includes(family)),
  ).toBe(true);
});
it("never clips numeric digits and uses a vector fallback for tiny or vertically short frames", () => {
  expect(fitText("123456", 34, 20, 10, true, measure)).toMatchObject({
    text: "###",
    mode: "overflow",
  });
  expect(fitText("123456", 14, 20, 10, true, measure)).toMatchObject({
    text: "",
    mode: "overflow",
  });
  expect(fitText("a", 100, 11, 10, false, measure)).toMatchObject({
    text: "",
    mode: "overflow",
  });
});
