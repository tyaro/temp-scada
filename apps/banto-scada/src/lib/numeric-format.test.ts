import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/numeric-format-cases.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import {
  formatNumber,
  formatSlotText,
  presentNumeric,
} from "./tag-presentation";
import type { SlotPresentation } from "./slot-presentation";
import type { SlotProvenance } from "./read-slot-session";
import {
  numericFormatCommand,
  parseNumericFormat,
} from "./designer/forms/numeric-format";

const form = (values: Record<string, string>) =>
  new Map(Object.entries(values)) as unknown as Pick<FormData, "get">;
const provenance = (simulated: boolean): SlotProvenance => ({
  catalogRevision: 1,
  runId: 1,
  collectionMode: "configured",
  valueSource: simulated ? "simulation" : "real",
  sourceTimestampMs: 0,
});

it.each(cases)(
  "numeric format contract: $name",
  ({ target, key, valid, value: format }) => {
    const value = structuredClone(sample),
      node = target
        .split("/")
        .slice(1)
        .reduce((node, key) => node[key], value as any);
    node[key] = format;
    if (valid)
      expect(
        parseProject(serializeProject(parseProject(JSON.stringify(value)))),
      ).toEqual(value);
    else expect(() => parseProject(JSON.stringify(value))).toThrow();
  },
);

describe("formatNumber", () => {
  it("keeps the value as is without a format", () => {
    expect(formatNumber(12.345)).toBe("12.345");
    expect(formatNumber(-0)).toBe("0");
  });
  it("rounds to fixed decimals and appends the unit after a space", () => {
    expect(formatNumber(12.345, { decimals: 1 })).toBe("12.3");
    expect(formatNumber(12, { decimals: 2 })).toBe("12.00");
    expect(formatNumber(99.96, { decimals: 1, unit: "%" })).toBe("100.0 %");
    expect(formatNumber(3.5, { decimals: 0 })).toBe("4");
    expect(formatNumber(42, { unit: "m3/h" })).toBe("42 m3/h");
  });
  it("drops the minus sign of a value that rounds to zero", () => {
    expect(formatNumber(-0.04, { decimals: 1 })).toBe("0.0");
    expect(formatNumber(-0.4, { decimals: 0, unit: "kPa" })).toBe("0 kPa");
    expect(formatNumber(-0.06, { decimals: 1 })).toBe("-0.1");
  });
});

it("formats only Good tag readings; unavailable ones never show the unit", () => {
  const format = { decimals: 1, unit: "℃" };
  expect(
    presentNumeric(
      { state: "resolved", quality: "good", numericValue: 21.04 },
      format,
    ).text,
  ).toBe("21.0 ℃");
  expect(
    presentNumeric(
      { state: "resolved", quality: "stale", numericValue: 21.04 },
      format,
    ).text,
  ).toBe("-- · 更新停止");
  expect(presentNumeric(undefined, format).text).toBe("-- · 未接続");
  expect(
    presentNumeric(
      { state: "resolved", quality: "good", numericValue: null },
      format,
    ).text,
  ).toBe("-- · 値が不正");
});

it("formats a Good number slot and keeps the SIM prefix", () => {
  const good = (value: number, simulated = false): SlotPresentation => ({
    state: "good",
    label: "Good",
    text: String(value),
    value: { type: "number", value },
    provenance: provenance(simulated),
  });
  const format = { decimals: 2, unit: "MPa" };
  expect(formatSlotText(good(0.5), format)).toBe("0.50 MPa");
  expect(formatSlotText(good(0.5, true), format)).toBe("SIM · 0.50 MPa");
  expect(formatSlotText(good(0.5))).toBe("0.5");
  const bool: SlotPresentation = {
    state: "good",
    label: "Good",
    text: "true",
    value: { type: "bool", value: true },
    provenance: provenance(false),
  };
  expect(formatSlotText(bool, format)).toBe("true");
  const bad: SlotPresentation = {
    state: "bad",
    label: "不良",
    text: "-- · 不良",
  };
  expect(formatSlotText(bad, format)).toBe("-- · 不良");
});

describe("parseNumericFormat", () => {
  it("reads decimals and a trimmed unit, and empty fields remove the format", () => {
    expect(parseNumericFormat(form({ decimals: "2", unit: " kPa　" }))).toEqual(
      { decimals: 2, unit: "kPa" },
    );
    expect(parseNumericFormat(form({ decimals: "", unit: "mm" }))).toEqual({
      unit: "mm",
    });
    expect(parseNumericFormat(form({ decimals: "0", unit: "" }))).toEqual({
      decimals: 0,
    });
    expect(parseNumericFormat(form({ decimals: "", unit: "  " }))).toBeNull();
  });
  it("refuses decimals out of range and invalid units", () => {
    for (const decimals of ["7", "-1", "1.5", "x"])
      expect(() => parseNumericFormat(form({ decimals, unit: "" }))).toThrow(
        /小数桁/,
      );
    expect(() =>
      parseNumericFormat(form({ decimals: "", unit: "abcdefghijklmnopq" })),
    ).toThrow(/16文字/);
    expect(() =>
      parseNumericFormat(form({ decimals: "", unit: "m\u0007m" })),
    ).toThrow(/制御文字/);
  });
});

describe("format edit command", () => {
  const fresh = () => parseProject(JSON.stringify(sample));
  const context = (project: ReturnType<typeof fresh>, index: number) => ({
    generation: 1,
    screenId: project.screens[0].id,
    definition: false,
    selected: project.screens[0].objects[index],
  });
  it("applies, replaces and removes the format of a tag-bound Text", () => {
    let project = fresh();
    const id = project.screens[0].objects[6].id;
    const shape = () => project.screens[0].objects[6].shape;
    const key = `1:${project.screens[0].id}:false`;
    project = applyCommand(
      project,
      numericFormatCommand(
        {
          data: form({ decimals: "1", unit: "m3/h" }),
          objectId: id,
          targetKey: key,
        },
        context(project, 6),
      ),
      "edit",
    );
    expect(shape()).toMatchObject({ format: { decimals: 1, unit: "m3/h" } });
    project = applyCommand(
      project,
      numericFormatCommand(
        {
          data: form({ decimals: "", unit: "" }),
          objectId: id,
          targetKey: key,
        },
        context(project, 6),
      ),
      "edit",
    );
    expect("format" in shape()).toBe(false);
  });
  it("refuses a stale target and a Text without a value", () => {
    const project = fresh();
    const key = `1:${project.screens[0].id}:false`;
    expect(() =>
      numericFormatCommand(
        {
          data: form({ decimals: "1" }),
          objectId: project.screens[0].objects[6].id,
          targetKey: "0:other:false",
        },
        context(project, 6),
      ),
    ).toThrow(/選択し直して/);
    expect(() =>
      numericFormatCommand(
        {
          data: form({ decimals: "1" }),
          objectId: project.screens[0].objects[1].id,
          targetKey: key,
        },
        context(project, 1),
      ),
    ).toThrow(/選択し直して/);
  });
  it("drops the format with the tag binding so the Project stays valid", () => {
    const project = fresh();
    const target = project.screens[0].objects[6];
    if (target.shape.type !== "text") throw new Error("text expected");
    target.shape.format = { decimals: 1 };
    const next = applyCommand(
      project,
      {
        type: "update",
        screenId: project.screens[0].id,
        objectId: target.id,
        patch: { binding: null },
      },
      "edit",
    );
    expect("format" in next.screens[0].objects[6].shape).toBe(false);
    expect(() => parseProject(serializeProject(next))).not.toThrow();
  });
});
