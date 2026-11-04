/** Pure asynchronous admission JSON. No transport, lease issuer, registry or service. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-admission.schema.json";
import operationsSchema from "../../../../crates/scada-model/schema/recording-operations.schema.json";
import managementSchema from "../../../../crates/scada-model/schema/recording-management.schema.json";
import planSchema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import { ownHistoryJson, freezeHistory } from "./history/owned-json";
import { sameOwnedJson } from "./json-equality";
import { checkDocument } from "./recording-admission/semantic";
import { checkCapacity } from "./recording-admission/capacity";
import type {
  RecordingAdmissionDocument,
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingAdmissionInspectionReply,
  RecordingReconciliationDelivery,
} from "./recording-admission/types";
export type * from "./recording-admission/types";
export const MAX_RECORDING_ADMISSION_JSON_BYTES = 512 * 1024;
export const MAX_RECORDING_ADMISSION_JSON_NODES = 16384;
export const MAX_RECORDING_ADMISSION_JSON_DEPTH = 48;
const validateSchema = new Ajv2020({ strictNumbers: true })
  .addSchema(historySchema)
  .addSchema(planSchema)
  .addSchema(managementSchema)
  .addSchema(operationsSchema)
  .compile<RecordingAdmissionDocument>(schema);
export function parseRecordingAdmissionDocument(
  input: unknown,
): RecordingAdmissionDocument {
  try {
    const owned = ownHistoryJson(
      input,
      MAX_RECORDING_ADMISSION_JSON_BYTES,
      MAX_RECORDING_ADMISSION_JSON_NODES,
      "admission",
    );
    if (!validateSchema(owned)) throw Error("invalid");
    checkDocument(owned);
    return freezeHistory(owned);
  } catch {
    throw Error("Recording admission: invalid");
  }
}
export function validateRecordingAdmission(input: unknown): boolean {
  try {
    parseRecordingAdmissionDocument(input);
    return true;
  } catch {
    return false;
  }
}
function parseKind<K extends RecordingAdmissionDocument["kind"]>(
  input: unknown,
  kind: K,
): Extract<RecordingAdmissionDocument, { kind: K }> {
  const value = parseRecordingAdmissionDocument(input);
  if (value.kind !== kind) throw Error("Recording admission: invalid");
  return value as Extract<RecordingAdmissionDocument, { kind: K }>;
}
export const parseRecordingAdmissionRequest = (
  input: unknown,
): RecordingAdmissionRequest => parseKind(input, "recordingAdmissionRequest");
export const parseRecordingAdmissionReply = (
  input: unknown,
): RecordingAdmissionReply => parseKind(input, "recordingAdmissionReply");
export const parseRecordingAdmissionInspectionRequest = (
  input: unknown,
): RecordingAdmissionInspectionRequest =>
  parseKind(input, "recordingAdmissionInspectionRequest");
export const parseRecordingAdmissionInspectionReply = (
  input: unknown,
): RecordingAdmissionInspectionReply =>
  parseKind(input, "recordingAdmissionInspectionReply");
export const parseRecordingReconciliationDelivery = (
  input: unknown,
): RecordingReconciliationDelivery =>
  parseKind(input, "recordingReconciliationDelivery");
/** Capacity is already mandatory in parsing. This explicit guard also validates input. */
export function validateRecordingAdmissionReplyCapacity(
  input: unknown,
): boolean {
  try {
    checkCapacity(parseRecordingAdmissionRequest(input));
    return true;
  } catch {
    return false;
  }
}
export function sameRecordingAdmissionRequest(a: unknown, b: unknown): boolean {
  return sameOwnedJson(
    parseRecordingAdmissionRequest(a),
    parseRecordingAdmissionRequest(b),
  );
}
export function sameRecordingAdmissionInspectionRequest(
  a: unknown,
  b: unknown,
): boolean {
  return sameOwnedJson(
    parseRecordingAdmissionInspectionRequest(a),
    parseRecordingAdmissionInspectionRequest(b),
  );
}
export function recordingAdmissionReplyMatchesRequest(
  reply: unknown,
  request: unknown,
): boolean {
  return sameOwnedJson(
    parseRecordingAdmissionReply(reply).request,
    parseRecordingAdmissionRequest(request),
  );
}
export function recordingAdmissionInspectionReplyMatchesRequest(
  reply: unknown,
  request: unknown,
): boolean {
  return sameOwnedJson(
    parseRecordingAdmissionInspectionReply(reply).request,
    parseRecordingAdmissionInspectionRequest(request),
  );
}
/** Correlates these two documents only; never establishes global opaque ownership. */
export function recordingReconciliationDeliveryMatchesAdmission(
  delivery: unknown,
  reply: unknown,
): boolean {
  const d = parseRecordingReconciliationDelivery(delivery),
    r = parseRecordingAdmissionReply(reply);
  return (
    r.request.action.kind === "reconcile" &&
    r.outcome.kind === "accepted" &&
    r.outcome.handle.kind === "reconciliation" &&
    d.ownerRef === r.request.ownerRef &&
    d.readRef === r.outcome.handle.readRef &&
    sameOwnedJson(d.request, r.outcome.handle.request)
  );
}
