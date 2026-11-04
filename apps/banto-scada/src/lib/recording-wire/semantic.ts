/** This module receives only schema-validated owned JSON. */
import {
  parseRecordingOperationsContext,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
} from "../recording-operations-contract";
import {
  parseRecordingAdmissionDocument,
  parseRecordingAdmissionReply,
  parseRecordingReconciliationDelivery,
} from "../recording-admission-contract";
import { sameOwnedJson } from "../json-equality";
import { WIRE_LIMITS, measureWire } from "./budget";
import type {
  RecordingWireDocument,
  RecordingWireOwnerSnapshot,
  RecordingWireScope,
} from "./types";
function require(ok: boolean) {
  if (!ok) throw Error("wire semantic");
}
function scope(value: RecordingWireScope) {
  parseRecordingOperationsContext(value.context);
}
function legacyContext(value: any) {
  if (value.kind === "recordingOperationRequest") return value.change.context;
  if (value.kind === "recordingReconciliationRequest")
    return value.operation.change.context;
  throw Error("invalid legacy target");
}
function admissionScope(s: RecordingWireScope, value: any) {
  const v =
    value.kind === "recordingAdmissionReply"
      ? value.request
      : value.kind === "recordingAdmissionInspectionReply"
        ? value.request.original
        : value.kind === "recordingAdmissionInspectionRequest"
          ? value.original
          : value;
  require(v.ownerRef === s.ownerRef && sameOwnedJson(v.context, s.context));
}
function deliveryScope(s: RecordingWireScope, d: any) {
  require(
    d.ownerRef === s.ownerRef &&
      sameOwnedJson(d.request.operation.change.context, s.context),
  );
}
function snapshot(v: RecordingWireOwnerSnapshot) {
  measureWire(v, WIRE_LIMITS.snapshot, "wireSnapshot");
  scope(v.scope);
  if (v.admission) {
    parseRecordingAdmissionReply(v.admission);
    admissionScope(v.scope, v.admission);
  }
  if (v.operation) {
    parseRecordingOperationResult(v.operation.result);
    require(
      sameOwnedJson(v.scope.context, v.operation.result.request.change.context),
    );
  }
  if (v.reconciliation) {
    parseRecordingReconciliationDelivery(v.reconciliation);
    deliveryScope(v.scope, v.reconciliation);
  }
  const h =
    v.admission?.outcome.kind === "accepted"
      ? v.admission.outcome.handle
      : undefined;
  if (h?.kind === "operation" && v.operation?.operationRef === h.operationRef)
    require(sameOwnedJson(v.operation.result.request, h.request));
  if (h?.kind === "reconciliation" && v.reconciliation?.readRef === h.readRef)
    require(sameOwnedJson(v.reconciliation.request, h.request));
}
export function checkDocument(
  v: RecordingWireDocument,
  nested: (v: unknown) => unknown,
): void {
  switch (v.kind) {
    case "recordingWireLeaseRequest":
    case "recordingWireCancelRequest":
    case "recordingWireAttachRequest":
    case "recordingWireControlRequest":
    case "recordingWireControlFrame":
      scope(v.scope);
      break;
    case "recordingWireLeaseReply":
      nested(v.request);
      if (v.outcome.kind === "issued")
        require(v.outcome.grantedBudgetMs <= v.request.requestedBudgetMs);
      break;
    case "recordingWireCancelReply":
      nested(v.request);
      break;
    case "recordingWireObservationRequest":
      scope(v.scope);
      if (v.target.kind === "operation")
        parseRecordingOperationRequest(v.target.request);
      else parseRecordingReconciliationRequest(v.target.request);
      require(sameOwnedJson(v.scope.context, legacyContext(v.target.request)));
      break;
    case "recordingWireObservationReply": {
      nested(v.request);
      const t = v.request.target,
        o = v.outcome;
      if (o.kind === "operation") {
        parseRecordingOperationResult(o.result);
        require(
          t.kind === "operation" && sameOwnedJson(o.result.request, t.request),
        );
      }
      if (o.kind === "reconciliation") {
        parseRecordingReconciliationDelivery(o.delivery);
        deliveryScope(v.request.scope, o.delivery);
        require(
          t.kind === "reconciliation" &&
            o.delivery.readRef === t.readRef &&
            sameOwnedJson(o.delivery.request, t.request),
        );
      }
      break;
    }
    case "recordingWireAttachReply":
      nested(v.request);
      if (v.outcome.kind === "attached") {
        snapshot(v.outcome.snapshot);
        require(sameOwnedJson(v.request.scope, v.outcome.snapshot.scope));
        require(
          v.request.afterRevision === null ||
            v.outcome.snapshot.revision >= v.request.afterRevision,
        );
      }
      break;
    case "recordingWireStateFrame":
      snapshot(v.snapshot);
      break;
    case "recordingWireControlReply":
      nested(v.request);
      if (v.outcome.kind === "detached") require(v.request.action === "detach");
      if (v.outcome.kind === "snapshot") {
        require(v.request.action === "snapshot");
        snapshot(v.outcome.snapshot);
        require(sameOwnedJson(v.request.scope, v.outcome.snapshot.scope));
      }
      break;
    case "recordingWireCallInspectionRequest": {
      scope(v.scope);
      const original = v.original;
      if (original.kind.startsWith("recordingWire")) {
        nested(original);
        require(sameOwnedJson((original as any).scope, v.scope));
      } else {
        parseRecordingAdmissionDocument(original);
        admissionScope(v.scope, original);
      }
      break;
    }
    case "recordingWireCallInspectionReply": {
      nested(v.request);
      if (v.outcome.kind !== "terminal") break;
      const r = v.outcome.reply;
      if (r.kind.startsWith("recordingWire")) nested(r);
      else parseRecordingAdmissionDocument(r);
      require(
        r.kind === v.request.original.kind.replace(/Request$/, "Reply") &&
          sameOwnedJson(r.request, v.request.original),
      );
      break;
    }
  }
}
