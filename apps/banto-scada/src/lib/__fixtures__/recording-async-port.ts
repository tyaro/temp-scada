/** Controlled port v2 provider; no native adapter, Hub, database or production import. */
import fixtures from "../../../../../examples/recording-operations-cases.json";
import { operationsProject } from "./recording-operations-service";
import type { Project } from "../project";
import {
  parseRecordingOperationsContext,
  parseRecordingOperationResult,
  parseRecordingReconciliationResult,
  type RecordingOperationRequest,
} from "../recording-operations-contract";
import {
  parseRecordingAdmissionReply,
  type RecordingAdmissionRequest,
  type RecordingAdmissionReply,
  type RecordingAdmissionInspectionRequest,
  type RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import type {
  RecordingWireScope,
  RecordingWireObservationTarget,
  RecordingWireOwnerSnapshot,
  RecordingWireCancelRequest,
  RecordingWireError,
} from "../recording-wire-contract";
import {
  defineAsyncRecordingPortV2,
  type AsyncRecordingPortV2Impl,
  type PortCallV2,
  type PortHostRefusal,
  type PortLeaseRequestV2,
  type PortStateV2,
  type PortTransportEnd,
} from "../recording-async/port";
export function deferred<T = unknown>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
/**
 * One controllable port call. `resolve` returns the stored reply and ends the
 * transport normally; `reject` ends the transport without a reply (lost);
 * `refuse` is a host `{kind}` refusal.
 */
export function portCall<Q, R = unknown>(request: Q) {
  const reply = deferred<R>(),
    transport = deferred<PortTransportEnd>();
  const call: PortCallV2<Q, R> = Object.freeze({
    request,
    reply: reply.promise,
    transport: transport.promise,
  });
  return {
    request,
    call,
    resolve(v: R) {
      reply.resolve(v);
      transport.resolve({ kind: "returned" });
    },
    reply: (v: R) => reply.resolve(v),
    end: (v: PortTransportEnd) => transport.resolve(v),
    reject(_?: unknown) {
      transport.resolve({ kind: "failed" });
    },
    refuse(refusal: PortHostRefusal) {
      transport.resolve({ kind: "refused", refusal });
    },
  };
}
type Call<Q> = ReturnType<typeof portCall<Q>>;
export interface OwnerPatch {
  connected: boolean;
  ownerBlocked: boolean;
  admission: RecordingAdmissionReply | null;
  operation: RecordingWireOwnerSnapshot["operation"];
  reconciliation: RecordingReconciliationDelivery | null;
  subscription: PortStateV2["subscription"];
  seq: number | null;
  ended: string | null;
  ownerClosed: PortStateV2["ownerClosed"];
  authorizationLost: PortStateV2["authorizationLost"];
  resyncRequired: boolean;
  snapshotRelation: "none" | "currentSubscription" | "lastKnown";
}
export function createAsyncPortHarness(
  project: Project = operationsProject,
  options: Partial<{ access: "mutation" | "read"; ownerEpoch: string }> = {},
) {
  const context = parseRecordingOperationsContext({
      ...fixtures.bases.context,
      target: {
        ...fixtures.bases.context.target,
        projectId: project.manifest.projectId,
        projectRevision: project.manifest.projectRevision,
      },
    }),
    ownerRef = "owner:async-test",
    access = options.access ?? "mutation";
  const scope: RecordingWireScope = {
    ownerRef,
    ownerEpoch: options.ownerEpoch ?? "epoch:1",
    context,
  };
  let owner: OwnerPatch = {
    connected: true,
    ownerBlocked: false,
    admission: null,
    operation: null,
    reconciliation: null,
    subscription: "attached",
    seq: 1,
    ended: null,
    ownerClosed: null,
    authorizationLost: null,
    resyncRequired: false,
    snapshotRelation: "currentSubscription",
  };
  let revision = 1;
  const lostTargets: RecordingWireObservationTarget[] = [];
  function build(): PortStateV2 {
    const snapshot: RecordingWireOwnerSnapshot = {
      scope,
      revision,
      closed: owner.ownerClosed !== null,
      ownerBlocked: owner.ownerBlocked,
      admission: owner.admission,
      operation: owner.operation,
      reconciliation: owner.reconciliation,
    };
    const relation = owner.snapshotRelation;
    return {
      version: 2,
      scope,
      access,
      seq: owner.seq,
      display: {
        scope,
        transportConnected: owner.connected,
        receiverStatus: owner.resyncRequired ? "resyncRequired" : "ready",
        receiverStoppedReason: null,
        generation: {
          attachId: "attach:1",
          phase: "attached",
          subscriptionRef: "subscription:1",
        },
        ownerClosed: owner.ownerClosed !== null,
        nativeRecoveryRequired: owner.ownerBlocked,
        authorizationLost: owner.authorizationLost !== null,
        highwater: revision,
        snapshotRelation: relation,
        snapshot: relation === "none" ? null : snapshot,
        usage: {
          attachIds: 1,
          controlIds: 0,
          snapshotRevisions: 1,
          snapshotBytes: 0,
          callBytes: 0,
          pendingAttach: 0,
          pendingControl: 0,
          stateSlot: 0,
          controlSlot: 0,
        },
      },
      subscription: owner.subscription,
      ended: owner.ended,
      ownerClosed: owner.ownerClosed,
      authorizationLost: owner.authorizationLost,
      resyncRequired: owner.resyncRequired,
      nativeRecoveryRequired: owner.ownerBlocked,
      observations: lostTargets.map((target) => ({
        target,
        query: "transportLost" as const,
        attemptsInFlight: 0,
      })),
      usage: {
        ledger: {} as PortStateV2["usage"]["ledger"],
        receiver: {} as PortStateV2["usage"]["receiver"],
      },
    };
  }
  let frame = build();
  const listeners = new Set<(v: unknown) => void>();
  const leases: Call<PortLeaseRequestV2>[] = [];
  const admissions: (Call<RecordingAdmissionRequest> & {
    accepted?: RecordingAdmissionReply;
  })[] = [];
  type Observed = {
    handle: Readonly<{
      operationRef: string;
      request: RecordingOperationRequest;
    }>;
    target: RecordingWireObservationTarget;
    settled: boolean;
    observed: number;
  } & Observation;
  type ObservedRead = {
    handle: Readonly<{
      readRef: string;
      request: import("../recording-operations-contract").RecordingReconciliationRequest;
    }>;
    target: RecordingWireObservationTarget;
    settled: boolean;
    observed: number;
  } & Observation;
  /**
   * The terminal of one observation target. `resolve` takes the raw result or
   * delivery; `reject` loses the query (`transportLost`); `unavailable` ends it.
   */
  type Observation = ReturnType<typeof observation>;
  function observation(target: () => RecordingWireObservationTarget) {
    const d = deferred<unknown>();
    return {
      promise: d.promise,
      resolve(v: unknown) {
        const t = target();
        d.resolve(
          observationReply(
            t,
            t.kind === "operation"
              ? { kind: "operation", result: v }
              : { kind: "reconciliation", delivery: v },
          ),
        );
      },
      unavailable(error: RecordingWireError = "ownerUnavailable") {
        d.resolve(observationReply(target(), { kind: "unavailable", error }));
      },
      reject(_?: unknown) {
        lostTargets.push(target());
        emit();
      },
    };
  }
  const operations: Observed[] = [];
  const reads: ObservedRead[] = [];
  const inspections: Call<RecordingAdmissionInspectionRequest>[] = [];
  const callInspections: (Call<unknown> & { original: unknown })[] = [];
  const cancels: Call<RecordingWireCancelRequest>[] = [];
  let autoLease = true,
    autoAck = true,
    autoInspect = true,
    autoCancel = true,
    stops = 0,
    writes = 0,
    observationIds = 0;
  let nativeNow = 0;
  const issued = new Map<
    string,
    { request: PortLeaseRequestV2; expires: number; used: boolean }
  >();
  function emit(patch: Partial<OwnerPatch> = {}) {
    owner = { ...owner, ...patch };
    revision++;
    frame = build();
    for (const fn of [...listeners]) if (listeners.has(fn)) fn(frame);
  }
  function reply(
    request: RecordingAdmissionRequest,
    outcome: RecordingAdmissionReply["outcome"],
  ) {
    return parseRecordingAdmissionReply({
      version: 1,
      kind: "recordingAdmissionReply",
      request,
      outcome,
    });
  }
  function leaseReply(index: number, outcome: unknown) {
    return {
      version: 1,
      kind: "recordingWireLeaseReply",
      request: leases[index].request.lease,
      outcome,
    };
  }
  function issueLease(index: number) {
    const l = leases[index],
      deadlineLeaseRef = `lease:${index}`;
    issued.set(deadlineLeaseRef, {
      request: l.request,
      expires: nativeNow + l.request.lease.requestedBudgetMs,
      used: false,
    });
    const v = leaseReply(index, {
      kind: "issued",
      deadlineLeaseRef,
      grantedBudgetMs: l.request.lease.requestedBudgetMs,
    });
    l.resolve(v);
    return v;
  }
  function rejectLease(
    index: number,
    error: RecordingWireError = "ownerUnavailable",
  ) {
    const v = leaseReply(index, { kind: "rejected", error });
    leases[index].resolve(v);
    return v;
  }
  function observationReply(
    target: RecordingWireObservationTarget,
    outcome: unknown,
  ) {
    return {
      version: 1,
      kind: "recordingWireObservationReply",
      request: {
        version: 1,
        kind: "recordingWireObservationRequest",
        scope,
        observationId: `observation:${++observationIds}`,
        target,
      },
      outcome,
    };
  }
  function register(
    request: RecordingAdmissionRequest,
  ): RecordingAdmissionReply {
    const a = request.action;
    const lease = issued.get(request.deadlineLeaseRef);
    if (
      !lease ||
      lease.used ||
      lease.request.lease.admissionId !== request.admissionId ||
      lease.request.lease.scope.ownerRef !== request.ownerRef
    )
      return reply(request, { kind: "rejected", error: "wrongOwner" });
    lease.used = true;
    if (nativeNow >= lease.expires)
      return reply(request, { kind: "rejected", error: "deadlineExceeded" });
    if (a.kind === "discard")
      return reply(request, { kind: "completedDiscard" });
    if (a.kind === "reconcile") {
      const readRef = `read:${reads.length}`,
        target = {
          kind: "reconciliation" as const,
          readRef,
          request: a.reconciliation,
        };
      reads.push({
        ...observation(() => target),
        handle: { readRef, request: a.reconciliation },
        target,
        settled: false,
        observed: 0,
      });
      return reply(request, {
        kind: "accepted",
        handle: { kind: "reconciliation", readRef, request: a.reconciliation },
      });
    }
    const operationRef = `operation:${operations.length}`;
    const op: RecordingOperationRequest =
      a.kind === "preflight"
        ? {
            version: 1,
            kind: "recordingOperationRequest",
            operationId: `native:${operations.length}`,
            stage: "preflight",
            change: a.change,
          }
        : a.operation;
    const target = { kind: "operation" as const, operationRef, request: op };
    operations.push({
      ...observation(() => target),
      handle: { operationRef, request: op },
      target,
      settled: false,
      observed: 0,
    });
    if (a.kind === "pauseJoin") stops++;
    if (a.kind === "apply") writes++;
    return reply(request, {
      kind: "accepted",
      handle: {
        kind: "operation",
        changeRef:
          a.kind === "preflight"
            ? `candidate:${operations.length}`
            : a.changeRef,
        operationRef,
        request: op,
      },
    });
  }
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  /** Defaults; tests may replace any entry (the port stays frozen). */
  const impl = {
    prepareLease(request: PortLeaseRequestV2) {
      const c = portCall<PortLeaseRequestV2>(request);
      leases.push(c);
      if (autoLease) issueLease(leases.length - 1);
      return c.call;
    },
    admit(request: RecordingAdmissionRequest) {
      const accepted = register(request),
        c = Object.assign(portCall<RecordingAdmissionRequest>(request), {
          accepted,
        });
      admissions.push(c);
      if (autoAck) {
        emit({ admission: accepted });
        c.resolve(accepted);
      }
      return c.call;
    },
    inspectAdmission(request: RecordingAdmissionInspectionRequest) {
      const c = portCall<RecordingAdmissionInspectionRequest>(request);
      inspections.push(c);
      if (autoInspect) {
        const original = admissions.find(
          (a) => a.request.admissionId === request.original.admissionId,
        );
        c.resolve({
          version: 1,
          kind: "recordingAdmissionInspectionReply",
          request,
          outcome: original?.accepted
            ? { kind: "found", reply: original.accepted }
            : { kind: "notFound" },
        });
      }
      return c.call;
    },
    inspectCall(original: PortCallV2<unknown, unknown>) {
      const request = {
        version: 1,
        kind: "recordingWireCallInspectionRequest",
        scope,
        callInspectionId: `call-inspection:${callInspections.length}`,
        original: original.request,
      };
      const c = Object.assign(portCall<unknown>(request), { original });
      callInspections.push(c);
      if (autoInspect) {
        const found = admissions.find((a) => a.call === original);
        c.resolve({
          version: 1,
          kind: "recordingWireCallInspectionReply",
          request,
          outcome: found?.accepted
            ? { kind: "terminal", reply: found.accepted }
            : { kind: "notFound" },
        });
      }
      return c.call;
    },
    requestCancel(request: RecordingWireCancelRequest) {
      const c = portCall<RecordingWireCancelRequest>(request);
      cancels.push(c);
      if (autoCancel)
        c.resolve({
          version: 1,
          kind: "recordingWireCancelReply",
          request,
          outcome: { kind: "ack", disposition: "requested" },
        });
      return c.call;
    },
    observe(target: RecordingWireObservationTarget) {
      const o = [...operations, ...reads].find((x) => same(x.target, target));
      if (!o) throw Error("unknown target");
      o.observed++;
      return { target, result: o.promise };
    },
    current: () => frame,
    subscribe(listener: (v: unknown) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const port = defineAsyncRecordingPortV2({
    scope,
    access,
    prepareLease: (r) => impl.prepareLease(r),
    admit: (r) => impl.admit(r),
    inspectAdmission: (r) => impl.inspectAdmission(r),
    inspectCall: (r) => impl.inspectCall(r) as never,
    requestCancel: (r) => impl.requestCancel(r) as never,
    observe: (t) => impl.observe(t) as never,
    current: () => impl.current() as PortStateV2,
    subscribe: (l) => impl.subscribe(l as (v: unknown) => void),
  } as AsyncRecordingPortV2Impl);
  function receipt(op: RecordingOperationRequest) {
    const a = op.change.apply,
      d = a.desired;
    return {
      ...fixtures.bases.result.outcome.receipt,
      requestId: a.requestId,
      appliedRevision: (a.expectedAppliedRevision ?? 0) + 1,
      desiredPlanId: d.planId,
      desiredRevision: d.revision,
      plan: {
        planId: "recording-plan:1",
        revision: (a.expectedAppliedRevision ?? 0) + 1,
      },
      mappingRevision: a.expectedMappingRevision,
      retentionAppliedRevision: a.expectedRetentionAppliedRevision,
      enabled: d.enabled,
    };
  }
  function result(
    index: number,
    kind = "default",
    patch: Record<string, unknown> = {},
  ) {
    const request = operations[index].handle.request;
    const outcome =
      kind === "default"
        ? request.stage === "preflight"
          ? {
              kind: "candidate",
              snapshotCommit: 20,
              activeSessionId: context.sessionId,
            }
          : request.stage === "pauseJoin"
            ? { kind: "paused", sessionId: context.sessionId }
            : { kind: "applied", receipt: receipt(request) }
        : kind === "replay"
          ? { kind: "replay", snapshotCommit: 100, receipt: receipt(request) }
          : {
              kind: "failed",
              error: kind,
              effect:
                request.stage === "apply" ? "unconfirmed" : "notDispatched",
            };
    return parseRecordingOperationResult({
      version: 1,
      kind: "recordingOperationResult",
      request,
      outcome,
      quiescence:
        request.stage === "apply" && kind !== "default"
          ? "unknown"
          : "confirmed",
      recoveryRequired: request.stage === "apply" && kind !== "default",
      ...patch,
    });
  }
  return {
    port,
    context,
    ownerRef,
    leases,
    admissions,
    operations,
    reads,
    inspections,
    callInspections,
    cancels,
    scope,
    impl,
    rejectLease,
    get frame() {
      return frame;
    },
    get stops() {
      return stops;
    },
    get writes() {
      return writes;
    },
    get listenerCount() {
      return listeners.size;
    },
    configure(
      options: Partial<{
        autoLease: boolean;
        autoAck: boolean;
        autoInspect: boolean;
        autoCancel: boolean;
      }>,
    ) {
      if (options.autoLease !== undefined) autoLease = options.autoLease;
      if (options.autoAck !== undefined) autoAck = options.autoAck;
      if (options.autoInspect !== undefined) autoInspect = options.autoInspect;
      if (options.autoCancel !== undefined) autoCancel = options.autoCancel;
    },
    advanceNative(ms: number) {
      nativeNow += ms;
    },
    issueLease,
    emit,
    raw(value: unknown) {
      for (const fn of [...listeners]) fn(value);
    },
    ack(index: number, kind = "accepted") {
      const c = admissions[index],
        v =
          kind === "accepted"
            ? c.accepted!
            : reply(c.request, {
                kind: kind as "unknown" | "rejected",
                error: "internal",
              });
      c.resolve(v);
      return v;
    },
    result,
    receipt,
    finish(
      index: number,
      kind = "default",
      patch: Record<string, unknown> = {},
    ) {
      const o = operations[index],
        v = result(index, kind, patch);
      o.settled = true;
      emit({ operation: { operationRef: o.handle.operationRef, result: v } });
      o.resolve(v);
      return v;
    },
    finishRead(
      index: number,
      kind = "receiptFound",
      patch: Record<string, unknown> = {},
    ) {
      const r = reads[index],
        request = r.handle.request;
      const d: RecordingReconciliationDelivery = {
        version: 1,
        kind: "recordingReconciliationDelivery",
        ownerRef,
        readRef: r.handle.readRef,
        request,
        outcome:
          kind === "readUncertain"
            ? { kind, error: "workerFailure" }
            : {
                kind: "result",
                result: parseRecordingReconciliationResult({
                  version: 1,
                  kind: "recordingReconciliationResult",
                  request,
                  outcome:
                    kind === "receiptFound"
                      ? { kind, receipt: receipt(request.operation) }
                      : kind === "notFound"
                        ? { kind }
                        : { kind: "failed", error: kind },
                  quiescence: "confirmed",
                  recoveryRequired: true,
                  ...patch,
                }),
              },
      };
      r.settled = true;
      emit({ reconciliation: d });
      r.resolve(d);
      return d;
    },
  };
}
