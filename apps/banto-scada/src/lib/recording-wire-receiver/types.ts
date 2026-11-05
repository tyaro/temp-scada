import type {
  RecordingWireOwnerSnapshot,
  RecordingWireScope,
  RecordingWireAttachRequest,
  RecordingWireAttachReply,
  RecordingWireControlRequest,
  RecordingWireControlReply,
} from "../recording-wire-contract";
declare const attachBrand: unique symbol;
declare const controlBrand: unique symbol;
export type AttachGeneration = Readonly<{ [attachBrand]: true }>;
export type ControlCall = Readonly<{ [controlBrand]: true }>;
export type ReceiverError =
  | "foreignToken"
  | "busy"
  | "invalidRequest"
  | "protocolViolation"
  | "invalidDocument"
  | "capacity"
  | "disposed";
export type ReceiverResult<T> = Readonly<
  | { ok: true; value: T }
  | { ok: false; reason: ReceiverError; terminalStored: boolean }
>;
export type ReceiveResult = ReceiverResult<
  Readonly<{
    disposition: "applied" | "duplicate" | "ignoredRetired" | "resyncRequired";
  }>
>;
export interface ReceiverLimits {
  readonly attachIds: number;
  readonly controlIds: number;
  readonly snapshotRevisions: number;
  readonly snapshotBytes: number;
  readonly callBytes: number;
}
export interface ReceiverState {
  readonly scope: RecordingWireScope;
  readonly connected: boolean;
  readonly generation: Readonly<{
    attachId: string;
    phase: "attaching" | "attached" | "retired";
    subscriptionRef: string | null;
  }> | null;
  readonly status: "ready" | "awaitingAttach" | "resyncRequired" | "stopped";
  readonly stoppedReason:
    "protocolViolation" | "invalidDocument" | "capacity" | "disposed" | null;
  readonly ownerClosed: boolean;
  readonly ownerBlocked: boolean;
  readonly authorizationLost: boolean;
  readonly highwater: number | null;
  readonly latest: RecordingWireOwnerSnapshot | null;
  readonly usage: Readonly<{
    attachIds: number;
    controlIds: number;
    snapshotRevisions: number;
    snapshotBytes: number;
    callBytes: number;
    pendingAttach: number;
    pendingControl: number;
    stateSlot: number;
    controlSlot: number;
  }>;
}
export type StoredTerminal<Q, R> = Readonly<
  { kind: "pending"; request: Q } | { kind: "terminal"; request: Q; reply: R }
>;
/** Local display facts only. Current subscription is neither clock freshness nor authority. */
export interface RecordingWireDisplay {
  readonly scope: RecordingWireScope;
  readonly transportConnected: boolean;
  readonly receiverStatus: ReceiverState["status"];
  readonly receiverStoppedReason: ReceiverState["stoppedReason"];
  readonly generation: ReceiverState["generation"];
  readonly ownerClosed: boolean;
  readonly nativeRecoveryRequired: boolean;
  readonly authorizationLost: boolean;
  readonly highwater: number | null;
  readonly snapshotRelation: "none" | "currentSubscription" | "lastKnown";
  readonly snapshot: RecordingWireOwnerSnapshot | null;
  readonly usage: ReceiverState["usage"];
}
export interface WireReceiver {
  beginAttach(request: unknown): ReceiverResult<AttachGeneration>;
  acceptAttach(generation: AttachGeneration, reply: unknown): ReceiveResult;
  acceptState(generation: AttachGeneration, frame: unknown): ReceiveResult;
  acceptControlFrame(
    generation: AttachGeneration,
    frame: unknown,
  ): ReceiveResult;
  beginControl(
    generation: AttachGeneration,
    request: unknown,
  ): ReceiverResult<ControlCall>;
  acceptControlReply(call: ControlCall, reply: unknown): ReceiveResult;
  setConnected(connected: boolean): ReceiverResult<null>;
  retire(generation: AttachGeneration): ReceiverResult<null>;
  current(): ReceiverState;
  currentDisplay(): RecordingWireDisplay;
  attachTerminal(
    generation: AttachGeneration,
  ): ReceiverResult<
    StoredTerminal<RecordingWireAttachRequest, RecordingWireAttachReply>
  >;
  controlTerminal(
    call: ControlCall,
  ): ReceiverResult<
    StoredTerminal<RecordingWireControlRequest, RecordingWireControlReply>
  >;
  dispose(): ReceiverResult<null>;
}
