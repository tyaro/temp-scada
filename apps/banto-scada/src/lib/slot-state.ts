import type { EquipmentSlot, SlotStateLabel } from "./equipment";
import {
  isSimulatedSlot,
  slotPresentation,
  type SlotPresentation,
  type SlotStatus,
} from "./slot-presentation";

type UnavailableStatus = Exclude<SlotStatus, "good">;

/**
 * The display state of a `bool` or `state` slot under its equipment-type
 * definition. `row` is the index of the matched state row; it is absent for a
 * bool slot and for the `otherwise` label. `none` marks an unassigned slot that
 * the type allows to be unassigned (read as false / otherwise, not an error).
 */
export type SlotStateEvaluation = { simulated: boolean } & (
  | {
      state: "known";
      text: string;
      /** Absent only for a bool slot without `boolDisplay`. */
      color?: string;
      row?: number;
      none?: true;
      reason?: never;
    }
  | {
      state: "unknown";
      text: string;
      reason: UnavailableStatus;
      color?: never;
      row?: never;
      none?: never;
    }
);

function known(
  label: SlotStateLabel | { text: string; color?: never },
  simulated: boolean,
  extra: { row?: number; none?: true } = {},
): SlotStateEvaluation {
  return {
    state: "known",
    text: label.text,
    ...(label.color === undefined ? {} : { color: label.color }),
    ...extra,
    simulated,
  };
}

function unknown(
  reason: UnavailableStatus,
  simulated: boolean,
): SlotStateEvaluation {
  return {
    state: "unknown",
    reason,
    text: slotPresentation(reason).text,
    simulated,
  };
}

/** Bit 0-31 of a safe integer; negatives use two's complement. */
function bitSet(value: number, bit: number): boolean {
  return ((BigInt.asUintN(64, BigInt(value)) >> BigInt(bit)) & 1n) === 1n;
}

function boolLabel(slot: EquipmentSlot, value: boolean) {
  return (
    slot.boolDisplay?.[value ? "true" : "false"] ?? {
      text: value ? "true" : "false",
    }
  );
}

/**
 * Pure evaluation of a resolved slot reading against the slot's definition.
 * Only Good readings are evaluated; any other quality is unknown, except an
 * unassigned slot with `allowUnassigned`. A state word must be a safe integer
 * (|v| < 2^53). A `number` slot has no state definition and returns undefined.
 */
export function evaluateSlotState(
  slot: EquipmentSlot,
  reading: SlotPresentation,
): SlotStateEvaluation | undefined {
  if (slot.type === "number") return undefined;
  const simulated = isSimulatedSlot(reading.provenance);
  if (reading.state === "unassigned" && slot.allowUnassigned) {
    if (slot.type === "bool")
      return known(boolLabel(slot, false), false, { none: true });
    if (!slot.stateDisplay) return unknown("invalid", false);
    return known(slot.stateDisplay.otherwise, false, { none: true });
  }
  if (reading.state !== "good") return unknown(reading.state, simulated);
  const value = reading.value;
  if (slot.type === "bool") {
    if (value.type !== "bool")
      return unknown(
        Number.isFinite(value.value) ? "typeMismatch" : "invalid",
        simulated,
      );
    return known(boolLabel(slot, value.value), simulated);
  }
  if (value.type !== "number") return unknown("typeMismatch", simulated);
  const display = slot.stateDisplay;
  if (!display || !Number.isSafeInteger(value.value))
    return unknown("invalid", simulated);
  const row = display.rows.findIndex((candidate) =>
    display.source === "bits"
      ? candidate.match >= 0 &&
        candidate.match <= 31 &&
        bitSet(value.value, candidate.match)
      : candidate.match === value.value,
  );
  return row < 0
    ? known(display.otherwise, simulated)
    : known(display.rows[row], simulated, { row });
}
