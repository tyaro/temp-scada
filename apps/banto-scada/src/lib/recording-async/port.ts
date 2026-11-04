/** Same-realm test injection only. These Promises and identities are not wire DTOs. */
import type {
  RecordingOperationsContext,
  RecordingOperationRequest,
  RecordingReconciliationRequest,
  OperationError,
} from "../recording-operations-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingReconciliationDelivery,
} from "../recording-admission-contract";
export interface LocalLeaseRequest {
  readonly ownerRef: string;
  readonly admissionId: string;
  readonly context: RecordingOperationsContext;
  readonly requestedBudgetMs: number;
}
export interface LocalLeaseReply {
  readonly request: LocalLeaseRequest;
  readonly outcome: Readonly<
    | { kind: "issued"; deadlineLeaseRef: string }
    | { kind: "rejected"; error: OperationError }
  >;
}
export interface LocalCancelRequest {
  readonly ownerRef: string;
  readonly target: Readonly<{
    kind: "operation" | "reconciliation";
    ref: string;
  }>;
}
export type CancelDisposition =
  "requested" | "alreadyCompleted" | "notSupported";
export interface LocalCancelReply {
  readonly request: LocalCancelRequest;
  readonly disposition: CancelDisposition;
}
export interface LocalOwnerFrame {
  readonly ownerRef: string;
  readonly context: RecordingOperationsContext;
  readonly revision: number;
  readonly connected: boolean;
  readonly admission: RecordingAdmissionReply | null;
  readonly operation: Readonly<{
    operationRef: string;
    result: import("../recording-operations-contract").RecordingOperationResult;
  }> | null;
  readonly reconciliation: RecordingReconciliationDelivery | null;
  readonly ownerBlocked: boolean;
}
export interface LocalOperationObservation {
  readonly operationRef: string;
  readonly request: RecordingOperationRequest;
  readonly completion: Promise<unknown>;
}
export interface LocalReconciliationObservation {
  readonly readRef: string;
  readonly request: RecordingReconciliationRequest;
  readonly completion: Promise<unknown>;
}
export interface AsyncRecordingOperationsPort {
  readonly context: unknown;
  readonly ownerRef: string;
  prepareLease(request: LocalLeaseRequest): Promise<unknown>;
  admit(request: RecordingAdmissionRequest): Promise<unknown>;
  inspectAdmission(
    request: RecordingAdmissionInspectionRequest,
  ): Promise<unknown>;
  observeOperation(operationRef: string): LocalOperationObservation;
  observeReconciliation(readRef: string): LocalReconciliationObservation;
  current(): unknown;
  subscribe(listener: (frame: unknown) => void): () => void;
  requestCancel(request: LocalCancelRequest): Promise<unknown>;
}
