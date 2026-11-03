/** Pure operation JSON only. No owner registry, service, transport or mutation. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-operations.schema.json";
import managementSchema from "../../../../crates/scada-model/schema/recording-management.schema.json";
import planSchema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import { ownHistoryJson, freezeHistory } from "./history/owned-json";
import { scalarJson } from "./json-text";
import { parseRecordingManagementContext } from "./recording-management-contract";
import { parseRecordingPlan } from "./recording-plan";
import {
  applyConsistent,
  operationConsistent,
  reconciliationConsistent,
} from "./recording-operations/semantic";
import type {
  RecordingOperationsDocument,
  RecordingOperationsContext,
  RecordingChangeRequest,
  RecordingOperationRequest,
  RecordingOperationResult,
  RecordingReconciliationRequest,
  RecordingReconciliationResult,
} from "./recording-operations/types";
export type * from "./recording-operations/types";
export const MAX_RECORDING_OPERATIONS_JSON_BYTES = 128 * 1024;
export const MAX_RECORDING_OPERATIONS_JSON_NODES = 4096;
export const MAX_RECORDING_OPERATION_RESULT_JSON_BYTES = 256 * 1024;
export const MAX_RECORDING_OPERATION_RESULT_JSON_NODES = 8192;
const validateSchema = new Ajv2020({ strictNumbers: true })
  .addSchema(historySchema)
  .addSchema(planSchema)
  .addSchema(managementSchema)
  .compile<RecordingOperationsDocument>(schema);
function small(value: unknown): void {
  ownHistoryJson(
    value,
    MAX_RECORDING_OPERATIONS_JSON_BYTES,
    MAX_RECORDING_OPERATIONS_JSON_NODES,
  );
}
function check(input: unknown): RecordingOperationsDocument {
  const kind =
    input !== null && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "kind")?.value
      : undefined;
  const result =
    kind === "recordingOperationResult" ||
    kind === "recordingReconciliationResult";
  const value = ownHistoryJson(
    input,
    result
      ? MAX_RECORDING_OPERATION_RESULT_JSON_BYTES
      : MAX_RECORDING_OPERATIONS_JSON_BYTES,
    result
      ? MAX_RECORDING_OPERATION_RESULT_JSON_NODES
      : MAX_RECORDING_OPERATIONS_JSON_NODES,
  );
  if (!scalarJson(value) || !validateSchema(value)) throw Error("invalid");
  let nested: RecordingOperationsDocument = value;
  if (nested.kind === "recordingReconciliationResult") nested = nested.request;
  if (nested.kind === "recordingReconciliationRequest") {
    small(nested);
    if (nested.operation.stage !== "apply") throw Error("invalid");
    nested = nested.operation;
  }
  if (nested.kind === "recordingOperationResult") nested = nested.request;
  if (nested.kind === "recordingOperationRequest") {
    small(nested);
    nested = nested.change;
  }
  if (nested.kind === "recordingChangeRequest") {
    small(nested);
    parseRecordingPlan(nested.apply.desired);
    if (!applyConsistent(nested.apply)) throw Error("invalid");
    nested = nested.context;
  }
  small(nested);
  parseRecordingManagementContext(nested.target);
  if (value.kind === "recordingOperationResult" && !operationConsistent(value))
    throw Error("invalid");
  if (
    value.kind === "recordingReconciliationResult" &&
    !reconciliationConsistent(value)
  )
    throw Error("invalid");
  return freezeHistory(value);
}
export function parseRecordingOperationsDocument(
  input: unknown,
): RecordingOperationsDocument {
  try {
    return check(input);
  } catch {
    throw Error("Recording operations: invalid");
  }
}
export function validateRecordingOperations(input: unknown): boolean {
  try {
    check(input);
    return true;
  } catch {
    return false;
  }
}
export function parseRecordingOperationsContext(
  input: unknown,
): RecordingOperationsContext {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingOperationsContext")
    throw Error("Recording operations: invalid");
  return value;
}
export function parseRecordingChangeRequest(
  input: unknown,
): RecordingChangeRequest {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingChangeRequest")
    throw Error("Recording operations: invalid");
  return value;
}
export function parseRecordingOperationRequest(
  input: unknown,
): RecordingOperationRequest {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingOperationRequest")
    throw Error("Recording operations: invalid");
  return value;
}
export function parseRecordingOperationResult(
  input: unknown,
): RecordingOperationResult {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingOperationResult")
    throw Error("Recording operations: invalid");
  return value;
}
export function parseRecordingReconciliationRequest(
  input: unknown,
): RecordingReconciliationRequest {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingReconciliationRequest")
    throw Error("Recording operations: invalid");
  return value;
}
export function parseRecordingReconciliationResult(
  input: unknown,
): RecordingReconciliationResult {
  const value = parseRecordingOperationsDocument(input);
  if (value.kind !== "recordingReconciliationResult")
    throw Error("Recording operations: invalid");
  return value;
}
/** Validated owned JSON: ignore key order and number spelling, preserve array order.
 * This is full request equality, not H5a's member-order-independent meaning comparison. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameJson(v, b[i]))
    );
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && sameJson(left[k], right[k]))
  );
}
/** Both inputs are validated; malformed input throws, never compares as an empty request. */
export function sameRecordingOperationsContext(
  a: unknown,
  b: unknown,
): boolean {
  return sameJson(
    parseRecordingOperationsContext(a),
    parseRecordingOperationsContext(b),
  );
}
export function sameRecordingChangeRequest(a: unknown, b: unknown): boolean {
  return sameJson(
    parseRecordingChangeRequest(a),
    parseRecordingChangeRequest(b),
  );
}
export function sameRecordingOperationRequest(a: unknown, b: unknown): boolean {
  return sameJson(
    parseRecordingOperationRequest(a),
    parseRecordingOperationRequest(b),
  );
}
export function sameRecordingReconciliationRequest(
  a: unknown,
  b: unknown,
): boolean {
  return sameJson(
    parseRecordingReconciliationRequest(a),
    parseRecordingReconciliationRequest(b),
  );
}
