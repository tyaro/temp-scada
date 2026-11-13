import { describe, expect, it } from "vitest";
import type { EquipmentSlot } from "./equipment";
import type { TableCell } from "./project";
import type { SlotProvenance } from "./read-slot-session";
import {
  slotPresentation,
  type SlotPresentation,
  type SlotValue,
} from "./slot-presentation";
import { tableCellSlotView } from "./table-cell-slot";

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
