/** Shared Node/Chromium scenario driver for the pure Observation ledger. */
import raw from "../../../../../examples/recording-wire-observation-ledger-cases.json";
import { createRecordingWireDeliveryLedger } from "../recording-wire-delivery-ledger";
import { parseRecordingWireObservationReply } from "../recording-wire-contract";
import {
  cloneDelivery as clone,
  deliveryFixtures,
  deliveryRequest,
} from "./recording-wire-delivery-ledger-cases";
import { wireFixtures } from "./recording-wire-cases";

export const observationLedgerCases = raw as {
  scenarios: {
    name: string;
    base: "operation" | "reconciliation";
    steps: ("pending" | "terminal" | "unavailable")[];
  }[];
};

export function runObservationLedgerScenario(
  scenario: (typeof observationLedgerCases.scenarios)[number],
) {
  const made = createRecordingWireDeliveryLedger(deliveryFixtures.scope);
  if (!made.ok) throw Error("factory");
  const ledger = made.value;
  const reconciliation = scenario.base === "reconciliation";
  const request = clone(
    wireFixtures.bases[reconciliation ? "read" : "observe"],
  );
  const terminal = clone(
    wireFixtures.bases[reconciliation ? "readReply" : "observationReply"],
  );
  const admission = deliveryRequest(reconciliation ? "readAdmit" : "admit");
  if (!reconciliation)
    admission.action = {
      kind: "apply",
      changeRef: "change-ref",
      operation: clone(request.target.request),
    };
  const handle = reconciliation
    ? {
        kind: "reconciliation",
        readRef: request.target.readRef,
        request: clone(request.target.request),
      }
    : {
        kind: "operation",
        changeRef: "change-ref",
        operationRef: request.target.operationRef,
        request: clone(request.target.request),
      };
  const accepted = {
    version: 1,
    kind: "recordingAdmissionReply",
    request: clone(admission),
    outcome: { kind: "accepted", handle },
  };
  const original = ledger.beginOriginal(admission);
  if (!original.ok || !ledger.acceptOriginal(original.value, accepted).ok)
    throw Error("admission");
  const target = ledger.bindObservationTarget(original.value);
  if (!target.ok) throw Error("target");
  const query = ledger.beginObservation(target.value, request);
  if (!query.ok) throw Error("query");
  let attempt = query.value.attempt;
  for (const [index, step] of scenario.steps.entries()) {
    if (index > 0) {
      const next = ledger.repeatObservation(query.value.query);
      if (!next.ok) throw Error("repeat");
      attempt = next.value;
    }
    const reply =
      step === "terminal"
        ? terminal
        : {
            version: 1,
            kind: "recordingWireObservationReply",
            request: clone(request),
            outcome:
              step === "pending"
                ? { kind: "pending" }
                : { kind: "unavailable", error: "ownerUnavailable" },
          };
    parseRecordingWireObservationReply(reply);
    const acceptedReply = ledger.acceptObservation(attempt, reply);
    if (!acceptedReply.ok || !acceptedReply.value.attemptStored)
      throw Error("reply");
  }
  const state = ledger.observation(query.value.query);
  const targetState = ledger.observationTarget(target.value);
  if (!state.ok || !targetState.ok) throw Error("state");
  const last = scenario.steps.at(-1);
  if (
    state.value.terminal?.outcome.kind !==
    (last === "terminal" ? scenario.base : last)
  )
    throw Error("terminal");
  if ((targetState.value.result !== null) !== (last === "terminal"))
    throw Error("result");
  return {
    attempts: ledger.current().usage.observationAttempts,
    terminal: state.value.terminal?.outcome.kind,
    result: targetState.value.result,
  };
}
