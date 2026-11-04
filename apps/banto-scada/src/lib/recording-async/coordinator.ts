/** External composition root owns this coordinator beyond App/view lifetimes. */
import {
  parseRecordingOperationsContext,
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
  type RecordingAdmissionInspectionReply,
  type RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import { sameOwnedJson } from "../json-equality";
import { freezeHistory } from "../history/owned-json";
import { data, mergeResult, receiptKey } from "../recording-operations/view";
import type { AppliedSuccess } from "../recording-operations/service";
import type {
  AsyncRecordingOperationsPort,
  LocalOwnerFrame,
  LocalCancelRequest,
} from "./port";
import {
  fields,
  id,
  parseLeaseReply,
  parseCancelReply,
  parseOwnerFrame,
  onPromise,
} from "./local-validation";
import { createIdPools } from "./ids";
import type {
  AsyncOperationsClient,
  AsyncOperationsState,
  ViewLease,
  IntentControl,
  ReadControl,
  AdmissionPhase,
} from "./state";
export type * from "./state";
const roots = new WeakSet<object>();
const clients = new WeakSet<object>();
export function isAsyncOperationsClient(
  value: unknown,
): value is AsyncOperationsClient {
  return !!value && typeof value === "object" && clients.has(value);
}
const methodNames = [
  "prepareLease",
  "admit",
  "inspectAdmission",
  "observeOperation",
  "observeReconciliation",
  "current",
  "subscribe",
  "requestCancel",
] as const;
interface View {
  identity: object;
  active: boolean;
}
interface OperationTrack {
  ref: string;
  request: RecordingOperationRequest;
  completion?: Promise<unknown>;
  settled: boolean;
  original?: RecordingOperationResult;
  latest?: RecordingOperationResult;
  cancelIssued?: boolean;
}
interface ReadTrack {
  ref: string;
  request: RecordingReconciliationRequest;
  reply: RecordingAdmissionReply;
  completion?: Promise<unknown>;
  settled: boolean;
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
  port: AsyncRecordingOperationsPort,
  now = () => performance.now(),
) {
  if (!port || typeof port !== "object" || roots.has(port))
    throw Error("Recording async owner: duplicate or invalid port");
  const context = parseRecordingOperationsContext(data(port, "context")),
    rawOwner = data(port, "ownerRef");
  id(rawOwner);
  const ownerRef: string = rawOwner;
  const methods = Object.fromEntries(
    methodNames.map((k) => {
      const m = data(port, k);
      if (typeof m !== "function") throw Error("invalid port");
      return [k, m];
    }),
  ) as Pick<AsyncRecordingOperationsPort, (typeof methodNames)[number]>;
  // This tombstone is never removed on close; recreation cannot clear uncertainty.
  roots.add(port);
  const prefix = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const pools = createIdPools(prefix),
    listeners = new Set<(s: AsyncOperationsState) => void>();
  let workflow: Workflow | undefined,
    call: Intent | undefined,
    frame: LocalOwnerFrame | undefined;
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
    notifying = false;
  function intact(): boolean {
    try {
      if (
        data(port, "ownerRef") !== ownerRef ||
        !sameOwnedJson(
          parseRecordingOperationsContext(data(port, "context")),
          context,
        )
      )
        throw Error("changed context");
      for (const k of methodNames)
        if (data(port, k) !== methods[k]) throw Error("changed method");
      return true;
    } catch {
      invalid = true;
      publish();
      return false;
    }
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
  function common() {
    return (
      !closed &&
      !invalid &&
      connected &&
      inspectCall === "idle" &&
      cancelCall === "idle" &&
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
      mutable = base && !ownerBlocked && normalOperation();
    return Object.freeze({
      context,
      ownerRef,
      connected,
      closed,
      invalid,
      ownerBlocked,
      timedOut,
      refusal,
      admission,
      request,
      reply,
      inspection,
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
  function gate(view: View, allowBlocked = false) {
    return (
      view.active && intact() && common() && (allowBlocked || !ownerBlocked)
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
    if (t.delivery && !sameOwnedJson(t.delivery, d))
      throw Error("changed read");
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
    if (old?.quiescence === "confirmed" && next.quiescence !== "confirmed")
      throw Error("quiescence rollback");
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
      settled: false,
    };
    w.operations[t.request.stage] = t;
    w.current = t;
    const raw = methods.observeOperation.call(port, t.ref);
    fields(raw, ["operationRef", "request", "completion"]);
    if (
      data(raw, "operationRef") !== t.ref ||
      !sameOwnedJson(
        parseRecordingOperationRequest(data(raw, "request")),
        t.request,
      )
    )
      throw Error("wrong observation");
    const promise = data(raw, "completion");
    onPromise(
      promise,
      (v) => {
        try {
          const original = parseRecordingOperationResult(v);
          if (!sameOwnedJson(original.request, t.request))
            throw Error("wrong completion");
          opResult(t, original);
          t.original = original;
          t.settled = true;
          applyFrameEvidence();
          if (workflow === w && workflowFinished() && normalOperation())
            releaseCredits();
        } catch {
          invalid = true;
        }
        publish();
      },
      () => {
        invalid = true;
        publish();
      },
    );
    t.completion = promise as Promise<unknown>;
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
      reply: accepted,
      settled: false,
    };
    w.read = t;
    readPhase = "accepted";
    const raw = methods.observeReconciliation.call(port, t.ref);
    fields(raw, ["readRef", "request", "completion"]);
    if (
      data(raw, "readRef") !== t.ref ||
      !sameOwnedJson(
        parseRecordingReconciliationRequest(data(raw, "request")),
        t.request,
      )
    )
      throw Error("wrong observation");
    const promise = data(raw, "completion");
    onPromise(
      promise,
      (v) => {
        try {
          readResult(t, v);
          t.settled = true;
          applyFrameEvidence();
        } catch {
          invalid = true;
          readPhase = "deliveryUnknown";
        }
        publish();
      },
      () => {
        invalid = true;
        readPhase = "deliveryUnknown";
        publish();
      },
    );
    t.completion = promise as Promise<unknown>;
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
  function incoming(input: unknown) {
    try {
      const next = parseOwnerFrame(input);
      if (next.ownerRef !== ownerRef || !sameOwnedJson(next.context, context))
        throw Error("wrong frame owner");
      if (
        next.admission &&
        (next.admission.request.ownerRef !== ownerRef ||
          !sameOwnedJson(next.admission.request.context, context))
      )
        throw Error("foreign admission");
      if (
        next.operation &&
        !sameOwnedJson(next.operation.result.request.change.context, context)
      )
        throw Error("foreign operation");
      if (
        next.reconciliation &&
        (next.reconciliation.ownerRef !== ownerRef ||
          !sameOwnedJson(
            next.reconciliation.request.operation.change.context,
            context,
          ))
      )
        throw Error("foreign read");
      if (frame) {
        if (next.revision === frame.revision) {
          if (!sameOwnedJson(next, frame)) throw Error("frame contradiction");
          return;
        }
        if (next.revision < frame.revision) {
          if (
            !sameOwnedJson({ ...next, revision: 0 }, { ...frame, revision: 0 })
          )
            throw Error("frame rollback");
          return;
        }
      }
      frame = next;
      connected = next.connected;
      ownerBlocked ||= next.ownerBlocked;
      if (
        next.admission &&
        request &&
        next.admission.request.admissionId === request.admissionId
      )
        integrate(next.admission);
      applyFrameEvidence();
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
    timedOut = false;
    refusal = undefined;
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
    const leaseRequest = freezeHistory({
      ownerRef,
      admissionId,
      context,
      requestedBudgetMs: ctl.requestedNativeBudgetMs,
    });
    try {
      onPromise(
        methods.prepareLease.call(port, leaseRequest),
        (raw) => {
          try {
            const lease = parseLeaseReply(raw);
            if (!sameOwnedJson(lease.request, leaseRequest))
              throw Error("wrong lease");
            if (lease.outcome.kind === "rejected") {
              refusal = lease.outcome.error;
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
            request = intent.request = parseRecordingAdmissionRequest({
              version: 1,
              kind: "recordingAdmissionRequest",
              ownerRef,
              admissionId,
              context,
              deadlineLeaseRef: lease.outcome.deadlineLeaseRef,
              action,
            });
            // Commit the irreversible point before external notifications / dispatch.
            intent.phase = "admit";
            admission = "awaitingAck";
            publish();
            if (
              !gate(view, action.kind === "reconcile") ||
              !time(ctl.intentDeadlineMonotonicMs)
            ) {
              finishUnsent(intent);
              return;
            }
            try {
              onPromise(
                methods.admit.call(port, request),
                (ack) => {
                  try {
                    integrate(ack);
                    clearTimeout(intent.timer);
                    if (call === intent) call = undefined;
                  } catch {
                    intent.phase = "uncertain";
                    invalid = true;
                    if (admission === "awaitingAck") admission = "unknown";
                    clearTimeout(intent.timer);
                  }
                  publish();
                },
                () => {
                  intent.phase = "uncertain";
                  invalid = true;
                  if (admission === "awaitingAck") admission = "unknown";
                  clearTimeout(intent.timer);
                  publish();
                },
              );
            } catch {
              intent.phase = "uncertain";
              invalid = true;
              if (admission === "awaitingAck") admission = "unknown";
              clearTimeout(intent.timer);
              publish();
            }
          } catch {
            intent.phase = "uncertain";
            invalid = true;
            clearTimeout(intent.timer);
            publish();
          }
        },
        () => {
          intent.phase = "uncertain";
          invalid = true;
          clearTimeout(intent.timer);
          publish();
        },
      );
    } catch {
      intent.phase = "uncertain";
      invalid = true;
      clearTimeout(intent.timer);
      publish();
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
      if (!pools.reserve({ inspection: 1 })) {
        refusal = "capacity";
        publish();
        return false;
      }
      const r = parseRecordingAdmissionInspectionRequest({
        version: 1,
        kind: "recordingAdmissionInspectionRequest",
        inspectionId: pools.take("inspection"),
        original: request,
      });
      inspectCall = "pending";
      inspection = undefined;
      inspectTimer = arm(end, () => {
        if (inspectCall === "pending") {
          timedOut = true;
          publish();
        }
      });
      publish();
      if (
        !view.active ||
        closed ||
        !intact() ||
        !connected ||
        invalid ||
        !time(end)
      ) {
        inspectCall = "idle";
        clearTimeout(inspectTimer);
        publish();
        return true;
      }
      try {
        onPromise(
          methods.inspectAdmission.call(port, r),
          (raw) => {
            try {
              const v = parseRecordingAdmissionInspectionReply(raw);
              if (!sameOwnedJson(v.request, r)) throw Error("wrong inspection");
              inspection = v;
              if (v.outcome.kind === "found") integrate(v.outcome.reply);
              inspectCall = "idle";
            } catch {
              inspectCall = "uncertain";
              invalid = true;
            }
            clearTimeout(inspectTimer);
            publish();
          },
          () => {
            inspectCall = "uncertain";
            invalid = true;
            clearTimeout(inspectTimer);
            publish();
          },
        );
      } catch {
        inspectCall = "uncertain";
        invalid = true;
        clearTimeout(inspectTimer);
        publish();
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
    const r: LocalCancelRequest = freezeHistory({
      ownerRef,
      target: { kind: read ? "reconciliation" : "operation", ref: t.ref },
    });
    t.cancelIssued = true;
    cancelCall = "pending";
    cancel = undefined;
    publish();
    if (!view.active || closed || !intact() || !connected || invalid) {
      cancelCall = "idle";
      publish();
      return true;
    }
    try {
      onPromise(
        methods.requestCancel.call(port, r),
        (raw) => {
          try {
            const v = parseCancelReply(raw);
            if (!sameOwnedJson(v.request, r)) throw Error("wrong cancel");
            cancel = v.disposition;
            cancelCall = "idle";
          } catch {
            cancelCall = "uncertain";
            invalid = true;
          }
          publish();
        },
        () => {
          cancelCall = "uncertain";
          invalid = true;
          publish();
        },
      );
    } catch {
      cancelCall = "uncertain";
      invalid = true;
      publish();
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
    bindView(identity: object): ViewLease {
      if (closed || !identity || typeof identity !== "object")
        throw Error("Recording async owner closed");
      const view: View = { identity, active: true };
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
    const off = methods.subscribe.call(port, incoming);
    if (typeof off !== "function") throw Error("invalid subscription");
    unsubscribe = off;
    incoming(methods.current.call(port));
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
