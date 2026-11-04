import type {
  RecordingOperationsContext,
  RecordingChangeRequest,
  RecordingOperationResult,
  OperationError,
} from "../recording-operations-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionReply,
  RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import type { AppliedSuccess } from "../recording-operations/service";
import type { CancelDisposition } from "./port";
import type { IdRole } from "./ids";
export interface IntentControl {
  readonly intentDeadlineMonotonicMs: number;
  readonly requestedNativeBudgetMs: number;
}
export interface ReadControl {
  readonly deadlineMonotonicMs: number;
}
export interface ViewLease {
  preflight(change: RecordingChangeRequest, control: IntentControl): boolean;
  pause(control: IntentControl): boolean;
  apply(control: IntentControl): boolean;
  discard(control: IntentControl): boolean;
  inspectAdmission(control: ReadControl): boolean;
  reconcile(control: IntentControl): boolean;
  cancelOperation(): boolean;
  cancelReconciliation(): boolean;
  retire(): void;
}
export type AdmissionPhase =
  | "idle"
  | "preparingLease"
  | "awaitingAck"
  | "unknown"
  | "accepted"
  | "rejected"
  | "discarded";
export interface AsyncOperationsState {
  readonly context: RecordingOperationsContext;
  readonly ownerRef: string;
  readonly connected: boolean;
  readonly closed: boolean;
  readonly invalid: boolean;
  readonly ownerBlocked: boolean;
  readonly timedOut: boolean;
  readonly refusal?: OperationError | "capacity" | "unqualified";
  readonly admission: AdmissionPhase;
  readonly request?: RecordingAdmissionRequest;
  readonly reply?: RecordingAdmissionReply;
  readonly inspection?: RecordingAdmissionInspectionReply;
  readonly call: "idle" | "lease" | "admit" | "uncertain";
  readonly inspectionCall: "idle" | "pending" | "uncertain";
  readonly cancelCall: "idle" | "pending" | "uncertain";
  readonly cancel?: CancelDisposition;
  readonly change?: RecordingChangeRequest;
  readonly identity?: object;
  readonly latest?: RecordingOperationResult;
  readonly completion?: RecordingOperationResult;
  readonly lastApplied?: AppliedSuccess;
  readonly read:
    | "idle"
    | "awaitingAdmission"
    | "accepted"
    | "completed"
    | "readUncertain"
    | "deliveryUnknown";
  readonly delivery?: RecordingReconciliationDelivery;
  readonly canPreflight: boolean;
  readonly canPause: boolean;
  readonly canApply: boolean;
  readonly canDiscard: boolean;
  readonly canInspect: boolean;
  readonly canReconcile: boolean;
  readonly canCancel: boolean;
  readonly canCancelRead: boolean;
  readonly safeToSwitch: boolean;
  readonly pools: Readonly<
    Record<IdRole, Readonly<{ used: number; reserved: number }>>
  >;
}
export interface AsyncOperationsClient {
  readonly context: RecordingOperationsContext;
  readonly ownerRef: string;
  current(): AsyncOperationsState;
  subscribe(listener: (state: AsyncOperationsState) => void): () => void;
  bindView(identity: object): ViewLease;
}
