import type { RecordingManagementContext } from "../recording-management-contract";
import type { DesiredRecordingPlan } from "../recording-plan";
export interface RecordingOperationsContext {
  readonly version: 1;
  readonly kind: "recordingOperationsContext";
  readonly target: RecordingManagementContext;
  readonly capabilityId: string;
  readonly recordingRunRef: string;
  readonly sessionId: string;
}
export interface PlanApplyRequest {
  readonly requestId: string;
  readonly desired: DesiredRecordingPlan;
  readonly expectedAppliedRevision: number | null;
  readonly expectedMappingRevision: number | null;
  readonly expectedRetentionAppliedRevision: number | null;
}
export interface RecordingChangeRequest {
  readonly version: 1;
  readonly kind: "recordingChangeRequest";
  readonly changeId: string;
  readonly context: RecordingOperationsContext;
  readonly apply: PlanApplyRequest;
}
export interface RecordingOperationRequest {
  readonly version: 1;
  readonly kind: "recordingOperationRequest";
  readonly operationId: string;
  readonly stage: "preflight" | "pauseJoin" | "apply";
  readonly change: RecordingChangeRequest;
}
export interface AppliedReceipt {
  readonly requestId: string;
  readonly appliedRevision: number;
  readonly commitVersion: number;
  readonly desiredPlanId: string;
  readonly desiredRevision: number;
  readonly desiredHash: string;
  readonly resolvedConfigHash: string;
  readonly plan: Readonly<{ planId: string; revision: number }>;
  readonly mappingRevision: number | null;
  readonly retentionAppliedRevision: number | null;
  readonly enabled: boolean;
}
export type OperationError =
  | "invalidRequest"
  | "busy"
  | "wrongOwner"
  | "staleRun"
  | "conflict"
  | "noCandidate"
  | "pauseRequired"
  | "consumed"
  | "uncleanPause"
  | "retentionBlocked"
  | "planRecoveryRequired"
  | "cancelled"
  | "deadlineExceeded"
  | "budgetExceeded"
  | "corruptData"
  | "needsReopen"
  | "readerUnusable"
  | "sourceFailure"
  | "workerFailure"
  | "projectionFailed"
  | "internal";
export type OperationOutcome =
  | Readonly<{
      kind: "candidate";
      snapshotCommit: number;
      activeSessionId: string | null;
    }>
  | Readonly<{
      kind: "replay";
      snapshotCommit: number;
      receipt: AppliedReceipt;
    }>
  | Readonly<{ kind: "paused"; sessionId: string }>
  | Readonly<{ kind: "applied"; receipt: AppliedReceipt }>
  | Readonly<{
      kind: "failed";
      error: OperationError;
      effect: "notDispatched" | "notCommitted" | "unconfirmed";
    }>;
export interface RecordingOperationResult {
  readonly version: 1;
  readonly kind: "recordingOperationResult";
  readonly request: RecordingOperationRequest;
  readonly outcome: OperationOutcome;
  readonly quiescence: "confirmed" | "unknown";
  readonly recoveryRequired: boolean;
}
export interface RecordingReconciliationRequest {
  readonly version: 1;
  readonly kind: "recordingReconciliationRequest";
  readonly reconciliationId: string;
  readonly operation: RecordingOperationRequest;
}
export interface RecordingReconciliationResult {
  readonly version: 1;
  readonly kind: "recordingReconciliationResult";
  readonly request: RecordingReconciliationRequest;
  readonly outcome:
    | Readonly<{ kind: "receiptFound"; receipt: AppliedReceipt }>
    | Readonly<{ kind: "notFound" }>
    | Readonly<{ kind: "failed"; error: OperationError }>;
  /** Evidence about the original apply, not about the diagnostic read. */
  readonly quiescence: "confirmed" | "unknown";
  readonly recoveryRequired: boolean;
}
export type RecordingOperationsDocument =
  | RecordingOperationsContext
  | RecordingChangeRequest
  | RecordingOperationRequest
  | RecordingOperationResult
  | RecordingReconciliationRequest
  | RecordingReconciliationResult;
