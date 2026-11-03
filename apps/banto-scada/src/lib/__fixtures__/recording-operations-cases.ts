// Test recipes only; never imported by App or production validators.
import operationsFixtures from "../../../../../examples/recording-operations-cases.json";
import {
  recordingPlanCaseInput,
  type RecordingPlanCase,
} from "./recording-plan-cases";
import type { ManagementCase } from "./recording-management-cases";
export { operationsFixtures };
export function operationCaseInput(row: ManagementCase): any {
  if (row.json !== undefined) return JSON.parse(row.json);
  if (row.build) return recordingPlanCaseInput(row as RecordingPlanCase);
  const value = structuredClone(
    (operationsFixtures.bases as Record<string, unknown>)[row.base],
  );
  for (const patch of row.patch ?? []) {
    const parts = patch.path.slice(1).split("/");
    let target: any = value;
    for (const key of parts.slice(0, -1)) target = target[key];
    const key = parts.at(-1)!;
    if (patch.remove) delete target[key];
    else target[key] = structuredClone(patch.value);
  }
  return value;
}
export const desiredBases = [
  "change",
  "operation",
  "result",
  "reconciliation",
  "reconciliationResult",
] as const;
export function nestedOperationPlan(base: string, input: unknown): any {
  const value = operationCaseInput({ name: base, base });
  let op = value;
  if (op.kind === "recordingReconciliationResult") op = op.request;
  if (op.kind === "recordingReconciliationRequest") op = op.operation;
  if (op.kind === "recordingOperationResult") op = op.request;
  const change = op.kind === "recordingOperationRequest" ? op.change : op;
  change.apply.desired = input;
  const desired =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const enabled = desired.enabled === true;
  change.apply.expectedMappingRevision = enabled ? 11 : null;
  change.apply.expectedRetentionAppliedRevision = enabled ? 13 : null;
  const receipt = value.outcome?.receipt;
  if (receipt) {
    receipt.desiredPlanId = desired.planId ?? null;
    receipt.desiredRevision = desired.revision ?? null;
    receipt.enabled = enabled;
    receipt.mappingRevision = change.apply.expectedMappingRevision;
    receipt.retentionAppliedRevision =
      change.apply.expectedRetentionAppliedRevision;
  }
  return value;
}
export function nestedOperationTarget(input: unknown): any {
  const context = operationCaseInput({ name: "target", base: "context" });
  context.target = input;
  return context;
}
