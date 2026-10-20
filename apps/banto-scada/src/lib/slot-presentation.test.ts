import { expect, it } from "vitest";
import {
  boolSlotState,
  isSimulatedSlot,
  slotPresentation,
  type SlotPresentation,
  type SlotValue,
} from "./slot-presentation";
import type { SlotProvenance } from "./read-slot-session";

const provenance: SlotProvenance = {
  catalogRevision: 3,
  runId: 7,
  collectionMode: "configured",
  valueSource: "real",
  sourceTimestampMs: 1234,
};
const good = (value: SlotValue): SlotPresentation => ({
  state: "good",
  label: "Good",
  // Deliberately misleading: semantics must never depend on formatted text.
  text: "SIM · true",
  value,
  provenance: { ...provenance },
});

it.each([false, true])(
  "uses the typed bool %s, ignoring display text",
  (value) => {
    expect(boolSlotState(good({ type: "bool", value }))).toEqual({
      state: String(value),
      quality: "good",
      simulated: false,
      text: String(value),
      provenance,
    });
  },
);
it.each([0, 1, -1, 0.5])("never coerces numeric %s to a bool", (value) => {
  expect(boolSlotState(good({ type: "number", value }))).toMatchObject({
    state: "unknown",
    reason: "typeMismatch",
    quality: "good",
    text: "-- · slot型不一致",
  });
});
it.each([
  "unbound",
  "missingSlot",
  "typeMismatch",
  "unadopted",
  "unassigned",
  "disconnected",
  "unresolved",
  "invalid",
  "stale",
  "bad",
] as const)("preserves %s as unknown without a false fallback", (reason) => {
  const input = slotPresentation(reason);
  expect(boolSlotState(input)).toEqual({
    state: "unknown",
    reason,
    quality: reason,
    simulated: false,
    text: input.text,
  });
  expect(input).not.toHaveProperty("value");
});
it.each([
  "real",
  "simulation",
  "computed",
  "derived_simulation",
  "internal",
  "db",
] as const)(
  "uses provenance for SIM independently of bool/Quality: %s",
  (valueSource) => {
    for (const collectionMode of ["configured", "all_simulation"] as const) {
      const origin = { ...provenance, valueSource, collectionMode };
      const simulated =
        collectionMode === "all_simulation" ||
        valueSource === "simulation" ||
        valueSource === "derived_simulation";
      expect(isSimulatedSlot(origin)).toBe(simulated);
      for (const value of [true, false]) {
        const result = boolSlotState({
          ...good({ type: "bool", value }),
          provenance: origin,
        });
        expect(result.simulated).toBe(simulated);
        expect(result.text).toBe(`${simulated ? "SIM · " : ""}${value}`);
      }
      for (const state of ["bad", "stale"] as const) {
        const result = boolSlotState({
          ...slotPresentation(state),
          provenance: origin,
        });
        expect(result.state).toBe("unknown");
        expect(result.simulated).toBe(simulated);
        expect(result.text.startsWith("SIM · ")).toBe(simulated);
        expect(result.provenance).toEqual(origin);
        expect(result.provenance).not.toBe(origin);
      }
    }
  },
);
it("retains invalid details and returns an independent provenance snapshot", () => {
  expect(boolSlotState(slotPresentation("invalid", "disabled"))).toMatchObject({
    state: "unknown",
    reason: "invalid",
    detail: "disabled",
  });
  const input = good({ type: "bool", value: false });
  const result = boolSlotState(input);
  result.provenance!.valueSource = "db";
  expect(input.provenance!.valueSource).toBe("real");
  expect(isSimulatedSlot()).toBe(false);
});
it.each([
  undefined,
  { type: "bool", value: "false" },
  { type: "number", value: Infinity },
])("fails closed for malformed internal Good value %j", (value) => {
  expect(
    boolSlotState({
      ...good({ type: "bool", value: false }),
      value,
    } as SlotPresentation),
  ).toMatchObject({
    state: "unknown",
    reason: "invalid",
    quality: "good",
  });
});
