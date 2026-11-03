/** Keep opaque references and methods intact; own only the bounded JSON fields. */
import {
  parseRecordingChangeRequest,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
  parseRecordingReconciliationResult,
  sameRecordingChangeRequest,
  sameRecordingOperationRequest,
  sameRecordingOperationsContext,
  type RecordingOperationsContext,
  type RecordingOperationResult,
  type AppliedReceipt,
} from "../recording-operations-contract";
import type {
  RecordingOperationOwnerView,
  OperationHandle,
  ChangeHandle,
  ReconciliationHandle,
  OperationOwnerPhase,
  AppliedSuccess,
} from "./service";
export const stages = { preflight: 0, pauseJoin: 1, apply: 2 } as const;
export function data(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object")
    throw Error("invalid service");
  const desc = Object.getOwnPropertyDescriptor(value, key);
  if (!desc || !("value" in desc)) throw Error("invalid service");
  return desc.value;
}
function record(value: unknown, keys: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw Error("invalid service");
  keys.forEach((key) => data(value, key));
}
function token(value: unknown): object {
  if (value === null || typeof value !== "object")
    throw Error("invalid service");
  return value;
}
export function changeHandle(input: unknown): ChangeHandle {
  record(input, ["opaqueChange"]);
  token(data(input, "opaqueChange"));
  return input as ChangeHandle;
}
export function operationHandle(input: unknown): OperationHandle {
  record(input, ["opaqueOperation", "request", "completion", "requestCancel"]);
  token(data(input, "opaqueOperation"));
  const request = parseRecordingOperationRequest(data(input, "request"));
  const completion = data(input, "completion"),
    cancel = data(input, "requestCancel");
  if (!(completion instanceof Promise) || typeof cancel !== "function")
    throw Error("invalid service");
  // Return a captured facade; raw handle identity is retained by the caller.
  return Object.freeze({
    opaqueOperation: data(input, "opaqueOperation") as object,
    request,
    completion,
    requestCancel: cancel as OperationHandle["requestCancel"],
  });
}
export function reconciliationHandle(input: unknown): ReconciliationHandle {
  record(input, ["request", "completion", "requestCancel"]);
  const request = parseRecordingReconciliationRequest(data(input, "request")),
    completion = data(input, "completion"),
    cancel = data(input, "requestCancel");
  if (!(completion instanceof Promise) || typeof cancel !== "function")
    throw Error("invalid service");
  return Object.freeze({
    request,
    completion,
    requestCancel: cancel as ReconciliationHandle["requestCancel"],
  });
}
export function appliedSuccess(input: unknown): AppliedSuccess {
  record(input, ["request", "receipt"]);
  const result = parseRecordingOperationResult({
    version: 1,
    kind: "recordingOperationResult",
    request: data(input, "request"),
    outcome: { kind: "applied", receipt: data(input, "receipt") },
    quiescence: "confirmed",
    recoveryRequired: false,
  });
  if (result.outcome.kind !== "applied") throw Error("invalid");
  return Object.freeze({
    request: result.request,
    receipt: result.outcome.receipt,
  });
}
export function ownerView(
  input: unknown,
  context: RecordingOperationsContext,
): RecordingOperationOwnerView {
  record(input, [
    "change",
    "request",
    "phase",
    "active",
    "latest",
    "reconciling",
    "lastReconciliation",
    "lastApplied",
  ]);
  const phase = data(input, "phase");
  if (
    ![
      "idle",
      "preflighting",
      "candidate",
      "pausing",
      "paused",
      "applying",
      "completed",
      "blocked",
      "uncertain",
    ].includes(phase as string)
  )
    throw Error("invalid service");
  const rawRequest = data(input, "request"),
    rawChange = data(input, "change"),
    rawActive = data(input, "active");
  const request =
    rawRequest === null ? null : parseRecordingChangeRequest(rawRequest);
  const change = rawChange === null ? null : changeHandle(rawChange);
  const active = rawActive === null ? null : operationHandle(rawActive);
  const rawLatest = data(input, "latest"),
    rawRecon = data(input, "reconciling"),
    rawLastRecon = data(input, "lastReconciliation"),
    rawApplied = data(input, "lastApplied");
  const latest =
    rawLatest === null ? null : parseRecordingOperationResult(rawLatest);
  const reconciling = rawRecon === null ? null : reconciliationHandle(rawRecon);
  const lastReconciliation =
    rawLastRecon === null
      ? null
      : parseRecordingReconciliationResult(rawLastRecon);
  const lastApplied = rawApplied === null ? null : appliedSuccess(rawApplied);
  if (request === null) {
    if (
      change !== null ||
      active !== null ||
      latest !== null ||
      reconciling !== null ||
      lastReconciliation !== null ||
      phase !== "idle"
    )
      throw Error("invalid service");
  } else {
    if (
      change === null ||
      active === null ||
      !sameRecordingOperationsContext(request.context, context) ||
      !sameRecordingChangeRequest(request, active.request.change)
    )
      throw Error("invalid service");
    if (phase === "idle") throw Error("invalid service");
    if (
      latest &&
      (!sameRecordingChangeRequest(latest.request.change, request) ||
        stages[latest.request.stage] > stages[active.request.stage])
    )
      throw Error("invalid service");
    if (
      reconciling &&
      !sameRecordingOperationRequest(
        reconciling.request.operation,
        active.request,
      )
    )
      throw Error("invalid service");
    if (
      lastReconciliation &&
      !sameRecordingOperationRequest(
        lastReconciliation.request.operation,
        active.request,
      )
    )
      throw Error("invalid service");
    if (
      phase === "candidate" &&
      (active.request.stage !== "preflight" ||
        latest?.outcome.kind !== "candidate")
    )
      throw Error("invalid service");
    if (
      phase === "paused" &&
      (active.request.stage !== "pauseJoin" ||
        latest?.outcome.kind !== "paused")
    )
      throw Error("invalid service");
    if (
      (phase === "preflighting" && active.request.stage !== "preflight") ||
      (phase === "pausing" && active.request.stage !== "pauseJoin") ||
      (phase === "applying" && active.request.stage !== "apply")
    )
      throw Error("invalid service");
    if (
      phase === "completed" &&
      (!latest ||
        latest.quiescence !== "confirmed" ||
        latest.recoveryRequired ||
        latest.outcome.kind === "candidate" ||
        latest.outcome.kind === "paused")
    )
      throw Error("invalid service");
  }
  return Object.freeze({
    change,
    request,
    phase: phase as OperationOwnerPhase,
    active: rawActive as OperationHandle | null,
    latest,
    reconciling: rawRecon as ReconciliationHandle | null,
    lastReconciliation,
    lastApplied,
  });
}
export function receiptKey(r: AppliedReceipt): string {
  return JSON.stringify([
    r.requestId,
    r.appliedRevision,
    r.commitVersion,
    r.desiredPlanId,
    r.desiredRevision,
    r.desiredHash,
    r.resolvedConfigHash,
    r.plan.planId,
    r.plan.revision,
    r.mappingRevision,
    r.retentionAppliedRevision,
    r.enabled,
  ]);
}
/** Merge compatible historical completion and current-view evidence. A definitive
 * rollback cannot coexist with a receipt. Neither input is mutated. */
export function mergeResult(
  old: RecordingOperationResult | undefined,
  next: RecordingOperationResult,
): RecordingOperationResult {
  if (!old) return next;
  if (!sameRecordingOperationRequest(old.request, next.request))
    throw Error("invalid service");
  const a = old.outcome,
    b = next.outcome;
  let outcome = next.outcome;
  if (a.kind === "applied" || b.kind === "applied") {
    if (
      a.kind === "applied" &&
      b.kind === "applied" &&
      receiptKey(a.receipt) !== receiptKey(b.receipt)
    )
      throw Error("invalid service");
    const other = a.kind === "applied" ? b : a;
    if (
      other.kind !== "applied" &&
      (other.kind !== "failed" || other.effect !== "unconfirmed")
    )
      throw Error("invalid service");
    outcome = a.kind === "applied" ? a : b;
  } else if (canonical(a) !== canonical(b)) {
    // Immutable non-apply completion has one outcome, not a new preflight.
    throw Error("invalid service");
  }
  return parseRecordingOperationResult({
    ...next,
    outcome,
    quiescence:
      old.quiescence === "confirmed" || next.quiescence === "confirmed"
        ? "confirmed"
        : "unknown",
    recoveryRequired: old.recoveryRequired || next.recoveryRequired,
  });
}

/** Already validated bounded JSON only; member array order remains significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
