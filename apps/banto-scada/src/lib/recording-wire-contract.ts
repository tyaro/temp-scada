/** Pure wire JSON only. No registry, lease issuance, authentication or I/O. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-wire.schema.json";
import admission from "../../../../crates/scada-model/schema/recording-admission.schema.json";
import operations from "../../../../crates/scada-model/schema/recording-operations.schema.json";
import management from "../../../../crates/scada-model/schema/recording-management.schema.json";
import plan from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import history from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import { freezeHistory } from "./history/owned-json";
import { sameOwnedJson } from "./json-equality";
import { wireProfile, measureWire } from "./recording-wire/budget";
import { checkCapacity } from "./recording-wire/capacity";
import { checkDocument } from "./recording-wire/semantic";
import type {
  RecordingWireDocument,
  RecordingWireRequest,
} from "./recording-wire/types";
export type * from "./recording-wire/types";
export { WIRE_LIMITS } from "./recording-wire/budget";
const validateSchema = new Ajv2020({ strictNumbers: true })
  .addSchema(history)
  .addSchema(plan)
  .addSchema(management)
  .addSchema(operations)
  .addSchema(admission)
  .compile<RecordingWireDocument>(schema);
const kinds = new Set(
  schema.oneOf.map((r) => {
    const def = r.$ref.split("/").at(-1)!;
    return (schema.$defs as any)[def].properties.kind.const as string;
  }),
);
function checked(input: unknown): RecordingWireDocument {
  const k =
    input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "kind")?.value
      : undefined;
  if (typeof k !== "string" || k.length > 80 || !kinds.has(k))
    throw Error("invalid kind");
  const profile = wireProfile(k),
    owned = measureWire(input, profile.limit, profile.accounting).value;
  if (!validateSchema(owned)) throw Error("invalid shape");
  checkDocument(owned, checked);
  if (isRequest(owned)) checkCapacity(owned);
  return owned;
}
function isRequest(v: RecordingWireDocument): v is RecordingWireRequest {
  return v.kind.endsWith("Request");
}
export function parseRecordingWireDocument(
  input: unknown,
): RecordingWireDocument {
  try {
    return freezeHistory(checked(input));
  } catch {
    throw Error("Recording wire: invalid");
  }
}
export function validateRecordingWire(input: unknown): boolean {
  try {
    parseRecordingWireDocument(input);
    return true;
  } catch {
    return false;
  }
}
function parseKind<K extends RecordingWireDocument["kind"]>(
  input: unknown,
  kind: K,
): Extract<RecordingWireDocument, { kind: K }> {
  const v = parseRecordingWireDocument(input);
  if (v.kind !== kind) throw Error("Recording wire: invalid");
  return v as Extract<RecordingWireDocument, { kind: K }>;
}
export const parseRecordingWireLeaseRequest = (v: unknown) =>
  parseKind(v, "recordingWireLeaseRequest");
export const parseRecordingWireLeaseReply = (v: unknown) =>
  parseKind(v, "recordingWireLeaseReply");
export const parseRecordingWireObservationRequest = (v: unknown) =>
  parseKind(v, "recordingWireObservationRequest");
export const parseRecordingWireObservationReply = (v: unknown) =>
  parseKind(v, "recordingWireObservationReply");
export const parseRecordingWireCancelRequest = (v: unknown) =>
  parseKind(v, "recordingWireCancelRequest");
export const parseRecordingWireCancelReply = (v: unknown) =>
  parseKind(v, "recordingWireCancelReply");
export const parseRecordingWireAttachRequest = (v: unknown) =>
  parseKind(v, "recordingWireAttachRequest");
export const parseRecordingWireAttachReply = (v: unknown) =>
  parseKind(v, "recordingWireAttachReply");
export const parseRecordingWireStateFrame = (v: unknown) =>
  parseKind(v, "recordingWireStateFrame");
export const parseRecordingWireControlRequest = (v: unknown) =>
  parseKind(v, "recordingWireControlRequest");
export const parseRecordingWireControlReply = (v: unknown) =>
  parseKind(v, "recordingWireControlReply");
export const parseRecordingWireControlFrame = (v: unknown) =>
  parseKind(v, "recordingWireControlFrame");
export const parseRecordingWireCallInspectionRequest = (v: unknown) =>
  parseKind(v, "recordingWireCallInspectionRequest");
export const parseRecordingWireCallInspectionReply = (v: unknown) =>
  parseKind(v, "recordingWireCallInspectionReply");

export function sameRecordingWireRequest(a: unknown, b: unknown): boolean {
  const x = parseRecordingWireDocument(a),
    y = parseRecordingWireDocument(b);
  if (!isRequest(x) || !isRequest(y)) throw Error("Recording wire: invalid");
  return sameOwnedJson(x, y);
}
export function recordingWireReplyMatchesRequest(
  reply: unknown,
  request: unknown,
): boolean {
  const r = parseRecordingWireDocument(reply),
    q = parseRecordingWireDocument(request);
  return (
    isRequest(q) &&
    "request" in r &&
    r.kind === q.kind.replace(/Request$/, "Reply") &&
    sameOwnedJson(r.request, q)
  );
}
/** Known document correlation only, never authentication or global reference ownership. */
export function recordingWireFrameMatchesSubscription(
  frame: unknown,
  attach: unknown,
): boolean {
  const f = parseRecordingWireDocument(frame),
    a = parseRecordingWireDocument(attach);
  if (
    a.kind !== "recordingWireAttachReply" ||
    a.outcome.kind !== "attached" ||
    (f.kind !== "recordingWireStateFrame" &&
      f.kind !== "recordingWireControlFrame")
  )
    return false;
  return (
    f.subscriptionRef === a.outcome.subscriptionRef &&
    sameOwnedJson(
      f.kind === "recordingWireStateFrame" ? f.snapshot.scope : f.scope,
      a.request.scope,
    ) &&
    (f.kind !== "recordingWireStateFrame" ||
      f.snapshot.revision >= a.outcome.snapshot.revision)
  );
}
export function recordingWireReplyCapacity(input: unknown) {
  const v = parseRecordingWireDocument(input);
  if (!isRequest(v)) throw Error("Recording wire: invalid");
  return checkCapacity(v);
}
/** Prospective wrapper capacity only, without modifying legacy acceptance or performing lookup. */
export function recordingWireOriginalCapacity(
  scope: unknown,
  original: unknown,
) {
  return recordingWireReplyCapacity({
    version: 1,
    kind: "recordingWireCallInspectionRequest",
    scope,
    callInspectionId: "r".repeat(64),
    original,
  });
}
