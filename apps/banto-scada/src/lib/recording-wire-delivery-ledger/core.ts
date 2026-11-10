/** Finite client records only. No native authority or physical transport accounting. */
import type {
  RecordingWireScope,
  RecordingWireCallInspectionRequest,
  RecordingWireCallInspectionReply,
  RecordingWireObservationTarget,
  RecordingWireObservationRequest,
  RecordingWireObservationReply,
} from "../recording-wire-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAcceptedRef,
} from "../recording-admission-contract";
import type {
  OriginalRequest,
  OriginalReply,
  OriginalCallToken,
  InspectionQueryToken,
  InspectionAttemptToken,
  LedgerError,
  LedgerResult,
  DeliveryAcceptResult,
  DeliveryLimits,
  DeliveryLedgerState,
  ObservationTargetToken,
  ObservationQueryToken,
  ObservationAttemptToken,
  ObservationTargetResult,
  ObservationAcceptResult,
} from "./types";
export const DEFAULT_LIMITS: DeliveryLimits = Object.freeze({
  mutationBytes: 6 * 1024 * 1024,
  readBytes: 2 * 1024 * 1024,
  observationBytes: 4 * 1024 * 1024,
  mutationIds: 4096,
  readIds: 4096,
  inspectionIds: 4096,
  inspectionAttempts: 4096,
  observationTargets: 4096,
  observationQueries: 4096,
  observationAttempts: 4096,
});
export const yes = <T>(value: T): LedgerResult<T> =>
  Object.freeze({ ok: true, value });
export const no = (reason: LedgerError): LedgerResult<never> =>
  Object.freeze({ ok: false, reason });
export const accepted = (
  disposition: "stored" | "duplicate",
  terminalStored: boolean,
  attemptStored: boolean,
): DeliveryAcceptResult =>
  Object.freeze({
    ok: true,
    value: Object.freeze({ disposition, terminalStored, attemptStored }),
  });
export const rejected = (
  reason: LedgerError,
  terminalStored = false,
  attemptStored = false,
): DeliveryAcceptResult =>
  Object.freeze({ ok: false, reason, terminalStored, attemptStored });
export class Fault {
  constructor(readonly reason: LedgerError) {}
}
export function requireLedger(ok: boolean, reason: LedgerError): asserts ok {
  if (!ok) throw new Fault(reason);
}
export function parseLimits(input: unknown): DeliveryLimits {
  if (input === undefined) return DEFAULT_LIMITS;
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error();
  const keys = Reflect.ownKeys(input),
    limits = { ...DEFAULT_LIMITS };
  if (keys.length > Object.keys(DEFAULT_LIMITS).length) throw Error();
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(limits, key)) throw Error();
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      !d ||
      !d.enumerable ||
      !("value" in d) ||
      !Number.isSafeInteger(d.value) ||
      d.value < 0 ||
      d.value > DEFAULT_LIMITS[key as keyof DeliveryLimits]
    )
      throw Error();
    limits[key as keyof DeliveryLimits] = d.value;
  }
  return Object.freeze(limits);
}
export type Pool = "mutation" | "read";
export interface OriginalRecord {
  token: OriginalCallToken;
  request: OriginalRequest;
  pool: Pool;
  R: number;
  I: number;
  credit: boolean;
  terminal: OriginalReply | null;
  learnedBy: "direct" | "inspection" | null;
  /** The terminal's actual size replaced the reserved maximum reply. */
  settled: boolean;
}
export interface QueryRecord {
  token: InspectionQueryToken;
  request: RecordingWireCallInspectionRequest;
  original: OriginalRecord;
  I: number;
  first: AttemptRecord;
  latest: AttemptRecord;
  terminal: OriginalReply | null;
}
export type AttemptOutcome =
  | Exclude<RecordingWireCallInspectionReply["outcome"], { kind: "terminal" }>
  | Readonly<{ kind: "terminal"; reply: OriginalReply }>;
export interface AttemptRecord {
  token: InspectionAttemptToken;
  query: QueryRecord;
  R: number;
  outcome: AttemptOutcome | null;
  applied: boolean;
  /** Its maximum reply was released after the original settled. */
  released?: boolean;
}
export interface ObservationTargetRecord {
  token: ObservationTargetToken;
  target: RecordingWireObservationTarget;
  admission: RecordingAdmissionRequest;
  accepted: RecordingAcceptedRef;
  result: ObservationTargetResult | null;
}
export interface ObservationQueryRecord {
  token: ObservationQueryToken;
  request: RecordingWireObservationRequest;
  target: ObservationTargetRecord;
  first: ObservationAttemptRecord;
  latest: ObservationAttemptRecord;
  terminal: RecordingWireObservationReply | null;
  /** The one `pending` reply kept for every attempt of this query. */
  pending: RecordingWireObservationReply | null;
}
export interface ObservationAttemptRecord {
  token: ObservationAttemptToken;
  query: ObservationQueryRecord;
  /** The key of this attempt in `Core.observationAttempts`. */
  sequence: number;
  R: number;
  reply: RecordingWireObservationReply | null;
  /** The physical call ended without a reply; no reply is awaited any more. */
  abandoned: boolean;
  queryTerminalStored: boolean;
  targetResultStored: boolean;
}
export function observationAccepted(
  disposition: "stored" | "duplicate",
  flags: {
    attemptStored: boolean;
    queryTerminalStored: boolean;
    targetResultStored: boolean;
  },
): ObservationAcceptResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({ disposition, ...flags }),
  });
}
export function observationRejected(
  reason: LedgerError,
  flags: {
    attemptStored: boolean;
    queryTerminalStored: boolean;
    targetResultStored: boolean;
  } = {
    attemptStored: false,
    queryTerminalStored: false,
    targetResultStored: false,
  },
): ObservationAcceptResult {
  return Object.freeze({ ok: false, reason, ...flags });
}
export class Core {
  originals = new Map<string, OriginalRecord>();
  originalTokens = new WeakMap<object, OriginalRecord>();
  queries = new Map<string, QueryRecord>();
  queryTokens = new WeakMap<object, QueryRecord>();
  attempts = new Map<number, AttemptRecord>();
  attemptTokens = new WeakMap<object, AttemptRecord>();
  observationTargets = new Map<string, ObservationTargetRecord>();
  observationTargetRefs = new Map<string, ObservationTargetRecord>();
  observationTargetTokens = new WeakMap<object, ObservationTargetRecord>();
  observationQueries = new Map<string, ObservationQueryRecord>();
  observationQueryTokens = new WeakMap<object, ObservationQueryRecord>();
  observationAttempts = new Map<number, ObservationAttemptRecord>();
  observationAttemptTokens = new WeakMap<object, ObservationAttemptRecord>();
  retired = false;
  disposed = false;
  stoppedReason: DeliveryLedgerState["stoppedReason"] = null;
  dirty = false;
  sequence = 0;
  usage = {
    mutationBytes: 0,
    readBytes: 0,
    observationBytes: 0,
    mutationIds: 0,
    readIds: 0,
    inspectionIdsUsed: 0,
    inspectionIdsReserved: 0,
    inspectionAttemptsUsed: 0,
    inspectionAttemptsReserved: 0,
    observationTargets: 0,
    observationQueries: 0,
    observationAttempts: 0,
  };
  constructor(
    readonly scope: RecordingWireScope,
    readonly limits: DeliveryLimits,
  ) {}
  lookup<T>(tokens: WeakMap<object, T>, token: unknown): T | undefined {
    return token !== null && typeof token === "object"
      ? tokens.get(token)
      : undefined;
  }
  pending(pool: Pool) {
    return [...this.originals.values()].filter(
      (r) => r.pool === pool && r.terminal === null,
    ).length;
  }
  /**
   * A terminal is stored: only its actual size stays charged (design C5
   * §7.2 "容量"). The unused part of the maximum reply is released, and so
   * is the CallInspection credit when no inspection used it.
   */
  settleOriginal(o: OriginalRecord, replyBytes: number): void {
    if (o.settled) return;
    o.settled = true;
    const unused = Math.max(0, o.R - replyBytes);
    if (o.pool === "mutation") this.usage.mutationBytes -= unused;
    else this.usage.readBytes -= unused;
    if (o.credit) {
      this.usage.readBytes -= o.I + o.R + 2048;
      this.usage.inspectionIdsReserved--;
      this.usage.inspectionAttemptsReserved--;
      o.credit = false;
    }
    for (const a of this.attempts.values())
      if (a.query.original === o && a.outcome) this.releaseAttempt(a);
    this.dirty = true;
  }
  /** An answered CallInspection attempt of a settled original. */
  releaseAttempt(a: AttemptRecord): void {
    if (a.released) return;
    a.released = true;
    this.usage.readBytes -= a.R;
  }
  awaitingObservation() {
    return [...this.observationAttempts.values()].filter(
      (a) => a.reply === null && !a.abandoned,
    ).length;
  }
  pendingInspection() {
    return [...this.attempts.values()].filter((a) => a.outcome === null).length;
  }
  gate(original = false): LedgerError | null {
    return this.disposed
      ? "disposed"
      : this.stoppedReason
        ? "protocolViolation"
        : original && this.retired
          ? "retired"
          : null;
  }
  stop(reason: "protocolViolation" | "invalidDocument") {
    if (this.stoppedReason === null) {
      this.stoppedReason = reason;
      this.dirty = true;
    }
  }
  fail(
    reason: "protocolViolation" | "invalidDocument",
    attemptStored = false,
  ): DeliveryAcceptResult {
    this.stop(reason);
    return rejected(reason, false, attemptStored);
  }
  canAdd(base: number, add: number, limit: number) {
    requireLedger(
      Number.isSafeInteger(add) &&
        add >= 0 &&
        Number.isSafeInteger(base + add) &&
        base + add <= limit,
      "capacity",
    );
  }
  nextSequence() {
    requireLedger(Number.isSafeInteger(this.sequence + 1), "capacity");
    return this.sequence + 1;
  }
  view(): DeliveryLedgerState {
    return Object.freeze({
      scope: this.scope,
      retired: this.retired,
      disposed: this.disposed,
      stoppedReason: this.stoppedReason,
      usage: Object.freeze({
        ...this.usage,
        awaitingMutationTerminal: this.pending("mutation"),
        awaitingReadTerminal: this.pending("read"),
        awaitingInspectionReply: this.pendingInspection(),
        awaitingObservationReply: this.awaitingObservation(),
        pendingObservationQueries: [...this.observationQueries.values()].filter(
          (q) => q.terminal === null,
        ).length,
      }),
    });
  }
}
