import { describe, expect, it } from "vitest";
import type { EquipmentSlot } from "./equipment";
import type { TableCell } from "./project";
import type { SlotProvenance } from "./read-slot-session";
import {
  slotPresentation,
  type SlotPresentation,
  type SlotValue,
} from "./slot-presentation";
import { presentScreenBool } from "./screen-bool-display";
import { tableCellSlotView, tableCellView } from "./table-cell-slot";
import type { NumericReading, TagReadings } from "./tag-presentation";

const provenance: SlotProvenance = {
  catalogRevision: 3,
  runId: 7,
  collectionMode: "configured",
  valueSource: "real",
  sourceTimestampMs: 1234,
};
const good = (value: SlotValue, text: string): SlotPresentation => ({
  state: "good",
  label: "Good",
  text,
  value,
  provenance,
});
const run = { text: "運転", color: "#16a34a" };
const stop = { text: "停止", color: "#64748b" };
const boolSlot: EquipmentSlot = {
  name: "running",
  type: "bool",
  direction: "read",
  boolDisplay: { true: run, false: stop },
};
const numberSlot: EquipmentSlot = {
  name: "current",
  type: "number",
  direction: "read",
};
const UNKNOWN = "#a855f7";
const stateCell: TableCell = {
  text: "固定",
  slotBinding: { slotName: "running" },
  stateColors: { unknownColor: UNKNOWN },
};

describe("tableCellSlotView", () => {
  it("returns nothing for a cell without a slot", () => {
    expect(tableCellSlotView({ text: "固定" })).toBeUndefined();
  });
  it("shows a known state's text and color", () => {
    const view = tableCellSlotView(stateCell, (name) => {
      expect(name).toBe("running");
      return {
        display: good({ type: "bool", value: true }, "true"),
        slot: boolSlot,
      };
    });
    expect(view).toEqual({
      slotName: "running",
      text: "運転",
      state: "good",
      label: "Good",
      stateColor: "#16a34a",
    });
  });
  it("uses the unknown color and the reason when the reading is unavailable", () => {
    const view = tableCellSlotView(stateCell, () => ({
      display: slotPresentation("disconnected"),
      slot: boolSlot,
    }))!;
    expect(view.state).toBe("disconnected");
    expect(view.text).toBe(slotPresentation("disconnected").text);
    expect(view.stateColor).toBe(UNKNOWN);
  });
  it("uses the unknown color without equipment (no resolver)", () => {
    const view = tableCellSlotView(stateCell)!;
    expect(view.state).toBe("unbound");
    expect(view.stateColor).toBe(UNKNOWN);
  });
  it("keeps the normal color for a known state without a color", () => {
    const plain: EquipmentSlot = { ...boolSlot, boolDisplay: undefined };
    const view = tableCellSlotView(stateCell, () => ({
      display: good({ type: "bool", value: false }, "false"),
      slot: plain,
    }))!;
    expect(view.text).toBe("false");
    expect(view.stateColor).toBeUndefined();
  });
  it("shows a type mismatch of a Good reading as the state's reason", () => {
    const view = tableCellSlotView(stateCell, () => ({
      display: good({ type: "number", value: 1 }, "1"),
      slot: boolSlot,
    }))!;
    expect(view.state).toBe("typeMismatch");
    expect(view.label).toBe(slotPresentation("typeMismatch").label);
    expect(view.stateColor).toBe(UNKNOWN);
  });
  it("formats a number slot and leaves the color alone", () => {
    const view = tableCellSlotView(
      {
        text: "-",
        slotBinding: { slotName: "current" },
        format: { decimals: 1, unit: "A" },
      },
      () => ({
        display: good({ type: "number", value: 12.345 }, "12.345"),
        slot: numberSlot,
      }),
    )!;
    expect(view.text).toBe("12.3 A");
    expect(view.state).toBe("good");
    expect(view.stateColor).toBeUndefined();
  });
});

describe("tableCellView", () => {
  const TEXT = "#111827";
  const boolCell = (stateTarget?: "text" | "fill"): TableCell => ({
    text: "",
    fill: "#f1f5f9",
    color: "#0f172a",
    binding: { externalName: "pump1_run" },
    boolDisplay: { true: run, false: stop, unknownColor: UNKNOWN },
    ...(stateTarget ? { stateTarget } : {}),
  });
  const bit = (value: boolean): NumericReading => ({
    state: "resolved",
    quality: "good",
    numericValue: null,
    boolValue: value,
  });
  const readings = (reading?: NumericReading): TagReadings =>
    new Map(reading ? [["pump1_run", reading]] : []);

  it("keeps a plain cell's text and colors", () => {
    expect(
      tableCellView({ text: "固定", fill: "#eeeeee" }, { textColor: TEXT }),
    ).toEqual({
      text: "固定",
      state: undefined,
      title: undefined,
      textFill: TEXT,
      rectFill: "#eeeeee",
      stateFill: false,
    });
  });
  it("shows a bit's bool text and puts its color on the text by default", () => {
    for (const target of [undefined, "text"] as const) {
      const view = tableCellView(boolCell(target), {
        readings: readings(bit(true)),
        textColor: TEXT,
      });
      expect(view).toMatchObject({
        text: "運転",
        state: "true",
        textFill: run.color,
        rectFill: "#f1f5f9",
        stateFill: false,
      });
    }
    expect(
      tableCellView(boolCell(), {
        readings: readings(bit(false)),
        textColor: TEXT,
      }),
    ).toMatchObject({ text: "停止", state: "false", textFill: stop.color });
  });
  it("paints the state color as the fill with a fixed text color", () => {
    const on = tableCellView(boolCell("fill"), {
      readings: readings(bit(true)),
      textColor: TEXT,
    });
    expect(on).toMatchObject({
      text: "運転",
      textFill: "#0f172a",
      rectFill: run.color,
      stateFill: true,
    });
    const off = tableCellView(boolCell("fill"), {
      readings: readings(bit(false)),
      textColor: TEXT,
      color: "#ff0000",
    });
    // A monochrome Symbol color only fixes the text; the fill keeps the state.
    expect(off).toMatchObject({ textFill: "#ff0000", rectFill: stop.color });
  });
  it("paints the unknown color for an unresolved or number tag", () => {
    const unresolved = tableCellView(boolCell("fill"), {
      readings: readings({ state: "unresolved" }),
      textColor: TEXT,
    });
    expect(unresolved).toMatchObject({
      text: presentScreenBool(boolCell().boolDisplay!, {
        state: "unresolved",
      }).text,
      state: "unresolved",
      textFill: "#0f172a",
      rectFill: UNKNOWN,
    });
    const number = tableCellView(boolCell(), {
      readings: readings({
        state: "resolved",
        quality: "good",
        numericValue: 1,
      }),
      textColor: TEXT,
    });
    expect(number).toMatchObject({
      state: "typeMismatch",
      textFill: UNKNOWN,
      rectFill: "#f1f5f9",
    });
    // A Good number tag is not a Good bool: the tooltip says why, not "Good".
    expect(number.title).toMatch(/ · 型不一致$/);
    expect(unresolved.title).toMatch(
      new RegExp(` · ${slotPresentation("unresolved").label}$`),
    );
    expect(tableCellView(boolCell(), { textColor: TEXT }).state).toBe(
      "disconnected",
    );
  });
  it("paints a symbol slot cell's state color and falls back to the cell fill without one", () => {
    const cell: TableCell = {
      ...stateCell,
      fill: "#e2e8f0",
      stateTarget: "fill",
    };
    const on = tableCellView(cell, {
      slots: () => ({
        display: good({ type: "bool", value: true }, "true"),
        slot: boolSlot,
      }),
      textColor: TEXT,
    });
    expect(on).toMatchObject({
      rectFill: run.color,
      textFill: TEXT,
      stateFill: true,
    });
    const uncolored = tableCellView(cell, {
      slots: () => ({
        display: good({ type: "bool", value: true }, "true"),
        slot: { name: "running", type: "bool", direction: "read" },
      }),
      textColor: TEXT,
    });
    expect(uncolored).toMatchObject({ rectFill: "#e2e8f0", stateFill: true });
    const unbound = tableCellView(cell, { textColor: TEXT });
    expect(unbound).toMatchObject({ rectFill: UNKNOWN, textFill: TEXT });
  });
  it("ignores the state target on a slot cell without state colors", () => {
    const view = tableCellView(
      { text: "", fill: "#e2e8f0", slotBinding: { slotName: "current" } },
      {
        slots: () => ({
          display: slotPresentation("unbound"),
          slot: numberSlot,
        }),
        textColor: TEXT,
      },
    );
    expect(view.stateFill).toBe(false);
  });
});
