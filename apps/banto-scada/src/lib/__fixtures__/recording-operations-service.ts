/** Test-only external owner. The App never imports this simulated provider. */
import fixtures from "../../../../../examples/recording-operations-cases.json";
import sample from "../../../../../examples/minimal.project.json";
import {
  parseRecordingChangeRequest,
  parseRecordingOperationsContext,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
  parseRecordingReconciliationResult,
  sameRecordingOperationsContext,
  type RecordingOperationRequest,
  type RecordingOperationResult,
  type RecordingReconciliationResult,
  type RecordingReconciliationRequest,
} from "../recording-operations-contract";
import { parseProject, type Project } from "../project";
import {
  RecordingOperationRejected,
  type RecordingOperationsService,
  type RecordingOperationOwnerView,
  type OperationHandle,
  type ReconciliationHandle,
  type OperationControl,
  type ChangeHandle,
} from "../recording-operations/service";
import { mergeResult } from "../recording-operations/view";
export const operationsProject = parseProject(
  JSON.stringify({
    ...sample,
    recordingPlan: fixtures.bases.change.apply.desired,
  }),
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function createOperationsHarness(project: Project = operationsProject) {
  const context = parseRecordingOperationsContext({
    ...fixtures.bases.context,
    target: {
      ...fixtures.bases.context.target,
      projectId: project.manifest.projectId,
      projectRevision: project.manifest.projectRevision,
    },
  });
  let view: RecordingOperationOwnerView = Object.freeze({
    change: null,
    request: null,
    phase: "idle",
    active: null,
    latest: null,
    reconciling: null,
    lastReconciliation: null,
    lastApplied: null,
  });
  const listeners = new Set<(v: RecordingOperationOwnerView) => void>();
  const calls: {
    handle: OperationHandle;
    control: OperationControl;
    resolve: (value: RecordingOperationResult) => void;
    reject: (error: unknown) => void;
    settled: boolean;
  }[] = [];
  const reads: {
    handle: ReconciliationHandle;
    control: OperationControl;
    resolve: (value: RecordingReconciliationResult) => void;
    reject: (error: unknown) => void;
    settled: boolean;
  }[] = [];
  let stops = 0,
    writes = 0,
    cancels = 0,
    readCancels = 0,
    physical = 0,
    maxPhysical = 0;
  let hook: (() => void) | undefined;
  function emit() {
    for (const cb of [...listeners])
      if (listeners.has(cb))
        try {
          cb(view);
        } catch {
          /* caller isolation */
        }
  }
  function set(patch: Partial<RecordingOperationOwnerView>) {
    view = Object.freeze({ ...view, ...patch });
    emit();
  }
  function refuse(
    code: ConstructorParameters<typeof RecordingOperationRejected>[0],
  ): never {
    throw new RecordingOperationRejected(code, view);
  }
  function gate() {
    if (
      physical ||
      view.latest?.recoveryRequired ||
      view.latest?.quiescence === "unknown"
    )
      refuse("busy");
  }
  function issue(
    stage: RecordingOperationRequest["stage"],
    operationId: string,
    change: NonNullable<RecordingOperationOwnerView["request"]>,
    control: OperationControl,
  ) {
    gate();
    const d = deferred<RecordingOperationResult>();
    const request = parseRecordingOperationRequest({
      version: 1,
      kind: "recordingOperationRequest",
      operationId,
      stage,
      change,
    });
    const call: {
      handle: OperationHandle;
      control: OperationControl;
      resolve: typeof d.resolve;
      reject: typeof d.reject;
      settled: boolean;
    } = {
      handle: Object.freeze({
        opaqueOperation: Object.freeze({}),
        request,
        completion: d.promise,
        requestCancel() {
          if (stage === "pauseJoin") return "notSupported";
          if (call.settled) return "alreadyCompleted";
          cancels++;
          return "requested";
        },
      }),
      control,
      resolve: d.resolve,
      reject: d.reject,
      settled: false,
    };
    calls.push(call);
    physical++;
    maxPhysical = Math.max(maxPhysical, physical);
    if (stage === "pauseJoin") stops++;
    if (stage === "apply") writes++;
    set({
      request: change,
      active: call.handle,
      phase:
        stage === "preflight"
          ? "preflighting"
          : stage === "pauseJoin"
            ? "pausing"
            : "applying",
      reconciling: null,
      lastReconciliation: null,
    });
    hook?.();
    return call.handle;
  }
  function own(change: ChangeHandle) {
    if (change !== view.change) refuse("wrongOwner");
  }
  const service: RecordingOperationsService = {
    context,
    preflight(input, control) {
      gate();
      if (!["idle", "completed"].includes(view.phase)) refuse("busy");
      const request = parseRecordingChangeRequest(input);
      if (!sameRecordingOperationsContext(request.context, context))
        refuse("wrongOwner");
      const change = Object.freeze({ opaqueChange: Object.freeze({}) });
      view = Object.freeze({ ...view, change, request, latest: null });
      const operation = issue(
        "preflight",
        `preflight:${request.changeId}`,
        request,
        control,
      );
      return { change, operation };
    },
    pauseJoin(change, id, control) {
      own(change);
      if (view.phase !== "candidate") refuse("noCandidate");
      return issue("pauseJoin", id, view.request!, control);
    },
    apply(change, id, control) {
      own(change);
      if (view.phase !== "paused") refuse("pauseRequired");
      return issue("apply", id, view.request!, control);
    },
    discard(change) {
      own(change);
      gate();
      if (!["candidate", "paused"].includes(view.phase)) refuse("busy");
      set({
        request: null,
        change: null,
        active: null,
        latest: null,
        phase: "idle",
        reconciling: null,
        lastReconciliation: null,
      });
    },
    reconcile(change, operation, id, control) {
      own(change);
      if (operation !== view.active || operation.request.stage !== "apply")
        refuse("wrongOwner");
      if (
        !calls.find((c) => c.handle === operation)?.settled ||
        reads.some((r) => !r.settled)
      )
        refuse("busy");
      const d = deferred<RecordingReconciliationResult>();
      const request = parseRecordingReconciliationRequest({
        version: 1,
        kind: "recordingReconciliationRequest",
        reconciliationId: id,
        operation: operation.request,
      });
      const call = {
        handle: Object.freeze({
          request,
          completion: d.promise,
          requestCancel() {
            if (call.settled) return "alreadyCompleted";
            readCancels++;
            return "requested";
          },
        }) as ReconciliationHandle,
        control,
        resolve: d.resolve,
        reject: d.reject,
        settled: false,
      };
      reads.push(call);
      set({ reconciling: call.handle });
      hook?.();
      return call.handle;
    },
    current() {
      hook?.();
      return view;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(view);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function receipt(request: RecordingOperationRequest) {
    const a = request.change.apply,
      d = a.desired;
    return {
      ...fixtures.bases.result.outcome.receipt,
      requestId: a.requestId,
      appliedRevision: (a.expectedAppliedRevision ?? 0) + 1,
      desiredPlanId: d.planId,
      desiredRevision: d.revision,
      plan: {
        planId: fixtures.bases.result.outcome.receipt.plan.planId,
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
    const request = calls[index].handle.request;
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
  function projectResult(value: RecordingOperationResult) {
    const latest =
      view.latest &&
      view.latest.request.operationId === value.request.operationId
        ? mergeResult(view.latest, value)
        : value;
    const phase =
      latest.quiescence === "unknown"
        ? "uncertain"
        : latest.recoveryRequired
          ? "blocked"
          : latest.outcome.kind === "candidate"
            ? "candidate"
            : latest.outcome.kind === "paused"
              ? "paused"
              : "completed";
    set({
      latest,
      phase,
      ...(latest.outcome.kind === "applied"
        ? {
            lastApplied: {
              request: latest.request,
              receipt: latest.outcome.receipt,
            },
          }
        : {}),
    });
  }
  return {
    service,
    context,
    calls,
    reads,
    get view() {
      return view;
    },
    get stops() {
      return stops;
    },
    get writes() {
      return writes;
    },
    get cancels() {
      return cancels;
    },
    get readCancels() {
      return readCancels;
    },
    get maxPhysical() {
      return maxPhysical;
    },
    setHook(next: typeof hook) {
      hook = next;
    },
    set,
    emit,
    publishRaw(value: unknown) {
      view = value as RecordingOperationOwnerView;
      emit();
    },
    result,
    receipt,
    finish(
      index: number,
      kind = "default",
      patch: Record<string, unknown> = {},
      completionFirst = false,
    ) {
      const c = calls[index],
        value = result(index, kind, patch);
      c.settled = true;
      physical--;
      if (completionFirst) {
        c.resolve(value);
        queueMicrotask(() => projectResult(value));
      } else {
        projectResult(value);
        c.resolve(value);
      }
      return value;
    },
    reject(index: number) {
      const c = calls[index];
      c.settled = true;
      physical--;
      c.reject(Error("PRIVATE PROVIDER ERROR"));
    },
    readResult(
      index: number,
      kind = "receiptFound",
      patch: Record<string, unknown> = {},
    ) {
      const request: RecordingReconciliationRequest =
        reads[index].handle.request;
      return parseRecordingReconciliationResult({
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
      });
    },
    finishRead(
      index: number,
      kind = "receiptFound",
      patch: Record<string, unknown> = {},
    ) {
      const r = reads[index],
        value = this.readResult(index, kind, patch);
      r.settled = true;
      const old = view.latest!;
      const latest = mergeResult(old, {
        ...old,
        outcome:
          value.outcome.kind === "receiptFound"
            ? { kind: "applied", receipt: value.outcome.receipt }
            : old.outcome,
        quiescence:
          old.quiescence === "confirmed" || value.quiescence === "confirmed"
            ? "confirmed"
            : "unknown",
        recoveryRequired: old.recoveryRequired || value.recoveryRequired,
      });
      set({
        latest,
        lastReconciliation: value,
        reconciling: r.handle,
        phase: latest.quiescence === "unknown" ? "uncertain" : "blocked",
        ...(latest.outcome.kind === "applied"
          ? {
              lastApplied: {
                request: latest.request,
                receipt: latest.outcome.receipt,
              },
            }
          : {}),
      });
      r.resolve(value);
      return value;
    },
  };
}
