import schema from "../../../../../crates/scada-model/schema/recording-operations.schema.json";
import {
  parseRecordingOperationsContext,
  type RecordingOperationsContext,
  type RecordingChangeRequest,
  type RecordingOperationRequest,
  type RecordingOperationResult,
  type RecordingReconciliationRequest,
  type RecordingReconciliationResult,
  type AppliedReceipt,
  type OperationError,
} from "../recording-operations-contract";
import {
  parseRecordingPlan,
  type DesiredRecordingPlan,
} from "../recording-plan";
import type { Project } from "../project";
export interface OperationControl {
  readonly deadlineMonotonicMs: number;
}
export interface ChangeHandle {
  readonly opaqueChange: object;
}
export type CancelDisposition =
  "requested" | "alreadyCompleted" | "notSupported";
export interface OperationHandle {
  readonly opaqueOperation: object;
  readonly request: RecordingOperationRequest;
  readonly completion: Promise<RecordingOperationResult>;
  readonly requestCancel: () => CancelDisposition;
}
export interface ReconciliationHandle {
  readonly request: RecordingReconciliationRequest;
  readonly completion: Promise<RecordingReconciliationResult>;
  readonly requestCancel: () => CancelDisposition;
}
export type OperationOwnerPhase =
  | "idle"
  | "preflighting"
  | "candidate"
  | "pausing"
  | "paused"
  | "applying"
  | "completed"
  | "blocked"
  | "uncertain";
export interface AppliedSuccess {
  readonly request: RecordingOperationRequest;
  readonly receipt: AppliedReceipt;
}
export interface RecordingOperationOwnerView {
  readonly change: ChangeHandle | null;
  readonly request: RecordingChangeRequest | null;
  readonly phase: OperationOwnerPhase;
  /** Current/last accepted stage handle, retained after settlement until the next
   * stage or workflow. Non-null alone is not proof of a physical operation. */
  readonly active: OperationHandle | null;
  readonly latest: RecordingOperationResult | null;
  readonly reconciling: ReconciliationHandle | null;
  readonly lastReconciliation: RecordingReconciliationResult | null;
  readonly lastApplied: AppliedSuccess | null;
}
/** Provider owns native runs, the global physical gate and pending operations
 * beyond App disposal. Every accepted request is registered before dispatch.
 * Completion may report unknown; it never proves quiescence merely by settling.
 * Real provider/native projection is H5d4c, not implemented by the App monitor. */
export interface RecordingOperationsService {
  readonly context: unknown;
  readonly preflight: (
    request: RecordingChangeRequest,
    control: OperationControl,
  ) => { change: ChangeHandle; operation: OperationHandle };
  readonly pauseJoin: (
    change: ChangeHandle,
    operationId: string,
    control: OperationControl,
  ) => OperationHandle;
  readonly apply: (
    change: ChangeHandle,
    operationId: string,
    control: OperationControl,
  ) => OperationHandle;
  readonly discard: (change: ChangeHandle) => void;
  readonly reconcile: (
    change: ChangeHandle,
    operation: OperationHandle,
    reconciliationId: string,
    control: OperationControl,
  ) => ReconciliationHandle;
  readonly current: () => RecordingOperationOwnerView;
  readonly subscribe: (
    listener: (state: RecordingOperationOwnerView) => void,
  ) => () => void;
}
export function operationErrorCode(value: unknown): value is OperationError {
  return (
    typeof value === "string" &&
    (schema.$defs.error.enum as readonly string[]).includes(value)
  );
}
/** This dedicated type guarantees that the refused call dispatched nothing. */
export class RecordingOperationRejected extends Error {
  constructor(
    readonly code: OperationError,
    readonly ownerState: RecordingOperationOwnerView,
  ) {
    super("Recording operation refused");
    Object.freeze(this);
  }
}
export interface OperationsBinding {
  readonly service: RecordingOperationsService;
  readonly context: RecordingOperationsContext;
  readonly methods: Omit<RecordingOperationsService, "context">;
  readonly project: Project;
  readonly generation: number;
  readonly openOwner: object;
  readonly desired: DesiredRecordingPlan | undefined;
}
export type OperationsSelection = Readonly<
  | { phase: "ready"; binding: OperationsBinding }
  | { phase: "offline" | "invalidContext" | "contextMismatch" }
>;
export function recordingOperationsSelection(
  service: RecordingOperationsService | undefined,
  project: Project,
  generation: number,
  openOwner: object,
): OperationsSelection {
  if (!service) return Object.freeze({ phase: "offline" });
  try {
    const context = parseRecordingOperationsContext(service.context);
    const methods = {
      preflight: service.preflight,
      pauseJoin: service.pauseJoin,
      apply: service.apply,
      discard: service.discard,
      reconcile: service.reconcile,
      current: service.current,
      subscribe: service.subscribe,
    };
    if (Object.values(methods).some((fn) => typeof fn !== "function"))
      throw Error("invalid");
    if (
      context.target.projectId !== project.manifest.projectId ||
      context.target.projectRevision !== project.manifest.projectRevision
    )
      return Object.freeze({ phase: "contextMismatch" });
    return Object.freeze({
      phase: "ready",
      binding: Object.freeze({
        service,
        context,
        methods: Object.freeze(methods),
        project,
        generation,
        openOwner,
        desired:
          project.recordingPlan === undefined
            ? undefined
            : parseRecordingPlan(project.recordingPlan),
      }),
    });
  } catch {
    return Object.freeze({ phase: "invalidContext" });
  }
}
