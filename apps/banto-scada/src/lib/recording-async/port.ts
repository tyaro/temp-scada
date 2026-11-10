/** Same-realm port v2. Promises and identities are local; payloads are wire DTOs. */
import type { RecordingChangeRequest } from "../recording-operations-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingAdmissionInspectionReply,
} from "../recording-admission-contract";
import {
  parseRecordingWireAttachRequest,
  type RecordingWireScope,
  type RecordingWireLeaseRequest,
  type RecordingWireLeaseReply,
  type RecordingWireCancelRequest,
  type RecordingWireCancelReply,
  type RecordingWireObservationTarget,
  type RecordingWireObservationReply,
  type RecordingWireCallInspectionReply,
} from "../recording-wire-contract";
import type { RecordingWireDisplay } from "../recording-wire-receiver";
import type { DeliveryLedgerState } from "../recording-wire-delivery-ledger";

export type CancelDisposition =
  "requested" | "alreadyCompleted" | "notSupported";

/** hostが`{"kind": ...}`で拒否した。元replyはない（受理済みかどうかは種類による）。 */
export type PortHostRefusal = Readonly<
  | { kind: "recordingUnavailable"; reason: string }
  | { kind: "invalidRequest" }
  | { kind: "phase"; phase: string }
  | { kind: "unauthorized" | "forbidden" | "authUnavailable" }
  | {
      kind:
        | "invalidInput"
        | "protocolViolation"
        | "capacity"
        | "busy"
        | "expired"
        | "closed";
    }
>;

/** 一回の物理呼出し（Tauri invoke）の終わり。元replyの有無とは別。 */
export type PortTransportEnd = Readonly<
  | { kind: "returned" }
  | { kind: "refused"; refusal: PortHostRefusal }
  | { kind: "staleSeq"; seq: number }
  | { kind: "failed" }
>;

export interface PortCallV2<Q, R> {
  /** 送った（送る予定の）元request。owned/frozen。 */
  readonly request: Q;
  /** 保存済みの正常な元replyでだけresolveする。rejectしない。 */
  readonly reply: Promise<R>;
  /** 物理呼出しの終わり。rejectしない。 */
  readonly transport: Promise<PortTransportEnd>;
}

export type PortLeaseRequestV2 = Readonly<
  | {
      role: "mutation";
      stage: "preflight";
      change: RecordingChangeRequest;
      lease: RecordingWireLeaseRequest;
    }
  | {
      role: "mutation";
      stage: "pauseJoin" | "apply";
      operationId: string;
      lease: RecordingWireLeaseRequest;
    }
  | { role: "mutation"; stage: "discard"; lease: RecordingWireLeaseRequest }
  | { role: "reconciliation"; lease: RecordingWireLeaseRequest }
>;

export interface PortObservationV2 {
  readonly target: RecordingWireObservationTarget;
  /** queryの終端reply（outcome.kindが`pending`以外）でだけresolveする。 */
  readonly result: Promise<RecordingWireObservationReply>;
}

export type PortOwnerClosed = "controlFrame" | "hostClosed" | "slotEmpty";
export type PortAuthorizationLost =
  "controlFrame" | "ended" | "refused" | "seqChanged";

export interface PortStateV2 {
  readonly version: 2;
  readonly scope: RecordingWireScope;
  /** このportを作ったsessionの権限。`read`ではmutationを送らない。 */
  readonly access: "mutation" | "read";
  /** 束縛したdesktop sessionの世代。最初の正常返信まで`null`。 */
  readonly seq: number | null;
  /** receiverの表示（client境界§4）。cached frameはここだけに出る。 */
  readonly display: RecordingWireDisplay;
  readonly subscription:
    "idle" | "attaching" | "attached" | "ended" | "stopped";
  /** 最後に届いた`ended`の理由。 */
  readonly ended: string | null;
  readonly ownerClosed: PortOwnerClosed | null;
  readonly authorizationLost: PortAuthorizationLost | null;
  /** receiverが再同期を要し、attachし直しが成功していない。 */
  readonly resyncRequired: boolean;
  /** `display.nativeRecoveryRequired`の写し（sticky）。 */
  readonly nativeRecoveryRequired: boolean;
  readonly observations: readonly Readonly<{
    target: RecordingWireObservationTarget;
    query: "pending" | "terminal" | "transportLost";
    attemptsInFlight: number;
  }>[];
  readonly usage: Readonly<{
    ledger: DeliveryLedgerState["usage"];
    receiver: RecordingWireDisplay["usage"];
  }>;
}

export interface AsyncRecordingPortV2Impl {
  readonly scope: RecordingWireScope;
  readonly access: "mutation" | "read";
  prepareLease(
    request: PortLeaseRequestV2,
  ): PortCallV2<PortLeaseRequestV2, RecordingWireLeaseReply>;
  admit(
    request: RecordingAdmissionRequest,
  ): PortCallV2<RecordingAdmissionRequest, RecordingAdmissionReply>;
  inspectAdmission(
    request: RecordingAdmissionInspectionRequest,
  ): PortCallV2<
    RecordingAdmissionInspectionRequest,
    RecordingAdmissionInspectionReply
  >;
  /** 元callの返信喪失からの回収（CallInspection）。元callを再送しない。 */
  inspectCall(
    original: PortCallV2<unknown, unknown>,
  ): PortCallV2<unknown, RecordingWireCallInspectionReply>;
  requestCancel(
    request: RecordingWireCancelRequest,
  ): PortCallV2<RecordingWireCancelRequest, RecordingWireCancelReply>;
  observe(target: RecordingWireObservationTarget): PortObservationV2;
  current(): PortStateV2;
  subscribe(listener: (state: PortStateV2) => void): () => void;
}

export interface AsyncRecordingOperationsPortV2 extends AsyncRecordingPortV2Impl {
  readonly version: 2;
}

export const PORT_V2_METHODS = [
  "prepareLease",
  "admit",
  "inspectAdmission",
  "inspectCall",
  "requestCancel",
  "observe",
  "current",
  "subscribe",
] as const;

const ports = new WeakSet<object>();

function own(target: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(target, key);
  if (!d || !("value" in d)) throw Error("invalid port");
  return d.value;
}

/** The only constructor of a port v2. Shape-checks the implementation, binds and freezes it. */
export function defineAsyncRecordingPortV2(
  impl: AsyncRecordingPortV2Impl,
): AsyncRecordingOperationsPortV2 {
  if (!impl || typeof impl !== "object" || Array.isArray(impl))
    throw Error("Recording async owner: invalid port v2");
  try {
    const access = own(impl, "access");
    if (access !== "mutation" && access !== "read") throw Error("access");
    // The wire parser owns, freezes and validates the scope (IDs and context).
    const scope = parseRecordingWireAttachRequest({
      version: 1,
      kind: "recordingWireAttachRequest",
      scope: own(impl, "scope"),
      attachId: "validation",
      afterRevision: null,
    }).scope;
    const methods: Record<string, unknown> = {};
    for (const k of PORT_V2_METHODS) {
      // Methods may live on the object or its prototype, but never as accessors.
      let m: unknown;
      for (let o: object | null = impl; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, k);
        if (!d) continue;
        if (!("value" in d)) throw Error("accessor");
        m = d.value;
        break;
      }
      if (typeof m !== "function") throw Error("method");
      methods[k] = (m as (...a: unknown[]) => unknown).bind(impl);
    }
    const port = Object.freeze({
      version: 2 as const,
      scope,
      access,
      ...methods,
    }) as unknown as AsyncRecordingOperationsPortV2;
    ports.add(port);
    return port;
  } catch {
    throw Error("Recording async owner: invalid port v2");
  }
}

/** Membership only. A structural `version: 2` object or a Proxy is never a port. */
export function isAsyncRecordingPortV2(
  value: unknown,
): value is AsyncRecordingOperationsPortV2 {
  return !!value && typeof value === "object" && ports.has(value);
}
