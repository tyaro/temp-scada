import { ownHistoryJson, freezeHistory } from "../history/owned-json";
import {
  parseRecordingOperationsContext,
  parseRecordingOperationResult,
} from "../recording-operations-contract";
import {
  parseRecordingAdmissionReply,
  parseRecordingReconciliationDelivery,
} from "../recording-admission-contract";
import { operationErrorCode } from "../recording-operations/service";
import { data } from "../recording-operations/view";
import type {
  LocalLeaseReply,
  LocalCancelReply,
  LocalOwnerFrame,
} from "./port";
export function fields(v: unknown, keys: readonly string[]): void {
  if (!v || typeof v !== "object" || Reflect.ownKeys(v).length !== keys.length)
    throw Error("invalid local metadata");
  keys.forEach((k) => data(v, k));
}
export function id(v: unknown): asserts v is string {
  if (
    typeof v !== "string" ||
    v.length > 64 ||
    /[^A-Za-z0-9._:-]/.test(v) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)
  )
    throw Error("invalid ID");
}
function meta(v: unknown): any {
  return ownHistoryJson(v, 128 * 1024, 4096, "localMetadata");
}
export function parseLeaseReply(input: unknown): LocalLeaseReply {
  const v = meta(input);
  fields(v, ["request", "outcome"]);
  fields(v.request, [
    "ownerRef",
    "admissionId",
    "context",
    "requestedBudgetMs",
  ]);
  id(v.request.ownerRef);
  id(v.request.admissionId);
  parseRecordingOperationsContext(v.request.context);
  if (
    !Number.isSafeInteger(v.request.requestedBudgetMs) ||
    v.request.requestedBudgetMs < 1 ||
    v.request.requestedBudgetMs > 10000
  )
    throw Error("invalid budget");
  if (v.outcome.kind === "issued") {
    fields(v.outcome, ["kind", "deadlineLeaseRef"]);
    id(v.outcome.deadlineLeaseRef);
  } else {
    fields(v.outcome, ["kind", "error"]);
    if (v.outcome.kind !== "rejected" || !operationErrorCode(v.outcome.error))
      throw Error("invalid lease");
  }
  return freezeHistory(v);
}
export function parseCancelReply(input: unknown): LocalCancelReply {
  const v = meta(input);
  fields(v, ["request", "disposition"]);
  fields(v.request, ["ownerRef", "target"]);
  id(v.request.ownerRef);
  fields(v.request.target, ["kind", "ref"]);
  id(v.request.target.ref);
  if (
    !["operation", "reconciliation"].includes(v.request.target.kind) ||
    !["requested", "alreadyCompleted", "notSupported"].includes(v.disposition)
  )
    throw Error("invalid cancel");
  return freezeHistory(v);
}
export function parseOwnerFrame(input: unknown): LocalOwnerFrame {
  const v = ownHistoryJson(input, 1024 * 1024, 32768, "localFrame") as any;
  fields(v, [
    "ownerRef",
    "context",
    "revision",
    "connected",
    "admission",
    "operation",
    "reconciliation",
    "ownerBlocked",
  ]);
  id(v.ownerRef);
  parseRecordingOperationsContext(v.context);
  if (
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    typeof v.connected !== "boolean" ||
    typeof v.ownerBlocked !== "boolean"
  )
    throw Error("invalid frame");
  if (v.admission !== null) parseRecordingAdmissionReply(v.admission);
  if (v.operation !== null) {
    fields(v.operation, ["operationRef", "result"]);
    id(v.operation.operationRef);
    parseRecordingOperationResult(v.operation.result);
  }
  if (v.reconciliation !== null)
    parseRecordingReconciliationDelivery(v.reconciliation);
  return freezeHistory(v);
}
/** Require a genuine same-realm Promise, not a user-defined thenable. */
export function onPromise(
  input: unknown,
  yes: (v: unknown) => void,
  no: () => void,
): void {
  if (!(input instanceof Promise)) throw Error("invalid Promise");
  Promise.prototype.then.call(input, yes, no);
}
