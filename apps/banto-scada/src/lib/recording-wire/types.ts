/** Pure wire data only; no native ownership, authentication or transport. */
import type {
  RecordingOperationsContext,
  RecordingOperationRequest,
  RecordingOperationResult,
  RecordingReconciliationRequest,
} from "../recording-operations-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingAdmissionInspectionReply,
  RecordingReconciliationDelivery,
} from "../recording-admission-contract";
export type RecordingWireError =
  | "unauthorized"
  | "forbidden"
  | "ownerUnavailable"
  | "expired"
  | "capacity"
  | "protocolViolation"
  | "internal";
export type RecordingWireScope = Readonly<{
  ownerRef: string;
  ownerEpoch: string;
  context: RecordingOperationsContext;
}>;
export type RecordingWireLeaseRequest = Readonly<{
  version: 1;
  kind: "recordingWireLeaseRequest";
  scope: RecordingWireScope;
  leaseRequestId: string;
  admissionId: string;
  role: "mutation" | "reconciliation";
  requestedBudgetMs: number;
}>;
export type RecordingWireLeaseReply = Readonly<{
  version: 1;
  kind: "recordingWireLeaseReply";
  request: RecordingWireLeaseRequest;
  outcome:
    | Readonly<{
        kind: "issued";
        deadlineLeaseRef: string;
        grantedBudgetMs: number;
      }>
    | Readonly<{ kind: "rejected"; error: RecordingWireError }>;
}>;
export type RecordingWireObservationTarget =
  | Readonly<{
      kind: "operation";
      operationRef: string;
      request: RecordingOperationRequest;
    }>
  | Readonly<{
      kind: "reconciliation";
      readRef: string;
      request: RecordingReconciliationRequest;
    }>;
export type RecordingWireObservationRequest = Readonly<{
  version: 1;
  kind: "recordingWireObservationRequest";
  scope: RecordingWireScope;
  observationId: string;
  target: RecordingWireObservationTarget;
}>;
export type RecordingWireObservationReply = Readonly<{
  version: 1;
  kind: "recordingWireObservationReply";
  request: RecordingWireObservationRequest;
  outcome:
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "operation"; result: RecordingOperationResult }>
    | Readonly<{
        kind: "reconciliation";
        delivery: RecordingReconciliationDelivery;
      }>
    | Readonly<{ kind: "unavailable"; error: RecordingWireError }>;
}>;
export type RecordingWireCancelTarget = Readonly<{
  kind: "operation" | "reconciliation";
  ref: string;
}>;
export type RecordingWireCancelRequest = Readonly<{
  version: 1;
  kind: "recordingWireCancelRequest";
  scope: RecordingWireScope;
  cancelId: string;
  target: RecordingWireCancelTarget;
}>;
export type RecordingWireCancelReply = Readonly<{
  version: 1;
  kind: "recordingWireCancelReply";
  request: RecordingWireCancelRequest;
  outcome:
    | Readonly<{
        kind: "ack";
        disposition: "requested" | "alreadyCompleted" | "notSupported";
      }>
    | Readonly<{ kind: "rejected"; error: RecordingWireError }>;
}>;
export type RecordingWireOwnerSnapshot = Readonly<{
  scope: RecordingWireScope;
  revision: number;
  closed: boolean;
  ownerBlocked: boolean;
  admission: null | RecordingAdmissionReply;
  operation: null | Readonly<{
    operationRef: string;
    result: RecordingOperationResult;
  }>;
  reconciliation: null | RecordingReconciliationDelivery;
}>;
export type RecordingWireAttachRequest = Readonly<{
  version: 1;
  kind: "recordingWireAttachRequest";
  scope: RecordingWireScope;
  attachId: string;
  afterRevision: null | number;
}>;
export type RecordingWireAttachReply = Readonly<{
  version: 1;
  kind: "recordingWireAttachReply";
  request: RecordingWireAttachRequest;
  outcome:
    | Readonly<{
        kind: "attached";
        subscriptionRef: string;
        snapshot: RecordingWireOwnerSnapshot;
      }>
    | Readonly<{ kind: "rejected"; error: RecordingWireError }>;
}>;
export type RecordingWireStateFrame = Readonly<{
  version: 1;
  kind: "recordingWireStateFrame";
  subscriptionRef: string;
  snapshot: RecordingWireOwnerSnapshot;
}>;
export type RecordingWireControlRequest = Readonly<{
  version: 1;
  kind: "recordingWireControlRequest";
  scope: RecordingWireScope;
  controlId: string;
  subscriptionRef: string;
  action: "detach" | "snapshot";
}>;
export type RecordingWireControlReply = Readonly<{
  version: 1;
  kind: "recordingWireControlReply";
  request: RecordingWireControlRequest;
  outcome:
    | Readonly<{ kind: "detached" }>
    | Readonly<{ kind: "snapshot"; snapshot: RecordingWireOwnerSnapshot }>
    | Readonly<{ kind: "rejected"; error: RecordingWireError }>;
}>;
export type RecordingWireControlFrame = Readonly<{
  version: 1;
  kind: "recordingWireControlFrame";
  scope: RecordingWireScope;
  subscriptionRef: string;
  reason: "resyncRequired" | "ownerClosed" | "authorizationLost";
}>;
export type RecordingWireOriginalRequest =
  | RecordingWireLeaseRequest
  | RecordingAdmissionRequest
  | RecordingAdmissionInspectionRequest
  | RecordingWireCancelRequest
  | RecordingWireAttachRequest
  | RecordingWireControlRequest;
export type RecordingWireOriginalReply =
  | RecordingWireLeaseReply
  | RecordingAdmissionReply
  | RecordingAdmissionInspectionReply
  | RecordingWireCancelReply
  | RecordingWireAttachReply
  | RecordingWireControlReply;
export type RecordingWireCallInspectionRequest = Readonly<{
  version: 1;
  kind: "recordingWireCallInspectionRequest";
  scope: RecordingWireScope;
  callInspectionId: string;
  original: RecordingWireOriginalRequest;
}>;
export type RecordingWireCallInspectionReply = Readonly<{
  version: 1;
  kind: "recordingWireCallInspectionReply";
  request: RecordingWireCallInspectionRequest;
  outcome:
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "terminal"; reply: RecordingWireOriginalReply }>
    | Readonly<{ kind: "notFound" }>
    | Readonly<{ kind: "unavailable"; error: RecordingWireError }>;
}>;
export type RecordingWireDocument =
  | RecordingWireLeaseRequest
  | RecordingWireLeaseReply
  | RecordingWireObservationRequest
  | RecordingWireObservationReply
  | RecordingWireCancelRequest
  | RecordingWireCancelReply
  | RecordingWireAttachRequest
  | RecordingWireAttachReply
  | RecordingWireStateFrame
  | RecordingWireControlRequest
  | RecordingWireControlReply
  | RecordingWireControlFrame
  | RecordingWireCallInspectionRequest
  | RecordingWireCallInspectionReply;
export type RecordingWireRequest = Extract<
  RecordingWireDocument,
  {
    kind:
      | "recordingWireLeaseRequest"
      | "recordingWireObservationRequest"
      | "recordingWireCancelRequest"
      | "recordingWireAttachRequest"
      | "recordingWireControlRequest"
      | "recordingWireCallInspectionRequest";
  }
>;
