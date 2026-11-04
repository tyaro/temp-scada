import operationsSchema from "../../../../../crates/scada-model/schema/recording-operations.schema.json";
import { ownHistoryJson } from "../history/owned-json";
import { validateRecordingOperations } from "../recording-operations-contract";
import type { RecordingAdmissionRequest } from "./types";
const longestError = operationsSchema.$defs.error.enum.reduce((a, b) =>
  a.length >= b.length ? a : b,
);
const id = "r".repeat(64);
/** Independent, conservative outer accounting. Run only on bounded owned JSON. */
export function admissionBudget(value: unknown): void {
  ownHistoryJson(value, 512 * 1024, 16384, "admission");
}
/** Budget closure only; never calls the public admission parser recursively. */
export function checkCapacity(
  request: RecordingAdmissionRequest,
  check: (value: unknown) => void = admissionBudget,
): void {
  const inspection = {
    version: 1,
    kind: "recordingAdmissionInspectionRequest",
    inspectionId: id,
    original: request,
  };
  check(inspection);
  const action = request.action;
  let success: unknown;
  switch (action.kind) {
    case "preflight": {
      const operation = {
        version: 1,
        kind: "recordingOperationRequest",
        operationId: id,
        stage: "preflight",
        change: action.change,
      };
      if (!validateRecordingOperations(operation)) throw Error("invalid");
      success = {
        kind: "accepted",
        handle: {
          kind: "operation",
          changeRef: id,
          operationRef: id,
          request: operation,
        },
      };
      break;
    }
    case "pauseJoin":
    case "apply":
      success = {
        kind: "accepted",
        handle: {
          kind: "operation",
          changeRef: id,
          operationRef: id,
          request: action.operation,
        },
      };
      break;
    case "reconcile":
      success = {
        kind: "accepted",
        handle: {
          kind: "reconciliation",
          readRef: id,
          request: action.reconciliation,
        },
      };
      break;
    case "discard":
      success = { kind: "completedDiscard" };
      break;
  }
  for (const outcome of [
    success,
    { kind: "rejected", error: longestError },
    { kind: "unknown", error: longestError },
  ]) {
    const reply = {
      version: 1,
      kind: "recordingAdmissionReply",
      request,
      outcome,
    };
    check(reply);
    check({
      version: 1,
      kind: "recordingAdmissionInspectionReply",
      request: inspection,
      outcome: { kind: "found", reply },
    });
  }
  for (const outcome of [
    { kind: "notFound" },
    { kind: "unavailable", error: longestError },
  ])
    check({
      version: 1,
      kind: "recordingAdmissionInspectionReply",
      request: inspection,
      outcome,
    });
}
