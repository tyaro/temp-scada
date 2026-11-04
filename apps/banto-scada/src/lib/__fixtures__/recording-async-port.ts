/** Controlled test provider; no native adapter, Hub, database or production import. */
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
  type RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import type {
  AsyncRecordingOperationsPort,
  LocalOwnerFrame,
  LocalLeaseRequest,
  LocalOperationObservation,
  LocalReconciliationObservation,
  LocalCancelRequest,
} from "../recording-async/port";
export function deferred<T = unknown>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export function createAsyncPortHarness(project: Project = operationsProject) {
  const context = parseRecordingOperationsContext({
      ...fixtures.bases.context,
      target: {
        ...fixtures.bases.context.target,
        projectId: project.manifest.projectId,
        projectRevision: project.manifest.projectRevision,
      },
    }),
    ownerRef = "owner:async-test";
  let frame: LocalOwnerFrame = {
    ownerRef,
    context,
    revision: 1,
    connected: true,
    admission: null,
    operation: null,
    reconciliation: null,
    ownerBlocked: false,
  };
  const listeners = new Set<(v: unknown) => void>();
  const leases: ({ request: LocalLeaseRequest } & ReturnType<
    typeof deferred
  >)[] = [];
  const admissions: ({
    request: RecordingAdmissionRequest;
    accepted?: RecordingAdmissionReply;
  } & ReturnType<typeof deferred>)[] = [];
  const operations: ({
    handle: LocalOperationObservation;
    settled: boolean;
  } & ReturnType<typeof deferred>)[] = [];
  const reads: ({
    handle: LocalReconciliationObservation;
    settled: boolean;
  } & ReturnType<typeof deferred>)[] = [];
  const inspections: ({
    request: import("../recording-admission-contract").RecordingAdmissionInspectionRequest;
  } & ReturnType<typeof deferred>)[] = [];
  const cancels: ({ request: LocalCancelRequest } & ReturnType<
    typeof deferred
  >)[] = [];
  let autoLease = true,
    autoAck = true,
    autoInspect = true,
    autoCancel = true,
    stops = 0,
    writes = 0;
  let nativeNow = 0;
  const issued = new Map<
    string,
    { request: LocalLeaseRequest; expires: number; used: boolean }
  >();
  function emit(patch: Partial<LocalOwnerFrame> = {}) {
    frame = { ...frame, ...patch, revision: frame.revision + 1 };
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
  function issueLease(index: number) {
    const l = leases[index],
      deadlineLeaseRef = `lease:${index}`;
    issued.set(deadlineLeaseRef, {
      request: l.request,
      expires: nativeNow + l.request.requestedBudgetMs,
      used: false,
    });
    const v = {
      request: l.request,
      outcome: { kind: "issued", deadlineLeaseRef },
    };
    l.resolve(v);
    return v;
  }
  function register(
    request: RecordingAdmissionRequest,
  ): RecordingAdmissionReply {
    const a = request.action;
    const lease = issued.get(request.deadlineLeaseRef);
    if (
      !lease ||
      lease.used ||
      lease.request.admissionId !== request.admissionId ||
      lease.request.ownerRef !== request.ownerRef
    )
      return reply(request, { kind: "rejected", error: "wrongOwner" });
    lease.used = true;
    if (nativeNow >= lease.expires)
      return reply(request, { kind: "rejected", error: "deadlineExceeded" });
    if (a.kind === "discard")
      return reply(request, { kind: "completedDiscard" });
    if (a.kind === "reconcile") {
      const readRef = `read:${reads.length}`,
        d = deferred();
      reads.push({
        ...d,
        handle: { readRef, request: a.reconciliation, completion: d.promise },
        settled: false,
      });
      return reply(request, {
        kind: "accepted",
        handle: { kind: "reconciliation", readRef, request: a.reconciliation },
      });
    }
    const d = deferred(),
      operationRef = `operation:${operations.length}`;
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
    operations.push({
      ...d,
      handle: { operationRef, request: op, completion: d.promise },
      settled: false,
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
  const port: AsyncRecordingOperationsPort = {
    context,
    ownerRef,
    prepareLease(request) {
      const d = deferred();
      leases.push({ ...d, request });
      if (autoLease) issueLease(leases.length - 1);
      return d.promise;
    },
    admit(request) {
      const d = deferred(),
        accepted = register(request);
      admissions.push({ ...d, request, accepted });
      if (autoAck) {
        emit({ admission: accepted });
        d.resolve(accepted);
      }
      return d.promise;
    },
    inspectAdmission(request) {
      const d = deferred();
      inspections.push({ ...d, request });
      if (autoInspect) {
        const original = admissions.find(
          (a) => a.request.admissionId === request.original.admissionId,
        );
        d.resolve({
          version: 1,
          kind: "recordingAdmissionInspectionReply",
          request,
          outcome: original?.accepted
            ? { kind: "found", reply: original.accepted }
            : { kind: "notFound" },
        });
      }
      return d.promise;
    },
    observeOperation(ref) {
      const op = operations.find((o) => o.handle.operationRef === ref);
      if (!op) throw Error("unknown ref");
      return op.handle;
    },
    observeReconciliation(ref) {
      const r = reads.find((o) => o.handle.readRef === ref);
      if (!r) throw Error("unknown ref");
      return r.handle;
    },
    current: () => frame,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestCancel(request) {
      const d = deferred();
      cancels.push({ ...d, request });
      if (autoCancel) d.resolve({ request, disposition: "requested" });
      return d.promise;
    },
  };
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
    cancels,
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
