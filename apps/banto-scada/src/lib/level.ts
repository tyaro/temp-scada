import type { LevelShape } from "./project";
import { isSimulatedSlot, type SlotPresentation } from "./slot-presentation";
import {
  formatNumber,
  presentNumeric,
  type NumericReading,
} from "./tag-presentation";

/** Limits must be finite with `min < max`; the schema cannot express it. */
export function validateLevelShape(shape: LevelShape) {
  if (
    !Number.isFinite(shape.min) ||
    !Number.isFinite(shape.max) ||
    !(shape.min < shape.max)
  )
    throw new Error("液位の下限は上限より小さくしてください");
}

/**
 * What a level shows. Only a Good value inside the limits fills the bar;
 * an unavailable or out-of-range value leaves it empty and is marked, so a
 * stale or clipped value never looks like a real level.
 */
export type LevelDisplay = {
  /** Text for the title and the screen summary. */
  description: string;
  simulated: boolean;
} & (
  | { state: "good"; fraction: number }
  | { state: "low" | "high"; fraction?: never }
  | { state: "unavailable"; label: string; fraction?: never }
);

function fromValue(
  shape: Pick<LevelShape, "min" | "max">,
  value: number,
  simulated: boolean,
): LevelDisplay {
  const prefix = simulated ? "SIM · " : "";
  const range = `${formatNumber(shape.min)}〜${formatNumber(shape.max)}`;
  if (value < shape.min || value > shape.max)
    return {
      state: value < shape.min ? "low" : "high",
      simulated,
      description: `${prefix}${formatNumber(value)} · 範囲外（${range}）`,
    };
  return {
    state: "good",
    simulated,
    fraction: (value - shape.min) / (shape.max - shape.min),
    description: `${prefix}${formatNumber(value)}（${range}）`,
  };
}

function unavailable(label: string, simulated = false): LevelDisplay {
  return {
    state: "unavailable",
    label,
    simulated,
    description: `-- · ${label}`,
  };
}

/** A screen level bound to a tag (or unbound, which reads as 未接続). */
export function levelFromReading(
  shape: Pick<LevelShape, "min" | "max">,
  reading?: NumericReading,
): LevelDisplay {
  const presentation = presentNumeric(reading);
  if (presentation.state !== "good" || reading?.state !== "resolved")
    return unavailable(presentation.label);
  return fromValue(
    shape,
    reading.numericValue!,
    isSimulatedSlot(presentation.provenance),
  );
}

/** A level inside a shared Symbol bound to a number slot. */
export function levelFromSlot(
  shape: Pick<LevelShape, "min" | "max">,
  display: SlotPresentation,
): LevelDisplay {
  if (display.state !== "good") return unavailable(display.label);
  if (display.value.type !== "number" || !Number.isFinite(display.value.value))
    return unavailable("値が不正");
  return fromValue(
    shape,
    display.value.value,
    isSimulatedSlot(display.provenance),
  );
}

/** The filled rectangle for a fraction, growing upward or rightward. */
export function levelFillRect(
  width: number,
  height: number,
  direction: LevelShape["direction"],
  fraction: number,
) {
  const f = Math.min(1, Math.max(0, fraction));
  return direction === "up"
    ? { x: 0, y: height * (1 - f), width, height: height * f }
    : { x: 0, y: 0, width: width * f, height };
}
