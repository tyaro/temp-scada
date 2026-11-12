import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/level-cases.json";
import {
  parseProject,
  serializeProject,
  type LevelShape,
  type Project,
} from "./project";
import { applyCommand } from "./editor";
import {
  levelFillRect,
  levelFraction,
  levelFromReading,
  levelFromSlot,
  validateLevelShape,
} from "./level";
import { bindingReferences } from "./binding-references";
import {
  applyBindingReplacement,
  previewBindingReplacement,
} from "./binding-replacement";
import { symbolSlotUsages } from "./symbol-slots";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { slotPresentation, type SlotPresentation } from "./slot-presentation";
import type { SlotProvenance } from "./read-slot-session";

const provenance = (simulated: boolean): SlotProvenance => ({
  catalogRevision: 1,
  runId: 1,
  collectionMode: "configured",
  valueSource: simulated ? "simulation" : "real",
  sourceTimestampMs: 0,
});
const shape = { min: 0, max: 200 };

it.each(cases)("level contract: $name", ({ target, valid, object }) => {
  const value = structuredClone(sample),
    node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], value as any);
  node.push(object);
  if (valid)
    expect(
      parseProject(serializeProject(parseProject(JSON.stringify(value)))),
    ).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});

describe("level display", () => {
  it("fills only a Good value inside the limits", () => {
    expect(
      levelFromReading(shape, {
        state: "resolved",
        quality: "good",
        numericValue: 50,
      }),
    ).toEqual({
      state: "good",
      fraction: 0.25,
      simulated: false,
      description: "50（0〜200）",
    });
    expect(
      levelFromReading(shape, {
        state: "resolved",
        quality: "good",
        numericValue: 200,
      }),
    ).toMatchObject({ state: "good", fraction: 1 });
  });
  it("leaves out-of-range values empty and names the side", () => {
    expect(
      levelFromReading(shape, {
        state: "resolved",
        quality: "good",
        numericValue: 201,
      }),
    ).toEqual({
      state: "high",
      simulated: false,
      description: "201 · 範囲外（0〜200）",
    });
    expect(
      levelFromReading(shape, {
        state: "resolved",
        quality: "good",
        numericValue: -1,
      }),
    ).toMatchObject({ state: "low" });
  });
  it("never fills stale, bad, invalid or unbound readings", () => {
    for (const [reading, label] of [
      [{ state: "resolved", quality: "stale", numericValue: 50 }, "更新停止"],
      [{ state: "resolved", quality: "bad", numericValue: 50 }, "不良"],
      [{ state: "resolved", quality: "good", numericValue: null }, "値が不正"],
      [{ state: "unresolved" }, "未解決"],
      [undefined, "未接続"],
    ] as const) {
      expect(levelFromReading(shape, reading)).toEqual({
        state: "unavailable",
        label,
        simulated: false,
        description: `-- · ${label}`,
      });
    }
  });
  it("marks a simulated value", () => {
    expect(
      levelFromReading(shape, {
        state: "resolved",
        quality: "good",
        numericValue: 100,
        provenance: provenance(true),
      }),
    ).toMatchObject({
      state: "good",
      simulated: true,
      description: "SIM · 100（0〜200）",
    });
  });
  it("reads a number slot and refuses other slot values", () => {
    const good: SlotPresentation = {
      state: "good",
      label: "Good",
      text: "150",
      value: { type: "number", value: 150 },
      provenance: provenance(false),
    };
    expect(levelFromSlot(shape, good)).toMatchObject({
      state: "good",
      fraction: 0.75,
    });
    expect(
      levelFromSlot(shape, {
        ...good,
        value: { type: "bool", value: true },
      }),
    ).toMatchObject({ state: "unavailable", label: "値が不正" });
    expect(levelFromSlot(shape, slotPresentation("unassigned"))).toMatchObject({
      state: "unavailable",
      label: "未割付",
    });
  });
  it("keeps the fraction finite for limits whose span overflows", () => {
    const huge = { min: -1e308, max: 1e308 };
    for (const [value, fraction] of [
      [0, 0.5],
      [1e308, 1],
      [-1e308, 0],
      [5e307, 0.75],
    ] as const) {
      const display = levelFromReading(huge, {
        state: "resolved",
        quality: "good",
        numericValue: value,
      });
      expect(display).toMatchObject({ state: "good" });
      expect(display.fraction).toBeCloseTo(fraction, 12);
    }
    expect(
      levelFraction(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE),
    ).toBe(1);
    expect(levelFraction(5e-324, 0, 1e-323)).toBe(0.5);
  });
  it("grows upward or rightward", () => {
    expect(levelFillRect(40, 100, "up", 0.25)).toEqual({
      x: 0,
      y: 75,
      width: 40,
      height: 25,
    });
    expect(levelFillRect(100, 40, "right", 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 40,
    });
  });
  it("refuses limits that are not increasing", () => {
    const level = (min: number, max: number): LevelShape => ({
      type: "level",
      direction: "up",
      min,
      max,
    });
    expect(() => validateLevelShape(level(1, 1))).toThrow(/下限/);
    expect(() => validateLevelShape(level(2, 1))).toThrow(/下限/);
    expect(() => validateLevelShape(level(0, Infinity))).toThrow(/下限/);
    expect(() => validateLevelShape(level(-1, 1))).not.toThrow();
  });
});

describe("level editing", () => {
  const fresh = () => parseProject(JSON.stringify(sample));
  const added = (project: Project) => project.screens[0].objects.at(-1)!;
  function addLevel(project: Project) {
    return applyCommand(
      project,
      { type: "add", screenId: project.screens[0].id, kind: "level" },
      "edit",
    );
  }
  it("adds an empty level with default limits", () => {
    const project = addLevel(fresh());
    expect(added(project)).toMatchObject({
      width: 40,
      height: 120,
      shape: {
        type: "level",
        direction: "up",
        min: 0,
        max: 100,
        background: "#1e293b",
      },
    });
    expect(added(project).fill).toMatch(/^#[0-9a-f]{6}$/i);
    expect(() => parseProject(serializeProject(project))).not.toThrow();
  });
  it("applies the Inspector form: limits, direction, background and tag", () => {
    let project = addLevel(fresh());
    const selected = added(project);
    const values = objectFormValues(selected, false);
    const data = new Map(
      Object.entries({
        ...values,
        levelDirection: "right",
        levelMin: "-5",
        levelMax: "15.5",
        levelBackgroundMode: "none",
        externalName: "Demo.Number",
      }),
    );
    project = applyCommand(
      project,
      objectFormCommand(data as unknown as FormData, {
        screenId: project.screens[0].id,
        definition: false,
        selected,
      }),
      "edit",
    );
    expect(added(project).shape).toEqual({
      type: "level",
      direction: "right",
      min: -5,
      max: 15.5,
      binding: { externalName: "Demo.Number" },
    });
    expect(
      bindingReferences(project)
        .find((ref) => ref.externalName === "Demo.Number")
        ?.usages.map((usage) => usage.objectId),
    ).toContain(selected.id);
    const preview = previewBindingReplacement(
      project,
      "Demo.Number",
      "Demo.Other",
    );
    expect(preview.usages.map((usage) => usage.objectId)).toContain(
      selected.id,
    );
    const candidate = parseProject(serializeProject(project));
    applyBindingReplacement(candidate, preview);
    expect(added(candidate).shape).toMatchObject({
      binding: { externalName: "Demo.Other" },
    });
  });
  it("refuses reversed limits from the form and the command", () => {
    const project = addLevel(fresh());
    const selected = added(project);
    const data = new Map(
      Object.entries({
        ...objectFormValues(selected, false),
        levelMin: "10",
        levelMax: "10",
      }),
    );
    expect(() =>
      objectFormCommand(data as unknown as FormData, {
        screenId: project.screens[0].id,
        definition: false,
        selected,
      }),
    ).toThrow(/下限/);
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          objectId: selected.id,
          patch: { level: { direction: "up", min: 5, max: 1 } },
        },
        "edit",
      ),
    ).toThrow(/下限/);
  });
  it("binds a level in a Symbol definition to a number slot only", () => {
    let project = fresh();
    const definition = project.symbols[0];
    project = applyCommand(
      project,
      {
        type: "add",
        screenId: project.screens[0].id,
        definitionId: definition.id,
        kind: "level",
      },
      "edit",
    );
    const level = project.symbols[0].objects.at(-1)!;
    const update = (slotName: string) =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          definitionId: definition.id,
          objectId: level.id,
          patch: { slotBinding: { slotName } },
        },
        "edit",
      );
    project = update("current");
    expect(project.symbols[0].objects.at(-1)!.shape).toMatchObject({
      slotBinding: { slotName: "current" },
    });
    expect(
      symbolSlotUsages(project.symbols[0], "current").map((item) => item.id),
    ).toContain(level.id);
    expect(() => update("running")).toThrow(/number/);
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          definitionId: definition.id,
          objectId: level.id,
          patch: { binding: { externalName: "Demo.Number" } },
        },
        "edit",
      ),
    ).toThrow();
  });
});
