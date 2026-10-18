import { expect, it } from "vitest";
import { parseNumericProperty, objectFormValues } from "./numeric-properties";
import sample from "../../../../../examples/tag-binding.project.json";
import { parseProject } from "../project";
it("accepts finite decimal and exponent input without accepting empty, partial or nondecimal text", () => {
  for (const [raw, expected] of [
    [" +12.5 ", 12.5],
    ["-.5", -0.5],
    ["1e2", 100],
    ["1.", 1],
    ["-0", -0],
  ] as const)
    expect(parseNumericProperty(raw)).toBe(expected);
  for (const raw of [
    "",
    " ",
    "1e",
    "+",
    "NaN",
    "Infinity",
    "1e999",
    "0x10",
    "１",
    "1,2",
  ])
    expect(() => parseNumericProperty(raw)).toThrow();
});
it("uses committed shape-specific baselines and excludes direct binding inside definitions", () => {
  const object = parseProject(JSON.stringify(sample)).screens[0].objects[2];
  const original = JSON.stringify(object);
  const values = objectFormValues(object, false);
  expect(values.externalName).toBe("PLC01.Fast.Tank01.Level");
  expect(values.x).toBe("100");
  expect(objectFormValues(object, true)).not.toHaveProperty("externalName");
  values.text = "changed";
  expect(JSON.stringify(object)).toBe(original);
});
