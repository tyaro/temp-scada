import type { EquipmentSlot } from "./equipment";
import type { TextBoolDisplay } from "./project";
import type { SlotProvenance } from "./read-slot-session";
import { slotPresentation, type SlotPresentation } from "./slot-presentation";
import {
  evaluateSlotState,
  slotStateText,
  type SlotStateEvaluation,
} from "./slot-state";
import type { NumericReading } from "./tag-presentation";

/** A Good reading without a recorded origin is a real one, never simulated. */
const NO_PROVENANCE: SlotProvenance = {
  catalogRevision: 0,
  runId: null,
  collectionMode: "configured",
  valueSource: "real",
  sourceTimestampMs: 0,
};

/**
 * A screen-level tag reading as a bool slot reading. Only a Good bit tag is a
 * Good bool; a Good number, a non-finite number and every other state keep
 * their own unavailable reason (a number is never read as a bool).
 */
export function readingAsBoolSlot(reading?: NumericReading): SlotPresentation {
  if (!reading) return slotPresentation("disconnected");
  if (reading.state !== "resolved") return slotPresentation(reading.state);
  const origin = reading.provenance ? { provenance: reading.provenance } : {};
  if (reading.quality !== "good")
    return { ...slotPresentation(reading.quality), ...origin };
  const provenance = reading.provenance ?? NO_PROVENANCE;
  if (reading.boolValue !== undefined)
    return {
      state: "good",
      label: "Good",
      text: String(reading.boolValue),
      value: { type: "bool", value: reading.boolValue },
      provenance,
    };
  if (
    reading.boolValue === undefined &&
    reading.numericValue !== null &&
    Number.isFinite(reading.numericValue)
  )
    return {
      state: "good",
      label: "Good",
      text: String(reading.numericValue),
      value: { type: "number", value: reading.numericValue },
      provenance,
    };
  return slotPresentation("invalid");
}

export interface ScreenBoolPresentation {
  evaluation: SlotStateEvaluation;
  text: string;
  /** The definition's color for a known bool, `unknownColor` for anything else. */
  color: string;
}

/**
 * Evaluates a screen Text's `boolDisplay` with the bool slot rule (A2). A
 * reading that is not a Good bool shows its reason and `unknownColor`; a
 * previous or false color is never substituted.
 */
export function presentScreenBool(
  display: TextBoolDisplay,
  reading?: NumericReading,
): ScreenBoolPresentation {
  const slot: EquipmentSlot = {
    name: "",
    type: "bool",
    direction: "read",
    boolDisplay: { true: display.true, false: display.false },
  };
  const evaluation = evaluateSlotState(slot, readingAsBoolSlot(reading))!;
  return {
    evaluation,
    text: slotStateText(evaluation),
    color:
      evaluation.state === "known"
        ? (evaluation.color ?? display.unknownColor)
        : display.unknownColor,
  };
}
