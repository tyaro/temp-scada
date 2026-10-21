import { expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/project.schema.json";
import sample from "../../../../examples/minimal.project.json";
import equipment from "../../../../examples/equipment-property.project.json";
import legacy from "../../../../examples/legacy.project.json";
import { parseProject, serializeProject } from "./project";
import { normalizeProjectText } from "./text-content";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("normalizes each owned Text body without mutating the input JSON object or changing its display source", () => {
  const raw = structuredClone(equipment),
    expected = structuredClone(equipment);
  for (const key of ["screens", "symbols"] as const)
    for (const [index, owner] of raw[key].entries()) {
      const object = owner.objects.find((o) => o.shape.type === "text")!;
      if (object.shape.type !== "text") throw Error("fixture");
      object.shape.text = "\r\n A \rB\u2028\u2029";
      const target = expected[key][index].objects.find(
        (o) => o.id === object.id,
      )!;
      if (target.shape.type !== "text") throw Error("fixture");
      target.shape.text = "\n A \nB\n\n";
    }
  const before = structuredClone(raw),
    result = parseProject(JSON.stringify(raw));
  expect(result).toEqual(expected);
  expect(raw).toEqual(before);
  expect(parseProject(serializeProject(result))).toEqual(result);
});
it("normalizes direct edit commands atomically, preserves blank lines, and treats equivalent CRLF as a no-op", () => {
  const p = fresh(),
    object = p.screens[0].objects.find((o) => o.shape.type === "text")!,
    command = {
      type: "update" as const,
      screenId: p.screens[0].id,
      objectId: object.id,
      patch: { text: "\r\n A \r\n\r" },
    };
  const result = recordEdit(p, emptyHistory(), command, "edit"),
    changed = result.project.screens[0].objects.find(
      (o) => o.id === object.id,
    )!;
  expect(changed.shape).toMatchObject({ text: "\n A \n\n" });
  expect(result.history.past).toHaveLength(1);
  const same = recordEdit(result.project, result.history, command, "edit");
  expect(same.project).toBe(result.project);
  expect(same.history).toBe(result.history);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(p.screens);
});
it("exports canonical LF even from a manually constructed Project without mutating that object", () => {
  const p = fresh(),
    object = p.screens[0].objects.find((o) => o.shape.type === "text")!;
  if (object.shape.type !== "text") throw Error("fixture");
  object.shape.text = "\r\n A \rB\u2028\u2029";
  const before = structuredClone(p),
    json = serializeProject(p);
  expect(
    JSON.parse(json).screens[0].objects.find((o: any) => o.id === object.id)
      .shape.text,
  ).toBe("\n A \nB\n\n");
  expect(json.endsWith("\n")).toBe(true);
  expect(p).toEqual(before);
  object.shape.text = "C:\\resources\\new\\unit";
  expect(serializeProject(p)).toBe(JSON.stringify(p, null, 2) + "\n");
  expect(parseProject(serializeProject(p))).toEqual(p);
});
it("keeps the shared storage schema LF-only while public import canonicalizes input separators", () => {
  const raw = structuredClone(sample);
  raw.screens[0].objects.find((o) => o.shape.type === "text")!.shape.text =
    "a\rb";
  const validate = new Ajv2020({
    allErrors: true,
    strictNumbers: true,
  }).compile(schema);
  expect(validate(raw)).toBe(false);
  const canonical = parseProject(JSON.stringify(raw));
  expect(validate(canonical)).toBe(true);
});
it("enforces the existing 1000 character limit after newline normalization", () => {
  const raw = structuredClone(sample),
    object = raw.screens[0].objects.find((o) => o.shape.type === "text")!;
  object.shape.text = "x\r\n".repeat(500);
  const p = parseProject(JSON.stringify(raw));
  expect(
    p.screens[0].objects.find((o) => o.id === object.id)!.shape,
  ).toMatchObject({ text: "x\n".repeat(500) });
  object.shape.text = "x\r\n".repeat(501);
  expect(() => parseProject(JSON.stringify(raw))).toThrow();
});
it("preserves malformed input for schema rejection instead of crashing or converting unrelated fields", () => {
  for (const raw of [
    null,
    3,
    [],
    { screens: "bad" },
    {
      screens: [
        null,
        3,
        {
          objects: [
            null,
            [],
            { shape: null },
            { shape: { type: "rectangle", text: "A\rB" } },
            { shape: { type: "text", text: 7 } },
          ],
        },
      ],
    },
  ]) {
    const before = structuredClone(raw);
    expect(() => normalizeProjectText(raw)).not.toThrow();
    expect(raw).toEqual(before);
    expect(() => parseProject(JSON.stringify(raw))).toThrow();
  }
});
it("migrates legacy text into the current canonical contract and rejects the previous pre-release schema", () => {
  const raw = structuredClone(legacy),
    object = raw.screens[0].objects.find((o) => o.shape.type === "text")!;
  object.shape.text = "先頭\r\n末尾\r";
  const p = parseProject(JSON.stringify(raw));
  expect(p.manifest.schemaVersion).toBe("0.35.0");
  expect(
    p.screens[0].objects.find((o) => o.id === object.id)!.shape,
  ).toMatchObject({ text: "先頭\n末尾\n" });
  const old = structuredClone(sample);
  old.manifest.schemaVersion = old.manifest.minRuntimeVersion = "0.31.0";
  expect(() => parseProject(JSON.stringify(old))).toThrow();
});
