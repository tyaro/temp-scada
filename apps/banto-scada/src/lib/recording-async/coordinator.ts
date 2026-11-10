/** External composition root owns this coordinator beyond App/view lifetimes. */
import {
  parseRecordingChangeRequest,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
  type RecordingChangeRequest,
  type RecordingOperationRequest,
  type RecordingOperationResult,
  type RecordingReconciliationRequest,
} from "../recording-operations-contract";
import {
  parseRecordingAdmissionRequest,
  parseRecordingAdmissionReply,
  parseRecordingAdmissionInspectionRequest,
  parseRecordingAdmissionInspectionReply,
  parseRecordingReconciliationDelivery,
  type RecordingAdmissionAction,
  type RecordingAdmissionRequest,
  type RecordingAdmissionReply,
  type RecordingAdmissionInspectionRequest,
  type RecordingAdmissionInspectionReply,
  type RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import {
  parseRecordingWireLeaseRequest,
  parseRecordingWireLeaseReply,
  parseRecordingWireCancelRequest,
  parseRecordingWireCancelReply,
  parseRecordingWireObservationReply,
  parseRecordingWireCallInspectionRequest,
  parseRecordingWireCallInspectionReply,
  type RecordingWireObservationTarget,
  type RecordingWireCancelRequest,
  type RecordingWireError,
  type RecordingWireCallInspectionReply,
  type RecordingWireOwnerSnapshot,
} from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import { freezeHistory } from "../history/owned-json";
import { data, mergeResult, receiptKey } from "../recording-operations/view";
import type { AppliedSuccess } from "../recording-operations/service";
import {
  isAsyncRecordingPortV2,
  type AsyncRecordingOperationsPortV2,
  type PortCallV2,
  type PortHostRefusal,
  type PortLeaseRequestV2,
  type PortStateV2,
  type PortTransportEnd,
} from "./port";
import {
  fields,
  parsePortState,
  parseTransportEnd,
  onPromise,
} from "./local-validation";
import { createIdPools, type IdRole } from "./ids";
import type {
  AsyncOperationsClient,
  AsyncOperationsState,
  ViewLease,
  IntentControl,
  ReadControl,
  AdmissionPhase,
  AsyncOwnerState,
} from "./state";
export type * from "./state";
const roots = new WeakSet<object>();
const clients = new WeakSet<object>();
export function isAsyncOperationsClient(
  value: unknown,
): value is AsyncOperationsClient {
  return !!value && typeof value === "object" && clients.has(value);
}
interface View {
  identity: object;
  active: boolean;
  qualifies: () => boolean;
}
interface OperationTrack {
  ref: string;
  request: RecordingOperationRequest;
  target: RecordingWireObservationTarget;
  completion?: Promise<unknown>;
  settled: boolean;
  /** The observation ended without a terminal (`unavailable` or transport lost). */
  lost?: boolean;
  original?: RecordingOperationResult;
  latest?: RecordingOperationResult;
  cancelIssued?: boolean;
}
interface ReadTrack {
  ref: string;
  request: RecordingReconciliationRequest;
  target: RecordingWireObservationTarget;
  reply: RecordingAdmissionReply;
  completion?: Promise<unknown>;
  settled: boolean;
  lost?: boolean;
  delivery?: RecordingReconciliationDelivery;
  cancelIssued?: boolean;
}
interface Workflow {
  identity: object;
  change: RecordingChangeRequest;
  changeRef?: string;
  operations: Partial<
    Record<RecordingOperationRequest["stage"], OperationTrack>
  >;
  current?: OperationTrack;
  read?: ReadTrack;
  credits: { mutationAdmission: number; callerOperation: number };
  attempted: Partial<
    Record<"preflight" | "pauseJoin" | "apply" | "discard", boolean>
  >;
}
interface Intent {
  view: View;
  control: IntentControl;
  action: RecordingAdmissionAction;
  admissionId: string;
  phase: "lease" | "admit" | "uncertain";
  request?: RecordingAdmissionRequest;
  timer?: ReturnType<typeof setTimeout>;
}
/** Clock injection supports deterministic tests; it never converts native time. */
export function createAsyncRecordingOperationsCoordinator(
  port: AsyncRecordingOperationsPortV2,
  now = () => performance.now(),
) {
  // Membership only: a structural `version: 2`, a Proxy or a v1 port is refused.
  if (!isAsyncRecordingPortV2(port))
    throw Error("Recording async owner: port v2 required");
  if (roots.has(port))
    throw Error("Recording async owner: duplicate or invalid port");
  const scope = port.scope,
    context = scope.context,
    ownerRef = scope.ownerRef,
    access = port.access;
  // This tombstone is never removed on close; recreation cannot clear uncertainty.
  roots.add(port);
  const prefix = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const pools = createIdPools(prefix),
    listeners = new Set<(s: AsyncOperationsState) => void>();
  let workflow: Workflow | undefined,
    call: Intent | undefined,
    frame: RecordingWireOwnerSnapshot | undefined;
  let owner: AsyncOwnerState = Object.freeze({
    access,
    seq: null,
    subscription: "idle",
    ended: null,
    ownerClosed: null,
    authorizationLost: null,
    resyncRequired: false,
    nativeRecoveryRequired: false,
  });
  let hostRefusal: PortHostRefusal | undefined,
    wireRefusal: RecordingWireError | undefined;
  /** The admit whose reply was lost (transport ended without a reply). */
  let lostAdmit:
      | PortCallV2<RecordingAdmissionRequest, RecordingAdmissionReply>
      | undefined,
    callInspection: RecordingWireCallInspectionReply | undefined;
  let closed = false,
    invalid = false,
    ownerBlocked = false,
    connected = false,
    timedOut = false;
  let admission: AdmissionPhase = "idle",
    request: RecordingAdmissionRequest | undefined,
    reply: RecordingAdmissionReply | undefined;
  let inspection: RecordingAdmissionInspectionReply | undefined,
    inspectCall: AsyncOperationsState["inspectionCall"] = "idle",
    inspectTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelCall: AsyncOperationsState["cancelCall"] = "idle",
    cancel: AsyncOperationsState["cancel"];
  let readPhase: AsyncOperationsState["read"] = "idle",
    lastApplied: AppliedSuccess | undefined,
    refusal: AsyncOperationsState["refusal"];
  let state: AsyncOperationsState,
    notifying = false,
    qualifying = false;
  /** The port is frozen with bound methods; only the fixed scope is compared. */
  function intact(): boolean {
    if (port.scope === scope) return true;
    invalid = true;
    publish();
    return false;
  }
  function fault() {
    invalid = true;
    publish();
  }
  function unknownAdmission() {
    return (
      admission === "unknown" ||
      admission === "awaitingAck" ||
      admission === "preparingLease"
    );
  }
  function normalOperation() {
    const t = workflow?.current;
    return (
      !t ||
      (t.settled &&
        !!t.original &&
        t.latest?.quiescence === "confirmed" &&
        !t.latest.recoveryRequired)
    );
  }
  function readsClear() {
    return (
      !workflow?.read ||
      (workflow.read.settled &&
        workflow.read.delivery?.outcome.kind === "result")
    );
  }
  function ownerUsable() {
    return (
      !owner.ownerClosed && !owner.authorizationLost && !owner.resyncRequired
    );
  }
  function common(ownPending?: "inspection" | "cancel") {
    return (
      !closed &&
      !invalid &&
      connected &&
      ownerUsable() &&
      inspectCall === (ownPending === "inspection" ? "pending" : "idle") &&
      cancelCall === (ownPending === "cancel" ? "pending" : "idle") &&
      readPhase !== "readUncertain" &&
      readPhase !== "deliveryUnknown"
    );
  }
  function idleCalls() {
    return !call && !unknownAdmission() && readsClear();
  }
  function workflowFinished() {
    const r = workflow?.current?.latest;
    return (
      !workflow ||
      (!workflow.current && admission !== "unknown") ||
      (!!r &&
        r.outcome.kind !== "candidate" &&
        r.outcome.kind !== "paused" &&
        normalOperation())
    );
  }
  function safe() {
    return (
      !invalid &&
      !ownerBlocked &&
      idleCalls() &&
      normalOperation() &&
      workflowFinished() &&
      inspectCall === "idle" &&
      cancelCall === "idle" &&
      readPhase !== "readUncertain" &&
      readPhase !== "deliveryUnknown"
    );
  }
  function releaseCredits() {
    if (!workflow) return;
    pools.release(workflow.credits);
    workflow.credits = { mutationAdmission: 0, callerOperation: 0 };
  }
  function snapshot(): AsyncOperationsState {
    const t = workflow?.current,
      r = t?.latest;
    const base = common() && idleCalls(),
      mutable =
        base && access === "mutation" && !ownerBlocked && normalOperation();
    return Object.freeze({
      context,
      ownerRef,
      connected,
      closed,
      invalid,
      ownerBlocked,
      timedOut,
      refusal,
      wireRefusal,
      hostRefusal,
      owner,
      admission,
      request,
      reply,
      inspection,
      callInspection,
      call: call?.phase ?? "idle",
      inspectionCall: inspectCall,
      cancelCall,
      cancel,
      change: workflow?.change,
      identity: workflow?.identity,
      latest: r,
      completion: t?.original,
      lastApplied,
      read: readPhase,
      delivery: workflow?.read?.delivery,
      canPreflight: mutable && workflowFinished(),
      canPause: mutable && r?.outcome.kind === "candidate",
      canApply: mutable && r?.outcome.kind === "paused",
      canDiscard:
        mutable &&
        (r?.outcome.kind === "candidate" || r?.outcome.kind === "paused"),
      canInspect:
        common() &&
        admission === "unknown" &&
        !!request &&
        call?.phase !== "uncertain",
      canReconcile:
        base &&
        !!t?.settled &&
        !!t.original &&
        t.request.stage === "apply" &&
        !!r &&
        ((r.outcome.kind === "failed" && r.outcome.effect === "unconfirmed") ||
          (r.outcome.kind === "applied" &&
            (r.quiescence === "unknown" || r.recoveryRequired))),
      canCancel:
        common() &&
        access === "mutation" &&
        !!t &&
        !t.cancelIssued &&
        !t.settled &&
        t.request.stage !== "pauseJoin",
      canCancelRead:
        common() &&
        !!workflow?.read &&
        !workflow.read.cancelIssued &&
        !workflow.read.settled,
      safeToSwitch: safe(),
      pools: pools.current(),
    });
  }
  /** A reentrant notification replaces the snapshot, never queues old states. */
  function publish() {
    state = snapshot();
    if (notifying) return;
    notifying = true;
    try {
      // A listener may change state. Stop that delivery; it will see current() and
      // the next outer notification, without an unbounded reentrant drain loop.
      for (let pass = 0; pass < 2; pass++) {
        const emitted = state;
        for (const listener of [...listeners]) {
          if (state !== emitted) break;
          if (listeners.has(listener))
            try {
              listener(emitted);
            } catch {
              /* isolate */
            }
        }
        if (state === emitted) break;
      }
    } finally {
      notifying = false;
    }
  }
  function eligible(view: View) {
    if (!view.active || qualifying) return false;
    qualifying = true;
    try {
      if (view.qualifies() !== true) {
        view.active = false;
        return false;
      }
    } catch {
      view.active = false;
      return false;
    } finally {
      qualifying = false;
    }
    return view.active;
  }
  function gate(view: View, allowBlocked = false) {
    return (
      eligible(view) && intact() && common() && (allowBlocked || !ownerBlocked)
    );
  }
  function time(end: number) {
    const n = now();
    return (
      Number.isFinite(n) &&
      n >= 0 &&
      Number.isFinite(end) &&
      end > n &&
      end - n <= 10000
    );
  }
  function control(input: IntentControl): IntentControl {
    fields(input, ["intentDeadlineMonotonicMs", "requestedNativeBudgetMs"]);
    const end = data(input, "intentDeadlineMonotonicMs"),
      budget = data(input, "requestedNativeBudgetMs");
    if (
      typeof end !== "number" ||
      !time(end) ||
      !Number.isSafeInteger(budget) ||
      (budget as number) < 1 ||
      (budget as number) > 10000
    )
      throw Error("invalid control");
    return Object.freeze({
      intentDeadlineMonotonicMs: end,
      requestedNativeBudgetMs: budget as number,
    });
  }
  function arm(end: number, fire: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fire, Math.max(0, end - now()));
    return timer;
  }
  function opResult(t: OperationTrack, input: unknown) {
    const next = parseRecordingOperationResult(input);
    if (!sameOwnedJson(next.request, t.request)) throw Error("wrong operation");
    t.latest = mergeResult(t.latest, next);
    ownerBlocked ||= t.latest.recoveryRequired;
    if (t.latest.outcome.kind === "applied") {
      if (
        lastApplied &&
        sameOwnedJson(lastApplied.request, t.request) &&
        receiptKey(lastApplied.receipt) !== receiptKey(t.latest.outcome.receipt)
      )
        throw Error("receipt conflict");
      lastApplied = Object.freeze({
        request: t.request,
        receipt: t.latest.outcome.receipt,
      });
    }
  }
  function readResult(t: ReadTrack, input: unknown) {
    const d = parseRecordingReconciliationDelivery(input);
    if (
      d.ownerRef !== ownerRef ||
      d.readRef !== t.ref ||
      !sameOwnedJson(d.request, t.request)
    )
      throw Error("wrong read");
    if (t.delivery) {
      if (!sameOwnedJson(t.delivery, d)) throw Error("changed read");
      return;
    }
    t.delivery = d;
    if (d.outcome.kind === "readUncertain") {
      readPhase = "readUncertain";
      return;
    }
    const next = d.outcome.result,
      op = workflow?.current;
    if (!op || !sameOwnedJson(op.request, next.request.operation))
      throw Error("wrong original");
    const old = op.latest;
    if (next.outcome.kind === "receiptFound")
      opResult(op, {
        version: 1,
        kind: "recordingOperationResult",
        request: op.request,
        outcome: { kind: "applied", receipt: next.outcome.receipt },
        quiescence: next.quiescence,
        recoveryRequired:
          next.recoveryRequired || old?.recoveryRequired === true,
      });
    else if (old)
      opResult(op, {
        ...old,
        quiescence:
          old.quiescence === "confirmed" || next.quiescence === "confirmed"
            ? "confirmed"
            : "unknown",
        recoveryRequired: old.recoveryRequired || next.recoveryRequired,
      });
    readPhase = "completed";
  }
  function applyFrameEvidence() {
    if (!frame) return;
    const t = workflow?.current,
      r = workflow?.read;
    if (frame.operation && t) {
      if (frame.operation.operationRef === t.ref)
        opResult(t, frame.operation.result);
      else if (sameOwnedJson(frame.operation.result.request, t.request))
        throw Error("changed operation ref");
    }
    if (frame.reconciliation && r) {
      if (frame.reconciliation.readRef === r.ref)
        readResult(r, frame.reconciliation);
      else if (sameOwnedJson(frame.reconciliation.request, r.request))
        throw Error("changed read ref");
    }
  }
  /**
   * One physical port call. `reply` carries only the stored original reply and
   * `transport` the physical end; a transport end without a reply is `lost`.
   * A late reply (after CallInspection recovery) still reaches `onReply`.
   */
  function dispatch<Q, R>(
    send: () => unknown,
    expected: Q | ((request: unknown) => boolean),
    handlers: {
      reply: (raw: unknown) => void;
      lost: (end: PortTransportEnd) => void;
      fault: () => void;
    },
  ): PortCallV2<Q, R> {
    const c = send();
    fields(c, ["request", "reply", "transport"]);
    const q = data(c, "request");
    if (
      typeof expected === "function"
        ? !(expected as (request: unknown) => boolean)(q)
        : !sameOwnedJson(q, expected)
    )
      throw Error("changed request");
    let replied = false;
    onPromise(
      data(c, "reply"),
      (raw) => {
        replied = true;
        try {
          handlers.reply(raw);
        } catch {
          handlers.fault();
        }
      },
      handlers.fault,
    );
    onPromise(
      data(c, "transport"),
      (raw) => {
        let end: PortTransportEnd;
        try {
          end = parseTransportEnd(raw);
        } catch {
          handlers.fault();
          return;
        }
        if (end.kind === "refused") hostRefusal = end.refusal;
        if (end.kind !== "returned" && !replied) handlers.lost(end);
        else if (end.kind === "refused") publish();
      },
      handlers.fault,
    );
    return c as PortCallV2<Q, R>;
  }
  function takeId(role: IdRole): string | undefined {
    if (!pools.reserve({ [role]: 1 })) return undefined;
    return pools.take(role);
  }
  function lose(t: OperationTrack | ReadTrack) {
    if (t.settled || t.lost) return;
    t.lost = true;
    readPhase = "deliveryUnknown";
  }
  /** Only a terminal observation reply settles; `unavailable` is a terminal without a result. */
  function watch(t: OperationTrack | ReadTrack, done: (v: unknown) => void) {
    const raw = port.observe(t.target);
    fields(raw, ["target", "result"]);
    if (!sameOwnedJson(data(raw, "target"), t.target))
      throw Error("wrong observation");
    const promise = data(raw, "result");
    onPromise(
      promise,
      (v) => {
        try {
          const r = parseRecordingWireObservationReply(v);
          if (
            !sameOwnedJson(r.request.scope, scope) ||
            !sameOwnedJson(r.request.target, t.target)
          )
            throw Error("wrong observation");
          if (r.outcome.kind === "pending") throw Error("not terminal");
          if (r.outcome.kind === "unavailable") lose(t);
          else
            done(
              r.outcome.kind === "operation"
                ? r.outcome.result
                : r.outcome.delivery,
            );
        } catch {
          invalid = true;
          if ("reply" in t) readPhase = "deliveryUnknown";
        }
        publish();
      },
      () => {
        invalid = true;
        if ("reply" in t) readPhase = "deliveryUnknown";
        publish();
      },
    );
    t.completion = promise as Promise<unknown>;
  }
  function observeOperation(
    handle: Extract<
      RecordingAdmissionReply["outcome"],
      { kind: "accepted" }
    >["handle"],
  ) {
    if (handle.kind !== "operation" || !workflow) throw Error("wrong handle");
    const w = workflow,
      old = w.operations[handle.request.stage];
    if (old) {
      if (
        old.ref !== handle.operationRef ||
        !sameOwnedJson(old.request, handle.request)
      )
        throw Error("changed handle");
      return;
    }
    if (w.current && !w.current.settled) throw Error("overlapping operation");
    if (Object.values(w.operations).some((t) => t.ref === handle.operationRef))
      throw Error("reused operation ref");
    const t: OperationTrack = {
      ref: handle.operationRef,
      request: handle.request,
      target: freezeHistory({
        kind: "operation",
        operationRef: handle.operationRef,
        request: handle.request,
      }),
      settled: false,
    };
    w.operations[t.request.stage] = t;
    w.current = t;
    watch(t, (v) => {
      const original = parseRecordingOperationResult(v);
      if (!sameOwnedJson(original.request, t.request))
        throw Error("wrong completion");
      opResult(t, original);
      t.original = original;
      t.settled = true;
      applyFrameEvidence();
      if (workflow === w && workflowFinished() && normalOperation())
        releaseCredits();
    });
    applyFrameEvidence();
  }
  function observeRead(
    handle: Extract<
      RecordingAdmissionReply["outcome"],
      { kind: "accepted" }
    >["handle"],
    accepted: RecordingAdmissionReply,
  ) {
    if (handle.kind !== "reconciliation" || !workflow)
      throw Error("wrong handle");
    const w = workflow;
    if (w.read && !w.read.settled) throw Error("overlapping read");
    if (w.read?.ref === handle.readRef) throw Error("reused read ref");
    const t: ReadTrack = {
      ref: handle.readRef,
      request: handle.request,
      target: freezeHistory({
        kind: "reconciliation",
        readRef: handle.readRef,
        request: handle.request,
      }),
      reply: accepted,
      settled: false,
    };
    w.read = t;
    readPhase = "accepted";
    watch(t, (v) => {
      readResult(t, v);
      t.settled = true;
      applyFrameEvidence();
    });
    applyFrameEvidence();
  }
  function integrate(input: unknown) {
    const next = parseRecordingAdmissionReply(input);
    if (!request || !sameOwnedJson(next.request, request))
      throw Error("wrong admission");
    if (reply) {
      const a = reply.outcome.kind,
        b = next.outcome.kind;
      if (a !== "unknown" && b !== "unknown") {
        if (!sameOwnedJson(reply, next)) throw Error("contradictory admission");
        return;
      }
      if (a !== "unknown" && b === "unknown") return;
    }
    reply = next;
    if (next.outcome.kind === "unknown") {
      admission = "unknown";
      return;
    }
    if (next.outcome.kind === "rejected") {
      admission = "rejected";
      if (request.action.kind === "preflight") releaseCredits();
      if (request.action.kind === "reconcile") readPhase = "idle";
      return;
    }
    if (next.outcome.kind === "completedDiscard") {
      admission = "discarded";
      releaseCredits();
      workflow = undefined;
      readPhase = "idle";
      return;
    }
    if (next.outcome.kind !== "accepted") throw Error("invalid outcome");
    admission = "accepted";
    if (next.outcome.handle.kind === "operation") {
      if (
        workflow?.changeRef &&
        workflow.changeRef !== next.outcome.handle.changeRef
      )
        throw Error("changed candidate");
      if (workflow) workflow.changeRef = next.outcome.handle.changeRef;
      observeOperation(next.outcome.handle);
    } else observeRead(next.outcome.handle, next);
  }
  function snapshotEvidence(next: RecordingWireOwnerSnapshot) {
    if (
      next.admission &&
      (next.admission.request.ownerRef !== ownerRef ||
        !sameOwnedJson(next.admission.request.context, context))
    )
      throw Error("foreign admission");
    if (frame) {
      if (next.revision === frame.revision) {
        if (!sameOwnedJson(next, frame)) throw Error("frame contradiction");
        return;
      }
      if (next.revision < frame.revision) {
        if (!sameOwnedJson({ ...next, revision: 0 }, { ...frame, revision: 0 }))
          throw Error("frame rollback");
        return;
      }
    }
    frame = next;
    ownerBlocked ||= next.ownerBlocked;
    // Cached frames update `latest` knowledge only; never a call's own reply.
    if (
      next.admission &&
      request &&
      next.admission.request.admissionId === request.admissionId
    )
      integrate(next.admission);
    applyFrameEvidence();
  }
  function incoming(input: unknown) {
    try {
      const next: PortStateV2 = parsePortState(input, scope);
      if (next.access !== access) throw Error("changed access");
      owner = Object.freeze({
        access,
        seq: next.seq,
        subscription: next.subscription,
        ended: next.ended,
        ownerClosed: next.ownerClosed,
        authorizationLost: next.authorizationLost,
        resyncRequired: next.resyncRequired,
        nativeRecoveryRequired: next.nativeRecoveryRequired,
      });
      connected =
        next.display.transportConnected && next.subscription === "attached";
      ownerBlocked ||= next.nativeRecoveryRequired;
      for (const o of next.observations) {
        if (o.query !== "transportLost") continue;
        const t = workflow?.current,
          r = workflow?.read;
        if (t && sameOwnedJson(o.target, t.target)) lose(t);
        if (r && sameOwnedJson(o.target, r.target)) lose(r);
      }
      if (next.display.snapshot) snapshotEvidence(next.display.snapshot);
    } catch {
      invalid = true;
    }
    publish();
  }
  function finishUnsent(intent: Intent) {
    if (call !== intent) return;
    clearTimeout(intent.timer);
    call = undefined;
    admission = "idle";
    if (intent.action.kind === "preflight") {
      releaseCredits();
      workflow = undefined;
    }
    if (intent.action.kind === "reconcile") readPhase = "idle";
    publish();
  }
  function uncertain(intent: Intent) {
    intent.phase = "uncertain";
    clearTimeout(intent.timer);
    publish();
  }
  function leaseRequest(
    action: RecordingAdmissionAction,
    admissionId: string,
    leaseRequestId: string,
    budget: number,
  ): PortLeaseRequestV2 {
    const lease = parseRecordingWireLeaseRequest({
      version: 1,
      kind: "recordingWireLeaseRequest",
      scope,
      leaseRequestId,
      admissionId,
      role: action.kind === "reconcile" ? "reconciliation" : "mutation",
      requestedBudgetMs: budget,
    });
    return freezeHistory(
      action.kind === "reconcile"
        ? { role: "reconciliation", lease }
        : action.kind === "preflight"
          ? {
              role: "mutation",
              stage: "preflight",
              change: action.change,
              lease,
            }
          : action.kind === "discard"
            ? { role: "mutation", stage: "discard", lease }
            : {
                role: "mutation",
                stage: action.kind,
                operationId: action.operation.operationId,
                lease,
              },
    ) as PortLeaseRequestV2;
  }
  function admit(intent: Intent, view: View, deadlineLeaseRef: string) {
    const { action, admissionId, control: ctl } = intent;
    request = intent.request = parseRecordingAdmissionRequest({
      version: 1,
      kind: "recordingAdmissionRequest",
      ownerRef,
      admissionId,
      context,
      deadlineLeaseRef,
      action,
    });
    // Commit the irreversible point before external notifications / dispatch.
    intent.phase = "admit";
    admission = "awaitingAck";
    lostAdmit = undefined;
    callInspection = undefined;
    publish();
    if (
      !gate(view, action.kind === "reconcile") ||
      !time(ctl.intentDeadlineMonotonicMs)
    ) {
      finishUnsent(intent);
      return;
    }
    const sent = request;
    let c: PortCallV2<RecordingAdmissionRequest, RecordingAdmissionReply>;
    try {
      c = dispatch(() => port.admit(sent), sent, {
        reply(ack) {
          integrate(ack);
          if (lostAdmit === c) lostAdmit = undefined;
          clearTimeout(intent.timer);
          if (call === intent) call = undefined;
          publish();
        },
        lost() {
          // Acceptance is unknown, not a port fault: recover with CallInspection.
          if (request === sent && admission === "awaitingAck")
            admission = "unknown";
          if (request === sent) lostAdmit = c;
          clearTimeout(intent.timer);
          if (call === intent) call = undefined;
          publish();
        },
        fault() {
          invalid = true;
          if (admission === "awaitingAck") admission = "unknown";
          uncertain(intent);
        },
      });
    } catch {
      invalid = true;
      if (admission === "awaitingAck") admission = "unknown";
      uncertain(intent);
    }
  }
  function start(
    view: View,
    action: RecordingAdmissionAction,
    ctl: IntentControl,
    admissionId: string,
  ) {
    const intent: Intent = {
      view,
      action,
      control: ctl,
      admissionId,
      phase: "lease",
    };
    call = intent;
    admission = "preparingLease";
    request = undefined;
    reply = undefined;
    inspection = undefined;
    callInspection = undefined;
    lostAdmit = undefined;
    timedOut = false;
    refusal = undefined;
    wireRefusal = undefined;
    cancel = undefined;
    if (action.kind === "reconcile") readPhase = "awaitingAdmission";
    intent.timer = arm(ctl.intentDeadlineMonotonicMs, () => {
      if (call !== intent) return;
      timedOut = true;
      if (intent.phase === "admit" && admission === "awaitingAck")
        admission = "unknown";
      publish();
    });
    publish();
    if (
      !gate(view, action.kind === "reconcile") ||
      !time(ctl.intentDeadlineMonotonicMs)
    ) {
      finishUnsent(intent);
      return;
    }
    const leaseId = takeId("lease");
    if (!leaseId) {
      refusal = "capacity";
      finishUnsent(intent);
      return;
    }
    let lr: PortLeaseRequestV2;
    try {
      lr = leaseRequest(
        action,
        admissionId,
        leaseId,
        ctl.requestedNativeBudgetMs,
      );
    } catch {
      invalid = true;
      uncertain(intent);
      return;
    }
    try {
      dispatch(() => port.prepareLease(lr), lr, {
        reply(raw) {
          if (intent.phase !== "lease") return;
          const lease = parseRecordingWireLeaseReply(raw);
          if (!sameOwnedJson(lease.request, lr.lease))
            throw Error("wrong lease");
          if (lease.outcome.kind === "rejected") {
            wireRefusal = lease.outcome.error;
            finishUnsent(intent);
            return;
          }
          if (
            call !== intent ||
            !gate(view, action.kind === "reconcile") ||
            !time(ctl.intentDeadlineMonotonicMs)
          ) {
            finishUnsent(intent);
            return;
          }
          admit(intent, view, lease.outcome.deadlineLeaseRef);
        },
        lost() {
          // A lease may have been issued; it expires unused on the host.
          if (intent.phase === "lease") uncertain(intent);
        },
        fault() {
          invalid = true;
          if (intent.phase === "lease") uncertain(intent);
          else publish();
        },
      });
    } catch {
      invalid = true;
      uncertain(intent);
    }
  }
  function accept(
    view: View,
    kind: "preflight" | "pauseJoin" | "apply" | "discard" | "reconcile",
    input: unknown,
    ctl: IntentControl,
  ): boolean {
    try {
      const c = control(ctl);
      if (!gate(view, kind === "reconcile") || !idleCalls()) return false;
      const s = snapshot();
      const allowed =
        kind === "preflight"
          ? s.canPreflight
          : kind === "pauseJoin"
            ? s.canPause
            : kind === "apply"
              ? s.canApply
              : kind === "discard"
                ? s.canDiscard
                : s.canReconcile;
      if (!allowed) return false;
      if (
        (kind === "pauseJoin" || kind === "apply") &&
        workflow?.identity !== view.identity
      )
        return false;
      let action: RecordingAdmissionAction, admissionId: string;
      if (kind === "preflight") {
        const change = parseRecordingChangeRequest(input);
        if (!sameOwnedJson(change.context, context)) return false;
        if (!pools.reserve({ mutationAdmission: 4, callerOperation: 2 })) {
          refusal = "capacity";
          publish();
          return false;
        }
        releaseCredits();
        workflow = {
          identity: view.identity,
          change,
          operations: {},
          credits: { mutationAdmission: 4, callerOperation: 2 },
          attempted: {},
        };
        action = { kind, change };
      } else {
        const w = workflow!;
        if (
          kind !== "reconcile" &&
          w.attempted[kind] &&
          !pools.reserve({
            mutationAdmission: 1,
            callerOperation: kind === "discard" ? 0 : 1,
          })
        ) {
          refusal = "capacity";
          publish();
          return false;
        }
        if (kind === "reconcile") {
          if (!pools.reserve({ readAdmission: 1, reconciliation: 1 })) {
            refusal = "capacity";
            publish();
            return false;
          }
          action = {
            kind,
            changeRef: w.changeRef!,
            operationRef: w.current!.ref,
            reconciliation: parseRecordingReconciliationRequest({
              version: 1,
              kind: "recordingReconciliationRequest",
              reconciliationId: pools.take("reconciliation"),
              operation: w.current!.request,
            }),
          };
        } else if (kind === "discard")
          action = { kind, changeRef: w.changeRef!, change: w.change };
        else {
          if (!w.attempted[kind]) w.credits.callerOperation--;
          action = {
            kind,
            changeRef: w.changeRef!,
            operation: parseRecordingOperationRequest({
              version: 1,
              kind: "recordingOperationRequest",
              operationId: pools.take("callerOperation"),
              stage: kind,
              change: w.change,
            }),
          };
        }
      }
      if (kind === "reconcile") admissionId = pools.take("readAdmission");
      else {
        if (!workflow) throw Error("missing workflow");
        if (!workflow.attempted[kind]) workflow.credits.mutationAdmission--;
        workflow.attempted[kind] = true;
        admissionId = pools.take("mutationAdmission");
      }
      start(view, freezeHistory(action), c, admissionId);
      return true;
    } catch {
      return false;
    }
  }
  function inspect(view: View, ctl: ReadControl): boolean {
    try {
      fields(ctl, ["deadlineMonotonicMs"]);
      const end = data(ctl, "deadlineMonotonicMs");
      if (
        typeof end !== "number" ||
        !time(end) ||
        !gate(view, true) ||
        !snapshot().canInspect ||
        !request
      )
        return false;
      // A lost admit reply is recovered from the host ledger (CallInspection),
      // never by resending the admit. A received `unknown` uses AdmissionInspection.
      const lost = lostAdmit;
      let r: RecordingAdmissionInspectionRequest | undefined;
      if (!lost) {
        if (!pools.reserve({ inspection: 1 })) {
          refusal = "capacity";
          publish();
          return false;
        }
        r = parseRecordingAdmissionInspectionRequest({
          version: 1,
          kind: "recordingAdmissionInspectionRequest",
          inspectionId: pools.take("inspection"),
          original: request,
        });
      }
      const original = request;
      inspectCall = "pending";
      inspection = undefined;
      callInspection = undefined;
      inspectTimer = arm(end, () => {
        if (inspectCall === "pending") {
          timedOut = true;
          publish();
        }
      });
      publish();
      if (
        !eligible(view) ||
        !intact() ||
        !common("inspection") ||
        admission !== "unknown" ||
        call?.phase === "uncertain" ||
        lostAdmit !== lost ||
        !time(end)
      ) {
        inspectCall = "idle";
        clearTimeout(inspectTimer);
        publish();
        return true;
      }
      const done = () => {
        clearTimeout(inspectTimer);
        publish();
      };
      const handlers = {
        lost() {
          // Read-only: a lost inspection reply leaves the admission unknown and retryable.
          inspectCall = "idle";
          done();
        },
        fault() {
          inspectCall = "uncertain";
          invalid = true;
          done();
        },
      };
      try {
        if (lost)
          dispatch(
            () => port.inspectCall(lost),
            (q) => {
              const v = parseRecordingWireCallInspectionRequest(q);
              return (
                sameOwnedJson(v.scope, scope) &&
                sameOwnedJson(v.original, original)
              );
            },
            {
              ...handlers,
              reply(raw) {
                const v = parseRecordingWireCallInspectionReply(raw);
                if (
                  !sameOwnedJson(v.request.scope, scope) ||
                  !sameOwnedJson(v.request.original, original)
                )
                  throw Error("wrong call inspection");
                callInspection = v;
                if (v.outcome.kind === "terminal") {
                  integrate(v.outcome.reply);
                  if (lostAdmit === lost) lostAdmit = undefined;
                }
                inspectCall = "idle";
                done();
              },
            },
          );
        else
          dispatch(() => port.inspectAdmission(r!), r!, {
            ...handlers,
            reply(raw) {
              const v = parseRecordingAdmissionInspectionReply(raw);
              if (!sameOwnedJson(v.request, r)) throw Error("wrong inspection");
              inspection = v;
              if (v.outcome.kind === "found") integrate(v.outcome.reply);
              inspectCall = "idle";
              done();
            },
          });
      } catch {
        handlers.fault();
      }
      return true;
    } catch {
      return false;
    }
  }
  function cancelTarget(view: View, read: boolean): boolean {
    if (
      !gate(view, true) ||
      !(read ? snapshot().canCancelRead : snapshot().canCancel)
    )
      return false;
    const t = read ? workflow?.read : workflow?.current;
    if (!t) return false;
    if (!pools.reserve({ cancel: 1 })) {
      refusal = "capacity";
      publish();
      return false;
    }
    let r: RecordingWireCancelRequest;
    try {
      r = parseRecordingWireCancelRequest({
        version: 1,
        kind: "recordingWireCancelRequest",
        scope,
        cancelId: pools.take("cancel"),
        target: { kind: read ? "reconciliation" : "operation", ref: t.ref },
      });
    } catch {
      return false;
    }
    cancelCall = "pending";
    cancel = undefined;
    publish();
    if (!eligible(view) || !intact() || !common("cancel")) {
      cancelCall = "idle";
      publish();
      return true;
    }
    t.cancelIssued = true;
    const fault = () => {
      cancelCall = "uncertain";
      invalid = true;
      publish();
    };
    try {
      dispatch(() => port.requestCancel(r), r, {
        reply(raw) {
          const v = parseRecordingWireCancelReply(raw);
          if (!sameOwnedJson(v.request, r)) throw Error("wrong cancel");
          if (v.outcome.kind === "ack") cancel = v.outcome.disposition;
          else wireRefusal = v.outcome.error;
          cancelCall = "idle";
          publish();
        },
        lost() {
          // The cancel may have reached the host; its delivery stays uncertain.
          cancelCall = "uncertain";
          publish();
        },
        fault,
      });
    } catch {
      fault();
    }
    return true;
  }
  const client: AsyncOperationsClient = Object.freeze({
    context,
    ownerRef,
    current: () => state,
    subscribe(listener: (s: AsyncOperationsState) => void) {
      listeners.add(listener);
      try {
        listener(state);
      } catch {
        /* isolate */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    bindView(
      identity: object,
      qualifies: () => boolean = () => true,
    ): ViewLease {
      if (
        closed ||
        !identity ||
        typeof identity !== "object" ||
        typeof qualifies !== "function"
      )
        throw Error("Recording async owner closed");
      const view: View = { identity, active: true, qualifies };
      return Object.freeze({
        preflight: (change: RecordingChangeRequest, c: IntentControl) =>
          accept(view, "preflight", change, c),
        pause: (c: IntentControl) => accept(view, "pauseJoin", null, c),
        apply: (c: IntentControl) => accept(view, "apply", null, c),
        discard: (c: IntentControl) => accept(view, "discard", null, c),
        reconcile: (c: IntentControl) => accept(view, "reconcile", null, c),
        inspectAdmission: (c: ReadControl) => inspect(view, c),
        cancelOperation: () => cancelTarget(view, false),
        cancelReconciliation: () => cancelTarget(view, true),
        retire() {
          view.active = false;
        },
      });
    },
  });
  clients.add(client);
  publish();
  let unsubscribe: (() => void) | undefined;
  try {
    const off = port.subscribe(incoming);
    if (typeof off !== "function") throw Error("invalid subscription");
    unsubscribe = off;
    incoming(port.current());
  } catch {
    fault();
  }
  return Object.freeze({
    client,
    close() {
      if (closed) return;
      closed = true;
      publish();
      // Keep monitoring issued work. No automatic cancel, shutdown or root reset.
      if (safe())
        try {
          unsubscribe?.();
        } catch {
          /* no native effect */
        }
    },
  });
}
