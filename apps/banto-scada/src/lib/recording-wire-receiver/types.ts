import type {
  RecordingWireOwnerSnapshot,
  RecordingWireScope,
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
  dispose(): ReceiverResult<null>;
}
