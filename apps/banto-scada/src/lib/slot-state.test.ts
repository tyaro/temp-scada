import { describe, expect, it } from "vitest";
import type { EquipmentSlot } from "./equipment";
import type { SlotProvenance } from "./read-slot-session";
import {
  slotPresentation,
  type SlotPresentation,
  type SlotValue,
} from "./slot-presentation";
import { evaluateSlotState } from "./slot-state";

const provenance: SlotProvenance = {
  catalogRevision: 3,
  runId: 7,
  collectionMode: "configured",
  valueSource: "real",
  sourceTimestampMs: 1234,
};
const good = (
  value: SlotValue,
  source: SlotProvenance = provenance,
): SlotPresentation => ({
  state: "good",
  label: "Good",
  // Deliberately misleading: evaluation must never depend on formatted text.
  text: "SIM · 1",
  value,
  provenance: { ...source },
});
const word = (value: number) => good({ type: "number", value });

const run = { text: "運転", color: "#16a34a" };
const stop = { text: "停止", color: "#64748b" };
const fault = { text: "故障", color: "#dc2626" };
const other = { text: "?", color: "#a855f7" };

const valueSlot: EquipmentSlot = {
  name: "mode",
  type: "state",
  direction: "read",
  stateDisplay: {
    source: "value",
    rows: [
      { match: 0, ...stop },
      { match: 1, ...run },
      { match: -1, ...fault },
    ],
    otherwise: other,
  },
};
const bitsSlot: EquipmentSlot = {
  name: "status",
  type: "state",
  direction: "read",
  stateDisplay: {
    source: "bits",
    // Fault (bit 2) is listed first, so it wins over run (bit 0).
    rows: [
      { match: 2, ...fault },
      { match: 0, ...run },
      { match: 31, ...stop },
    ],
    otherwise: other,
  },
};
const boolSlot: EquipmentSlot = {
  name: "running",
  type: "bool",
  direction: "read",
  boolDisplay: { true: run, false: stop },
};

describe("state slot by value", () => {
  it.each([
    [0, stop, 0],
    [1, run, 1],
    [-1, fault, 2],
  ])("matches word %s to its row", (value, label, row) => {
    expect(evaluateSlotState(valueSlot, word(value))).toEqual({
      state: "known",
      ...label,
      row,
      simulated: false,
    });
  });
  it("uses otherwise when no row matches", () => {
    expect(evaluateSlotState(valueSlot, word(7))).toEqual({
      state: "known",
      ...other,
      simulated: false,
    });
  });
});

describe("state slot by bits", () => {
  it("shows the first matching row from the top", () => {
    expect(evaluateSlotState(bitsSlot, word(0b101))).toMatchObject({
      ...fault,
      row: 0,
    });
    expect(evaluateSlotState(bitsSlot, word(0b001))).toMatchObject({
      ...run,
      row: 1,
    });
  });
  it("reads bit 31 of an unsigned and a signed word", () => {
    expect(evaluateSlotState(bitsSlot, word(2 ** 31))).toMatchObject({
      row: 2,
    });
    expect(evaluateSlotState(bitsSlot, word(-(2 ** 31)))).toMatchObject({
      row: 2,
    });
    // -1 has every bit set, so the top row wins.
    expect(evaluateSlotState(bitsSlot, word(-1))).toMatchObject({ row: 0 });
  });
  it("ignores bits above 31", () => {
    expect(evaluateSlotState(bitsSlot, word(2 ** 32))).toEqual({
      state: "known",
      ...other,
      simulated: false,
    });
  });
  it("uses otherwise for zero", () => {
    expect(evaluateSlotState(bitsSlot, word(0))).toMatchObject({
      ...other,
      state: "known",
    });
  });
});

describe("unknown values", () => {
  it.each([0.5, 2 ** 53, -(2 ** 53), Number.NaN, Number.POSITIVE_INFINITY])(
    "never evaluates the word %s",
    (value) => {
      for (const slot of [valueSlot, bitsSlot])
        expect(evaluateSlotState(slot, word(value))).toEqual({
          state: "unknown",
          reason: "invalid",
          text: slotPresentation("invalid").text,
          simulated: false,
        });
    },
  );
  it.each(["stale", "bad", "disconnected", "unresolved", "unbound"] as const)(
    "treats %s quality as unknown",
    (state) => {
      expect(evaluateSlotState(valueSlot, slotPresentation(state))).toEqual({
        state: "unknown",
        reason: state,
        text: slotPresentation(state).text,
        simulated: false,
      });
    },
  );
  it("does not coerce a bool reading into a state word", () => {
    expect(
      evaluateSlotState(valueSlot, good({ type: "bool", value: true })),
    ).toMatchObject({ state: "unknown", reason: "typeMismatch" });
  });
  it("does not coerce a number reading into a bool", () => {
    expect(evaluateSlotState(boolSlot, word(1))).toMatchObject({
      state: "unknown",
      reason: "typeMismatch",
    });
  });
});

describe("unassigned slots", () => {
  it("is unknown unless the type allows it", () => {
    expect(
      evaluateSlotState(bitsSlot, slotPresentation("unassigned")),
    ).toMatchObject({ state: "unknown", reason: "unassigned" });
  });
  it("reads as otherwise for an allowed state slot", () => {
    expect(
      evaluateSlotState(
        { ...bitsSlot, allowUnassigned: true },
        slotPresentation("unassigned"),
      ),
    ).toEqual({ state: "known", ...other, none: true, simulated: false });
  });
  it("reads as false for an allowed bool slot", () => {
    expect(
      evaluateSlotState(
        { ...boolSlot, allowUnassigned: true },
        slotPresentation("unassigned"),
      ),
    ).toEqual({ state: "known", ...stop, none: true, simulated: false });
  });
  it("does not hide other unavailable states", () => {
    expect(
      evaluateSlotState(
        { ...boolSlot, allowUnassigned: true },
        slotPresentation("disconnected"),
      ),
    ).toMatchObject({ state: "unknown", reason: "disconnected" });
  });
});

describe("bool slots", () => {
  it.each([
    [true, run],
    [false, stop],
  ])("uses the bool label for %s", (value, label) => {
    expect(evaluateSlotState(boolSlot, good({ type: "bool", value }))).toEqual({
      state: "known",
      ...label,
      simulated: false,
    });
  });
  it("falls back to plain text without boolDisplay", () => {
    const plain: EquipmentSlot = { ...boolSlot, boolDisplay: undefined };
    expect(
      evaluateSlotState(plain, good({ type: "bool", value: true })),
    ).toEqual({ state: "known", text: "true", simulated: false });
  });
});

it("marks simulated readings", () => {
  expect(
    evaluateSlotState(
      valueSlot,
      good(
        { type: "number", value: 1 },
        { ...provenance, valueSource: "simulation" },
      ),
    ),
  ).toMatchObject({ state: "known", ...run, simulated: true });
});

it("has no state for a number slot", () => {
  expect(
    evaluateSlotState(
      { name: "flow", type: "number", direction: "read" },
      word(1),
    ),
  ).toBeUndefined();
});
