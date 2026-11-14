import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/screen-bool-display-cases.json";
import { parseProject, serializeProject, type Project } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import { previewBindingReplacement } from "./binding-replacement";
import { presentScreenBool } from "./screen-bool-display";
import type { NumericReading } from "./tag-presentation";
import type { SlotProvenance } from "./read-slot-session";
import {
  boolDisplayCommand,
  parseBoolDisplay,
} from "./designer/forms/bool-display";

it.each(cases)(
  "screen bool display contract: $name",
  ({ target, key, valid, value: display, also }) => {
    const value = structuredClone(sample);
    const node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], value as any);
    node[key] = display;
    Object.assign(node, also ?? {});
    if (valid)
      expect(
        parseProject(serializeProject(parseProject(JSON.stringify(value)))),
      ).toEqual(value);
    else expect(() => parseProject(JSON.stringify(value))).toThrow();
  },
);

const display = {
  true: { text: "運転", color: "#16a34a" },
  false: { text: "停止", color: "#64748b" },
  unknownColor: "#d97706",
};
const provenance = (simulated: boolean): SlotProvenance => ({
  catalogRevision: 1,
  runId: 1,
  collectionMode: "configured",
  valueSource: simulated ? "simulation" : "real",
  sourceTimestampMs: 0,
});
const good = (boolValue: boolean, simulated = false): NumericReading => ({
  state: "resolved",
  quality: "good",
  numericValue: null,
  boolValue,
  provenance: provenance(simulated),
});
const unavailable = (
  quality: "stale" | "bad",
  simulated = false,
): NumericReading => ({
  state: "resolved",
  quality,
  numericValue: null,
  provenance: provenance(simulated),
});
const goodNumber = (numericValue: number): NumericReading => ({
  state: "resolved",
  quality: "good",
  numericValue,
  provenance: provenance(false),
});

describe("presentScreenBool", () => {
  it("shows the defined text and color of a Good bool", () => {
    expect(presentScreenBool(display, good(true))).toMatchObject({
      text: "運転",
      color: "#16a34a",
    });
    expect(presentScreenBool(display, good(false))).toMatchObject({
      text: "停止",
      color: "#64748b",
    });
  });
  it("prefixes SIM and keeps the color", () => {
    expect(presentScreenBool(display, good(true, true))).toMatchObject({
      text: "SIM · 運転",
      color: "#16a34a",
    });
  });
  it("keeps an empty label as color only", () => {
    const empty = { ...display, true: { text: "", color: "#16a34a" } };
    expect(presentScreenBool(empty, good(true))).toMatchObject({
      text: "",
      color: "#16a34a",
    });
    expect(presentScreenBool(empty, good(true, true)).text).toBe("SIM");
  });
  it.each([
    ["no reading", undefined, "-- · 未接続"],
    ["disconnected", { state: "disconnected" }, "-- · 未接続"],
    ["unresolved", { state: "unresolved" }, "-- · 未解決"],
    ["invalid", { state: "invalid" }, "-- · 値が不正"],
    ["stale", unavailable("stale"), "-- · 更新停止"],
    ["bad", unavailable("bad"), "-- · 不良"],
    ["a Good number tag", goodNumber(1), "-- · slot型不一致"],
    ["a Good non-finite number", goodNumber(Number.NaN), "-- · 値が不正"],
  ] as [string, NumericReading | undefined, string][])(
    "shows the reason and the unknown color for %s",
    (_name, reading, text) => {
      expect(presentScreenBool(display, reading)).toMatchObject({
        text,
        color: "#d97706",
      });
    },
  );
  it("prefixes SIM on an unavailable simulated reading", () => {
    expect(presentScreenBool(display, unavailable("bad", true))).toMatchObject({
      text: "SIM · -- · 不良",
      color: "#d97706",
    });
  });
  it("treats a Good bool without an origin as real", () => {
    expect(
      presentScreenBool(display, {
        state: "resolved",
        quality: "good",
        numericValue: null,
        boolValue: false,
      }),
    ).toMatchObject({ text: "停止", color: "#64748b" });
  });
});

describe("bool display edit command", () => {
  const fresh = () => parseProject(JSON.stringify(sample));
  const form = (values: Record<string, string>) =>
    new Map(Object.entries(values)) as unknown as Pick<FormData, "get">;
  const enabled = {
    boolDisplayMode: "enabled",
    trueText: "運転",
    trueColor: "#16a34a",
    falseText: "停止",
    falseColor: "#64748b",
    unknownColor: "#d97706",
  };
  const context = (project: Project, index: number) => ({
    generation: 1,
    screenId: project.screens[0].id,
    definition: false,
    selected: project.screens[0].objects[index],
  });
  const command = (
    project: Project,
    values: Record<string, string>,
    index = 6,
  ) =>
    boolDisplayCommand(
      {
        data: form(values),
        objectId: project.screens[0].objects[index].id,
        targetKey: `1:${project.screens[0].id}:false`,
      },
      context(project, index),
    );
  const shape = (project: Project, index = 6) =>
    project.screens[0].objects[index].shape;
  const withDisplay = () => {
    const project = fresh();
    return applyCommand(project, command(project, enabled), "edit");
  };

  it("applies and removes the display as one history entry each, and undoes", () => {
    const project = fresh();
    const applied = recordEdit(
      project,
      emptyHistory(),
      command(project, enabled),
      "edit",
    );
    expect(shape(applied.project)).toMatchObject({ boolDisplay: display });
    expect(applied.history.past).toHaveLength(1);
    const removed = recordEdit(
      applied.project,
      applied.history,
      command(applied.project, { boolDisplayMode: "disabled" }),
      "edit",
    );
    expect("boolDisplay" in shape(removed.project)).toBe(false);
    expect(removed.history.past).toHaveLength(2);
    const undone = travelHistory(
      removed.project,
      removed.history,
      "undo",
      "edit",
    );
    expect(shape(undone.project)).toMatchObject({ boolDisplay: display });
    expect(() => parseProject(serializeProject(removed.project))).not.toThrow();
  });
  it("removes the display together with the tag in one history entry", () => {
    const project = withDisplay();
    const result = recordEdit(
      project,
      emptyHistory(),
      {
        type: "update",
        screenId: project.screens[0].id,
        objectId: project.screens[0].objects[6].id,
        patch: { binding: null },
      },
      "edit",
    );
    expect("binding" in shape(result.project)).toBe(false);
    expect("boolDisplay" in shape(result.project)).toBe(false);
    expect(result.history.past).toHaveLength(1);
    expect(
      shape(
        travelHistory(result.project, result.history, "undo", "edit").project,
      ),
    ).toMatchObject({
      binding: { externalName: "Demo.Number" },
      boolDisplay: display,
    });
  });
  it("refuses a stale target, a Text without a tag and bad input", () => {
    const project = fresh();
    expect(() =>
      boolDisplayCommand(
        {
          data: form(enabled),
          objectId: project.screens[0].objects[6].id,
          targetKey: "0:other:false",
        },
        context(project, 6),
      ),
    ).toThrow(/選択し直して/);
    expect(() => command(project, enabled, 1)).toThrow(/選択し直して/);
    expect(() => command(project, { ...enabled, trueColor: "green" })).toThrow(
      /#RRGGBB/,
    );
    expect(() =>
      command(project, { ...enabled, falseText: "あ".repeat(65) }),
    ).toThrow(/64/);
    expect(() => command(project, { ...enabled, trueText: "a\nb" })).toThrow(
      /改行/,
    );
    expect(() => parseBoolDisplay(form({}))).toThrow(/使用/);
  });
  it("refuses a Text with a numeric format without changing the Project", () => {
    const project = fresh();
    const text = project.screens[0].objects[6].shape;
    if (text.type !== "text") throw new Error("text expected");
    text.format = { decimals: 1 };
    const before = serializeProject(project);
    expect(() => command(project, enabled)).toThrow(/書式/);
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          objectId: project.screens[0].objects[6].id,
          patch: { boolDisplay: display },
        },
        "edit",
      ),
    ).toThrow(/同時/);
    expect(serializeProject(project)).toBe(before);
  });
  it("refuses a format on a Text with the display and keeps the Project", () => {
    const project = withDisplay();
    const before = serializeProject(project);
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          objectId: project.screens[0].objects[6].id,
          patch: { format: { decimals: 1 } },
        },
        "edit",
      ),
    ).toThrow(/同時/);
    expect(serializeProject(project)).toBe(before);
  });
  it("refuses the display on a Text inside a shared definition", () => {
    const project = fresh();
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.symbols[0].id,
          objectId: project.symbols[0].objects[5].id,
          definitionId: project.symbols[0].id,
          patch: { boolDisplay: display },
        },
        "edit",
      ),
    ).toThrow();
  });
  it("keeps the display on duplicate, copy and paste, and tag name replacement", () => {
    const project = withDisplay();
    const screen = project.screens[0];
    const id = screen.objects[6].id;
    const duplicated = applyCommand(
      project,
      { type: "duplicate", screenId: screen.id, objectId: id },
      "edit",
    );
    expect(
      shape(duplicated, duplicated.screens[0].objects.length - 1),
    ).toMatchObject({ boolDisplay: display });
    const pasted = applyCommand(
      project,
      {
        type: "paste",
        screenId: screen.id,
        text: copyObjects(project, screen.id, [id], "a"),
        origin: "a",
        center: { x: 300, y: 300 },
      },
      "edit",
    );
    expect(shape(pasted, pasted.screens[0].objects.length - 1)).toMatchObject({
      boolDisplay: display,
    });
    const { expectedProject } = previewBindingReplacement(
      project,
      "Demo.Number",
      "Demo.Run",
    );
    const replaced = applyCommand(
      project,
      {
        type: "replace-binding-reference",
        from: "Demo.Number",
        to: "Demo.Run",
        expectedProject,
      },
      "edit",
    );
    expect(shape(replaced)).toMatchObject({
      binding: { externalName: "Demo.Run" },
      boolDisplay: display,
    });
  });
});
