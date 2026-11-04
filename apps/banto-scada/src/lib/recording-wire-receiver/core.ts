/** Finite retained projection only. No dispatch, timers, callbacks or native authority. */
import type {
  RecordingWireAttachRequest,
  RecordingWireAttachReply,
  RecordingWireControlRequest,
  RecordingWireControlReply,
  RecordingWireControlFrame,
  RecordingWireOwnerSnapshot,
  RecordingWireScope,
} from "../recording-wire-contract";
import { WIRE_LIMITS } from "../recording-wire-contract";
import { measureWire, fits } from "../recording-wire/budget";
import { sameOwnedJson } from "../json-equality";
import { freezeHistory } from "../history/owned-json";
import type {
  AttachGeneration,
  ControlCall,
  ReceiverError,
  ReceiverResult,
  ReceiveResult,
  ReceiverLimits,
  ReceiverState,
} from "./types";
export const DEFAULT_LIMITS: ReceiverLimits = Object.freeze({
  attachIds: 4096,
  controlIds: 4096,
  snapshotRevisions: 64,
  snapshotBytes: 8 * 1024 * 1024,
  callBytes: 8 * 1024 * 1024,
});
export const success = <T>(value: T): ReceiverResult<T> =>
  Object.freeze({ ok: true, value });
export const reject = (
  reason: ReceiverError,
  terminalStored = false,
): ReceiverResult<never> =>
  Object.freeze({ ok: false, reason, terminalStored });
export const received = (
  disposition: Extract<ReceiveResult, { ok: true }>["value"]["disposition"],
): ReceiveResult => success(Object.freeze({ disposition }));
export class Fault {
  constructor(
    readonly reason: "protocolViolation" | "capacity" | "resyncRequired",
  ) {}
}
export function requireReceiver(
  ok: boolean,
  reason: Fault["reason"] = "protocolViolation",
): asserts ok {
  if (!ok) throw new Fault(reason);
}
export function measured(value: unknown, role: "request" | "snapshot"): number {
  return measureWire(
    value,
    WIRE_LIMITS[role],
    role === "snapshot" ? "wireSnapshot" : "wireRequest",
  ).bytes;
}
export function parseLimits(input: unknown): ReceiverLimits {
  if (input === undefined) return DEFAULT_LIMITS;
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error();
  const keys = Reflect.ownKeys(input);
  if (keys.length > 5) throw Error();
  const limits = { ...DEFAULT_LIMITS };
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(limits, key)) throw Error();
    const d = Object.getOwnPropertyDescriptor(input, key)!;
    if (
      !d.enumerable ||
      !("value" in d) ||
      !Number.isSafeInteger(d.value) ||
      d.value < 0 ||
      d.value > DEFAULT_LIMITS[key as keyof ReceiverLimits]
    )
      throw Error();
    limits[key as keyof ReceiverLimits] = d.value;
  }
  return Object.freeze(limits);
}
export interface Generation {
  token: AttachGeneration;
  request: RecordingWireAttachRequest;
  floor: number | null;
  phase: "attaching" | "attached" | "retired";
  reply?: RecordingWireAttachReply;
  ref?: string;
  provisionalRef?: string;
  provisional: Map<number, RecordingWireOwnerSnapshot>;
  stateSlot?: RecordingWireOwnerSnapshot;
  control?: RecordingWireControlFrame;
  controlPending: boolean;
}
export interface ControlRecord {
  token: ControlCall;
  generation: Generation;
  request: RecordingWireControlRequest;
  reply?: RecordingWireControlReply;
}
export class Core {
  generations = new Map<string, Generation>();
  tokens = new WeakMap<object, Generation>();
  controls = new Map<string, ControlRecord>();
  controlTokens = new WeakMap<object, ControlRecord>();
  retained = new Map<RecordingWireOwnerSnapshot, number>();
  history = new Map<number, RecordingWireOwnerSnapshot>();
  current?: Generation;
  connected = false;
  disposed = false;
  resync = false;
  stopped: ReceiverState["stoppedReason"] = null;
  ownerClosed = false;
  ownerBlocked = false;
  authorizationLost = false;
  highwater: number | null = null;
  latest: RecordingWireOwnerSnapshot | null = null;
  snapshotBytes = 0;
  callBytes = 0;
  readonly controlBound: number;
  constructor(
    readonly scope: RecordingWireScope,
    readonly limits: ReceiverLimits,
  ) {
    const b = measureWire(scope, WIRE_LIMITS.request, "wireRequest");
    const bound = {
      bytes: b.bytes + 65536,
      nodes: b.nodes + 4096,
      depth: Math.max(b.depth + 1, 3),
    };
    fits(bound, WIRE_LIMITS.reply);
    this.controlBound = bound.bytes;
  }
  generation(token: unknown): Generation | undefined {
    return token !== null && typeof token === "object"
      ? this.tokens.get(token)
      : undefined;
  }
  control(token: unknown): ControlRecord | undefined {
    return token !== null && typeof token === "object"
      ? this.controlTokens.get(token)
      : undefined;
  }
  matches(scope: unknown): boolean {
    return sameOwnedJson(scope, this.scope);
  }
  gate(): ReceiverError | null {
    return this.disposed
      ? "disposed"
      : !this.connected ||
          this.stopped ||
          this.ownerClosed ||
          this.authorizationLost
        ? "busy"
        : null;
  }
  pendingAttach(): number {
    return [...this.generations.values()].filter((g) => !g.reply).length;
  }
  pendingControl(): number {
    return [...this.controls.values()].filter((c) => !c.reply).length;
  }
  retire(g = this.current): void {
    if (g) g.phase = "retired";
  }
  fail(
    reason: "protocolViolation" | "invalidDocument" | "capacity",
    stored = false,
    retire = true,
  ): ReceiveResult {
    this.stopped ??= reason;
    if (retire) this.retire();
    return reject(reason, stored);
  }
  failure(error: unknown, stored = false): ReceiveResult {
    if (error instanceof Fault && error.reason === "resyncRequired") {
      this.resync = true;
      this.retire();
      return received("resyncRequired");
    }
    return this.fail(
      error instanceof Fault && error.reason !== "resyncRequired"
        ? error.reason
        : "invalidDocument",
      stored,
    );
  }
  isLive(g: Generation): boolean {
    return (
      this.current === g &&
      g.phase !== "retired" &&
      !this.stopped &&
      !this.disposed &&
      this.connected
    );
  }
  checkCost(cost: number): void {
    requireReceiver(
      Number.isSafeInteger(cost) &&
        this.callBytes + cost <= this.limits.callBytes,
      "capacity",
    );
  }
  view(): ReceiverState {
    const g = this.current;
    return freezeHistory({
      scope: this.scope,
      connected: this.connected,
      generation: g
        ? {
            attachId: g.request.attachId,
            phase: g.phase,
            subscriptionRef: g.ref ?? null,
          }
        : null,
      status: this.stopped
        ? "stopped"
        : this.resync
          ? "resyncRequired"
          : g?.phase === "attached" && this.connected
            ? "ready"
            : "awaitingAttach",
      stoppedReason: this.stopped,
      ownerClosed: this.ownerClosed,
      ownerBlocked: this.ownerBlocked,
      authorizationLost: this.authorizationLost,
      highwater: this.highwater,
      latest: this.latest,
      usage: {
        attachIds: this.generations.size,
        controlIds: this.controls.size,
        snapshotRevisions: this.retained.size,
        snapshotBytes: this.snapshotBytes,
        callBytes: this.callBytes,
        pendingAttach: this.pendingAttach(),
        pendingControl: this.pendingControl(),
        stateSlot: Number(!!g?.stateSlot && g.phase === "attaching"),
        controlSlot: Number(!!g?.controlPending && g.phase === "attaching"),
      },
    });
  }
}
