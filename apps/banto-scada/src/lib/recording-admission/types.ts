import type {
  RecordingOperationsContext,
  RecordingChangeRequest,
  RecordingOperationRequest,
  RecordingReconciliationRequest,
  RecordingReconciliationResult,
  OperationError,
} from "../recording-operations-contract";
export type RecordingAdmissionAction =
  | Readonly<{ kind: "preflight"; change: RecordingChangeRequest }>
  | Readonly<{
      kind: "pauseJoin" | "apply";
      changeRef: string;
      operation: RecordingOperationRequest;
    }>
  | Readonly<{
      kind: "reconcile";
      changeRef: string;
      operationRef: string;
      reconciliation: RecordingReconciliationRequest;
    }>
  | Readonly<{
      kind: "discard";
      changeRef: string;
      change: RecordingChangeRequest;
    }>;
export interface RecordingAdmissionRequest {
  readonly version: 1;
  readonly kind: "recordingAdmissionRequest";
  readonly ownerRef: string;
  readonly admissionId: string;
  readonly context: RecordingOperationsContext;
  readonly deadlineLeaseRef: string;
  readonly action: RecordingAdmissionAction;
}
export type RecordingAcceptedRef =
  | Readonly<{
      kind: "operation";
      changeRef: string;
      operationRef: string;
      request: RecordingOperationRequest;
    }>
  | Readonly<{
      kind: "reconciliation";
      readRef: string;
      request: RecordingReconciliationRequest;
    }>;
export interface RecordingAdmissionReply {
  readonly version: 1;
  readonly kind: "recordingAdmissionReply";
  readonly request: RecordingAdmissionRequest;
  readonly outcome:
    | Readonly<{ kind: "accepted"; handle: RecordingAcceptedRef }>
    | Readonly<{ kind: "completedDiscard" }>
    | Readonly<{ kind: "rejected" | "unknown"; error: OperationError }>;
}
export interface RecordingAdmissionInspectionRequest {
  readonly version: 1;
  readonly kind: "recordingAdmissionInspectionRequest";
  readonly inspectionId: string;
  readonly original: RecordingAdmissionRequest;
}
export interface RecordingAdmissionInspectionReply {
  readonly version: 1;
  readonly kind: "recordingAdmissionInspectionReply";
  readonly request: RecordingAdmissionInspectionRequest;
  readonly outcome:
    | Readonly<{ kind: "found"; reply: RecordingAdmissionReply }>
    | Readonly<{ kind: "notFound" }>
    | Readonly<{ kind: "unavailable"; error: OperationError }>;
}
export interface RecordingReconciliationDelivery {
  readonly version: 1;
  readonly kind: "recordingReconciliationDelivery";
  readonly ownerRef: string;
  readonly readRef: string;
  readonly request: RecordingReconciliationRequest;
  readonly outcome:
    | Readonly<{ kind: "result"; result: RecordingReconciliationResult }>
    | Readonly<{ kind: "readUncertain"; error: "internal" | "workerFailure" }>;
}
export type RecordingAdmissionDocument =
  | RecordingAdmissionRequest
  | RecordingAdmissionReply
  | RecordingAdmissionInspectionRequest
  | RecordingAdmissionInspectionReply
  | RecordingReconciliationDelivery;
