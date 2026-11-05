/** Existing owned validators and capacity profiles, not a second schema. */
import {
  parseRecordingWireDocument,
  parseRecordingWireLeaseReply,
  parseRecordingWireCancelReply,
  parseRecordingWireCallInspectionRequest,
  recordingWireReplyCapacity,
} from "../recording-wire-contract";
import {
  parseRecordingAdmissionDocument,
  parseRecordingAdmissionReply,
  parseRecordingAdmissionInspectionReply,
} from "../recording-admission-contract";
import { measureWire, wireProfile } from "../recording-wire/budget";
import { ownMeasuredHistoryJson } from "../history/owned-json";
import { sameOwnedJson } from "../json-equality";
import type { RecordingWireScope } from "../recording-wire-contract";
import { requireLedger, type Pool } from "./core";
import type { OriginalRequest, OriginalReply } from "./types";
export function originalRequest(input: unknown): OriginalRequest {
  const kind =
    input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "kind")?.value
      : undefined;
  requireLedger(
    typeof kind === "string" && kind.length <= 80,
    "invalidRequest",
  );
  const q = kind.startsWith("recordingWire")
    ? parseRecordingWireDocument(input)
    : parseRecordingAdmissionDocument(input);
  switch (q.kind) {
    case "recordingWireLeaseRequest":
    case "recordingWireCancelRequest":
    case "recordingAdmissionRequest":
    case "recordingAdmissionInspectionRequest":
      return q;
    default:
      throwUnsupported();
  }
}
function throwUnsupported(): never {
  requireLedger(false, "unsupportedKind");
}
export function originalReply(
  q: OriginalRequest,
  input: unknown,
): OriginalReply {
  switch (q.kind) {
    case "recordingWireLeaseRequest":
      return parseRecordingWireLeaseReply(input);
    case "recordingWireCancelRequest":
      return parseRecordingWireCancelReply(input);
    case "recordingAdmissionRequest":
      return parseRecordingAdmissionReply(input);
    case "recordingAdmissionInspectionRequest":
      return parseRecordingAdmissionInspectionReply(input);
  }
}
export function matchesScope(
  scope: RecordingWireScope,
  q: OriginalRequest,
): boolean {
  if ("scope" in q) return sameOwnedJson(scope, q.scope);
  const v = q.kind === "recordingAdmissionInspectionRequest" ? q.original : q;
  return (
    v.ownerRef === scope.ownerRef && sameOwnedJson(v.context, scope.context)
  );
}
export function bytes(
  value:
    | OriginalRequest
    | OriginalReply
    | import("../recording-wire-contract").RecordingWireCallInspectionRequest,
): number {
  if (!value.kind.startsWith("recordingWire"))
    return ownMeasuredHistoryJson(value, 512 * 1024, 16384, "admission").bytes;
  const p = wireProfile(value.kind);
  return measureWire(value, p.limit, p.accounting).bytes;
}
export function key(q: OriginalRequest): string {
  const id =
    q.kind === "recordingWireLeaseRequest"
      ? q.leaseRequestId
      : q.kind === "recordingWireCancelRequest"
        ? q.cancelId
        : q.kind === "recordingAdmissionRequest"
          ? q.admissionId
          : q.inspectionId;
  return q.kind + ":" + id;
}
export function pool(q: OriginalRequest): Pool {
  return q.kind === "recordingWireLeaseRequest"
    ? q.role === "mutation"
      ? "mutation"
      : "read"
    : q.kind === "recordingAdmissionRequest"
      ? q.action.kind === "reconcile"
        ? "read"
        : "mutation"
      : "read";
}
export function reservation(scope: RecordingWireScope, q: OriginalRequest) {
  const R =
    q.kind === "recordingWireLeaseRequest" ||
    q.kind === "recordingWireCancelRequest"
      ? recordingWireReplyCapacity(q).reply.bytes
      : 512 * 1024;
  const query = parseRecordingWireCallInspectionRequest({
    version: 1,
    kind: "recordingWireCallInspectionRequest",
    scope,
    callInspectionId: "r".repeat(64),
    original: q,
  });
  return { Q: bytes(q), R, I: bytes(query) };
}
