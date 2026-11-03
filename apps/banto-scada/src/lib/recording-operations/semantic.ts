import type {
  AppliedReceipt,
  PlanApplyRequest,
  RecordingOperationResult,
  RecordingReconciliationResult,
} from "./types";
/** Only schema-validated structured values reach these checks. No DB/auth proof. */
export function applyConsistent(apply: PlanApplyRequest): boolean {
  return [
    apply.expectedMappingRevision,
    apply.expectedRetentionAppliedRevision,
  ].every((bound) => apply.desired.enabled === (bound !== null));
}
function receiptConsistent(
  receipt: AppliedReceipt,
  apply: PlanApplyRequest,
): boolean {
  const expected = apply.expectedAppliedRevision;
  return (
    expected !== Number.MAX_SAFE_INTEGER &&
    receipt.appliedRevision === (expected === null ? 1 : expected + 1) &&
    receipt.plan.revision === receipt.appliedRevision &&
    receipt.requestId === apply.requestId &&
    receipt.desiredPlanId === apply.desired.planId &&
    receipt.desiredRevision === apply.desired.revision &&
    receipt.enabled === apply.desired.enabled &&
    receipt.mappingRevision === apply.expectedMappingRevision &&
    receipt.retentionAppliedRevision === apply.expectedRetentionAppliedRevision
  );
}
export function operationConsistent(result: RecordingOperationResult): boolean {
  const { outcome, request, quiescence, recoveryRequired } = result;
  if (quiescence === "unknown" && !recoveryRequired) return false;
  if (outcome.kind === "failed") {
    if (quiescence === "unknown" && outcome.effect !== "unconfirmed")
      return false;
    if (outcome.effect === "notDispatched" && quiescence !== "confirmed")
      return false;
    if (request.stage === "pauseJoin" && outcome.effect === "notCommitted")
      return false;
    return !(
      request.stage === "apply" &&
      outcome.effect !== "notDispatched" &&
      !recoveryRequired
    );
  }
  if (
    outcome.kind !== "applied" &&
    (quiescence !== "confirmed" || recoveryRequired)
  )
    return false;
  switch (outcome.kind) {
    case "candidate":
      return (
        request.stage === "preflight" &&
        request.change.apply.expectedAppliedRevision !==
          Number.MAX_SAFE_INTEGER &&
        (outcome.activeSessionId === null ||
          outcome.activeSessionId === request.change.context.sessionId)
      );
    case "paused":
      return (
        request.stage === "pauseJoin" &&
        outcome.sessionId === request.change.context.sessionId
      );
    case "replay":
      return (
        request.stage === "preflight" &&
        outcome.receipt.commitVersion <= outcome.snapshotCommit &&
        receiptConsistent(outcome.receipt, request.change.apply)
      );
    case "applied":
      return (
        request.stage === "apply" &&
        receiptConsistent(outcome.receipt, request.change.apply)
      );
  }
}
export function reconciliationConsistent(
  result: RecordingReconciliationResult,
): boolean {
  return (
    !(result.quiescence === "unknown" && !result.recoveryRequired) &&
    (result.outcome.kind !== "receiptFound" ||
      receiptConsistent(
        result.outcome.receipt,
        result.request.operation.change.apply,
      ))
  );
}
