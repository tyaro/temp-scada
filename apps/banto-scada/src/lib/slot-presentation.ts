import type { SlotProvenance } from "./read-slot-session";

export type SlotValue =
  | Readonly<{ type: "bool"; value: boolean }>
  | Readonly<{ type: "number"; value: number }>;
export type SlotStatus =
  | "unbound"
  | "missingSlot"
  | "typeMismatch"
  | "unadopted"
  | "unassigned"
  | "disconnected"
  | "unresolved"
  | "invalid"
  | "good"
  | "stale"
  | "bad";
type UnavailableStatus = Exclude<SlotStatus, "good">;
const labels: Record<UnavailableStatus, string> = {
  unbound: "機器未関連付け",
  missingSlot: "機器種別にslotなし",
  typeMismatch: "slot型不一致",
  unadopted: "未採用",
  unassigned: "未割付",
  disconnected: "未接続",
  unresolved: "未解決",
  invalid: "値が不正",
  stale: "Stale",
  bad: "Bad",
};
export type SlotPresentation = {
  label: string;
  text: string;
} & (
  | {
      state: "good";
      value: SlotValue;
      provenance: SlotProvenance;
      reason?: never;
    }
  | {
      state: UnavailableStatus;
      value?: never;
      provenance?: SlotProvenance;
      reason?: string;
    }
);

/** A Good result must be constructed with a typed value and its provenance. */
export function slotPresentation(
  state: UnavailableStatus,
  reason?: string,
): SlotPresentation {
  return {
    state,
    label: labels[state],
    text: `-- · ${labels[state]}`,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function isSimulatedSlot(provenance?: SlotProvenance): boolean {
  return !!(
    provenance &&
    (provenance.collectionMode === "all_simulation" ||
      provenance.valueSource === "simulation" ||
      provenance.valueSource === "derived_simulation")
  );
}

export type BoolSlotState = {
  simulated: boolean;
  text: string;
  provenance?: SlotProvenance;
} & (
  | { state: "true" | "false"; quality: "good"; reason?: never; detail?: never }
  | {
      state: "unknown";
      /** Original status; a number is not relabelled Bad. */
      quality: SlotStatus;
      reason: UnavailableStatus;
      detail?: string;
    }
);

/** No string parsing, truthiness, last-value cache, or equipment/session lookup. */
export function boolSlotState(display: SlotPresentation): BoolSlotState {
  const simulated = isSimulatedSlot(display.provenance);
  const origin = display.provenance
    ? { provenance: { ...display.provenance } }
    : {};
  if (
    display.state === "good" &&
    display.value?.type === "bool" &&
    typeof display.value.value === "boolean"
  ) {
    const state = display.value.value ? "true" : "false";
    return {
      state,
      quality: display.state,
      simulated,
      text: simulated ? `SIM · ${state}` : state,
      ...origin,
    };
  }
  const reason =
    display.state !== "good"
      ? display.state
      : display.value?.type === "number" && Number.isFinite(display.value.value)
        ? "typeMismatch"
        : "invalid";
  const text = slotPresentation(reason).text;
  return {
    state: "unknown",
    reason,
    quality: display.state,
    simulated,
    text: simulated ? `SIM · ${text}` : text,
    ...(display.reason === undefined ? {} : { detail: display.reason }),
    ...origin,
  };
}
