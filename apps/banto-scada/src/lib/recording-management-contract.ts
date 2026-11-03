/** Pure read-only contract; no service, native projection, auth or writer control. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-management.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import planSchema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import { ownHistoryJson, freezeHistory } from "./history/owned-json";
import { blankJsonText, scalarJson } from "./json-text";
import { parseRecordingPlan } from "./recording-plan";
import { recordingPlanKey } from "./recording-plan-comparison";
import { databaseConsistent } from "./recording-management/semantic";
import type {
  RecordingManagementDocument,
  RecordingManagementContext,
  RecordingInspectionRequest,
  RecordingInspectionResponse,
  DesiredAppliedComparison,
} from "./recording-management/types";
export type * from "./recording-management/types";

export const MAX_RECORDING_MANAGEMENT_JSON_BYTES = 128 * 1024;
export const MAX_RECORDING_MANAGEMENT_JSON_NODES = 4096;
export const MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES = 1024 * 1024;
export const MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES = 16384;
const validateSchema = new Ajv2020({ strictNumbers: true })
  .addSchema(historySchema)
  .addSchema(planSchema)
  .compile<RecordingManagementDocument>(schema);
function small(value: unknown): void {
  ownHistoryJson(
    value,
    MAX_RECORDING_MANAGEMENT_JSON_BYTES,
    MAX_RECORDING_MANAGEMENT_JSON_NODES,
  );
}
function check(input: unknown): RecordingManagementDocument {
  // Read only a data descriptor to select the initial copy budget; never invoke a getter.
  const response =
    input !== null &&
    typeof input === "object" &&
    Object.getOwnPropertyDescriptor(input, "kind")?.value ===
      "recordingInspectionResponse";
  const value = ownHistoryJson(
    input,
    response
      ? MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES
      : MAX_RECORDING_MANAGEMENT_JSON_BYTES,
    response
      ? MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES
      : MAX_RECORDING_MANAGEMENT_JSON_NODES,
  );
  if (!scalarJson(value) || !validateSchema(value)) throw Error("invalid");
  const request =
    value.kind === "recordingInspectionResponse" ? value.request : value;
  small(request);
  const context =
    request.kind === "recordingInspectionRequest" ? request.context : request;
  small(context);
  if (blankJsonText(context.projectId)) throw Error("invalid");
  if (value.kind === "recordingInspectionResponse") {
    if (!databaseConsistent(value.database)) throw Error("invalid");
    if (value.database.state === "available" && value.database.applied)
      parseRecordingPlan(value.database.applied.desired);
  }
  return freezeHistory(value);
}
export function parseRecordingManagementDocument(
  input: unknown,
): RecordingManagementDocument {
  try {
    return check(input);
  } catch {
    throw Error("Recording management: invalid");
  }
}
export function validateRecordingManagement(input: unknown): boolean {
  try {
    check(input);
    return true;
  } catch {
    return false;
  }
}
export function parseRecordingManagementContext(
  input: unknown,
): RecordingManagementContext {
  const value = parseRecordingManagementDocument(input);
  if (value.kind !== "recordingManagementContext")
    throw Error("Recording management: invalid");
  return value;
}
export function parseRecordingInspectionRequest(
  input: unknown,
): RecordingInspectionRequest {
  const value = parseRecordingManagementDocument(input);
  if (value.kind !== "recordingInspectionRequest")
    throw Error("Recording management: invalid");
  return value;
}
export function parseRecordingInspectionResponse(
  input: unknown,
): RecordingInspectionResponse {
  const value = parseRecordingManagementDocument(input);
  if (value.kind !== "recordingInspectionResponse")
    throw Error("Recording management: invalid");
  return value;
}
/** Full echoed request equality, independent of JSON key order and number spelling.
 * Both inputs are validated and owned; invalid input throws the finite contract error. */
export function sameRecordingInspectionRequest(
  a: unknown,
  b: unknown,
): boolean {
  const left = parseRecordingInspectionRequest(a),
    right = parseRecordingInspectionRequest(b);
  return (
    left.requestId === right.requestId &&
    left.context.contextId === right.context.contextId &&
    left.context.projectId === right.context.projectId &&
    left.context.projectRevision === right.context.projectRevision &&
    left.context.deploymentId === right.context.deploymentId &&
    left.context.storeId === right.context.storeId &&
    left.context.historianNamespace === right.context.historianNamespace
  );
}
/** undefined means no local desired. null and malformed inputs throw, never classify
 * as absent. This comparison does not authorize an operation or renumber a plan. */
export function compareDesiredApplied(
  local: unknown,
  response: unknown,
): DesiredAppliedComparison {
  const desired = local === undefined ? undefined : parseRecordingPlan(local);
  const { database } = parseRecordingInspectionResponse(response);
  if (database.state === "unavailable")
    return Object.freeze({ kind: "unavailable" });
  const applied = database.applied?.desired;
  if (!desired)
    return Object.freeze({ kind: applied ? "localAbsent" : "absent" });
  if (!applied) return Object.freeze({ kind: "notApplied" });
  if (desired.planId !== applied.planId)
    return Object.freeze({ kind: "differentPlan" });
  const sameContent =
    recordingPlanKey(desired, true) === recordingPlanKey(applied, true);
  return Object.freeze(
    desired.revision === applied.revision
      ? { kind: sameContent ? "matches" : "sameRevisionConflict" }
      : {
          kind:
            desired.revision > applied.revision ? "localNewer" : "localOlder",
          sameContent,
        },
  );
}
