import {
  parseRecordingOperationsContext,
  parseRecordingChangeRequest,
  parseRecordingOperationRequest,
  parseRecordingReconciliationRequest,
  parseRecordingReconciliationResult,
  sameRecordingOperationsContext,
  sameRecordingChangeRequest,
  sameRecordingOperationRequest,
  sameRecordingReconciliationRequest,
} from "../recording-operations-contract";
import type {
  RecordingAdmissionDocument,
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
} from "./types";
import { checkCapacity } from "./capacity";
import { sameOwnedJson } from "../json-equality";
function require(ok: boolean): void {
  if (!ok) throw Error("invalid");
}
function request(value: RecordingAdmissionRequest): void {
  parseRecordingOperationsContext(value.context);
  const action = value.action;
  let context;
  switch (action.kind) {
    case "preflight":
    case "discard":
      context = parseRecordingChangeRequest(action.change).context;
      break;
    case "pauseJoin":
    case "apply": {
      const operation = parseRecordingOperationRequest(action.operation);
      require(operation.stage === action.kind);
      context = operation.change.context;
      break;
    }
    case "reconcile":
      context = parseRecordingReconciliationRequest(action.reconciliation)
        .operation.change.context;
      break;
  }
  require(sameRecordingOperationsContext(value.context, context));
  checkCapacity(value);
}
function reply(value: RecordingAdmissionReply): void {
  request(value.request);
  const action = value.request.action,
    outcome = value.outcome;
  if (outcome.kind === "completedDiscard") {
    require(action.kind === "discard");
    return;
  }
  if (outcome.kind !== "accepted") return;
  const handle = outcome.handle;
  if (handle.kind === "operation")
    parseRecordingOperationRequest(handle.request);
  else parseRecordingReconciliationRequest(handle.request);
  switch (action.kind) {
    case "preflight":
      require(
        handle.kind === "operation" &&
          handle.request.stage === "preflight" &&
          sameRecordingChangeRequest(action.change, handle.request.change),
      );
      break;
    case "pauseJoin":
    case "apply":
      require(
        handle.kind === "operation" &&
          handle.changeRef === action.changeRef &&
          sameRecordingOperationRequest(action.operation, handle.request),
      );
      break;
    case "reconcile":
      require(
        handle.kind === "reconciliation" &&
          sameRecordingReconciliationRequest(
            action.reconciliation,
            handle.request,
          ),
      );
      break;
    case "discard":
      throw Error("invalid");
  }
}
export function checkDocument(value: RecordingAdmissionDocument): void {
  switch (value.kind) {
    case "recordingAdmissionRequest":
      request(value);
      break;
    case "recordingAdmissionReply":
      reply(value);
      break;
    case "recordingAdmissionInspectionRequest":
      request(value.original);
      break;
    case "recordingAdmissionInspectionReply":
      request(value.request.original);
      if (value.outcome.kind === "found") {
        reply(value.outcome.reply);
        require(
          sameOwnedJson(value.request.original, value.outcome.reply.request),
        );
      }
      break;
    case "recordingReconciliationDelivery":
      parseRecordingReconciliationRequest(value.request);
      if (value.outcome.kind === "result") {
        parseRecordingReconciliationResult(value.outcome.result);
        require(
          sameRecordingReconciliationRequest(
            value.request,
            value.outcome.result.request,
          ),
        );
      }
      break;
  }
}
