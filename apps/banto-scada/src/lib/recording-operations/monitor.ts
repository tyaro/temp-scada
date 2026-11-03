import {
  parseRecordingChangeRequest,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
  parseRecordingReconciliationResult,
  sameRecordingChangeRequest,
  sameRecordingOperationRequest,
  sameRecordingOperationsContext,
  sameRecordingReconciliationRequest,
  type OperationError,
  type RecordingChangeRequest,
  type RecordingOperationRequest,
  type RecordingOperationResult,
  type RecordingReconciliationResult,
} from "../recording-operations-contract";
import { sameRecordingPlan } from "../recording-plan-edit";
import {
  RecordingOperationRejected,
  operationErrorCode,
  type OperationsSelection,
  type OperationsBinding,
  type RecordingOperationOwnerView,
  type OperationHandle,
  type ReconciliationHandle,
  type CancelDisposition,
  type AppliedSuccess,
} from "./service";
import {
  ownerView,
  operationHandle,
  reconciliationHandle,
  changeHandle,
  data,
  stages,
  receiptKey,
  mergeResult,
  canonical,
} from "./view";
interface Track {
  raw: OperationHandle;
  captured: OperationHandle;
  settled: boolean;
  result?: RecordingOperationResult;
  timer?: ReturnType<typeof setTimeout>;
}
interface ReadTrack {
  raw: ReconciliationHandle;
  captured: ReconciliationHandle;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  result?: RecordingReconciliationResult;
  completionValid?: boolean;
}
interface Entry {
  binding: OperationsBinding;
  view?: RecordingOperationOwnerView;
  request?: RecordingChangeRequest;
  changeToken?: object;
  operations: Partial<Record<RecordingOperationRequest["stage"], Track>>;
  current?: Track;
  read?: ReadTrack;
  unsubscribe?: () => void;
  queued?: unknown;
  queuedPresent: boolean;
  invalid: boolean;
  ownerBlocked?: boolean;
  timedOut: boolean;
  refusal?: OperationError;
  cancel?: CancelDisposition;
  lastApplied?: AppliedSuccess;
}
export interface OperationsMonitorState {
  readonly connection: OperationsSelection["phase"];
  readonly phase: RecordingOperationOwnerView["phase"];
  readonly binding?: OperationsBinding;
  readonly view?: RecordingOperationOwnerView;
  readonly latest?: RecordingOperationResult;
  readonly lastApplied?: AppliedSuccess;
  readonly oldOwner: boolean;
  readonly issuing: boolean;
  readonly invalid: boolean;
  readonly timedOut: boolean;
  readonly refusal?: OperationError;
  readonly cancel?: CancelDisposition;
  readonly canPreflight: boolean;
  readonly canPause: boolean;
  readonly canApply: boolean;
  readonly canDiscard: boolean;
  readonly canReconcile: boolean;
  readonly canCancel: boolean;
  readonly canCancelRead: boolean;
  readonly canSwitch: boolean;
  readonly canDiscardOriginal: boolean;
  readonly previous?: Readonly<{
    latest?: RecordingOperationResult;
    lastApplied?: AppliedSuccess;
  }>;
}
/** Per-App bounded observer, not a native owner. Dispose only unsubscribes;
 * providers must retain accepted operations and the real global physical gate. */
export function createRecordingOperationsMonitor(
  now = () => performance.now(),
) {
  let selection: OperationsSelection = { phase: "offline" },
    entry: Entry | undefined,
    locked = false,
    disposed = false;
  let previous: OperationsMonitorState["previous"];
  let sequence = 0;
  const idPrefix = Math.random().toString(16).slice(2, 14);
  const listeners = new Set<(state: OperationsMonitorState) => void>();
  let state: OperationsMonitorState = Object.freeze({
    connection: "offline",
    phase: "idle",
    oldOwner: false,
    issuing: false,
    invalid: false,
    timedOut: false,
    canPreflight: false,
    canPause: false,
    canApply: false,
    canDiscard: false,
    canReconcile: false,
    canCancel: false,
    canCancelRead: false,
    canSwitch: false,
    canDiscardOriginal: false,
  });
  function id(role: string): string {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw Error("ID limit");
    return `${role}:${idPrefix}:${++sequence}`;
  }
  function currentBinding() {
    return selection.phase === "ready" ? selection.binding : undefined;
  }
  function sameOwner(e: Entry, b: OperationsBinding): boolean {
    return (
      e.binding.service === b.service &&
      e.binding.project === b.project &&
      e.binding.generation === b.generation &&
      sameRecordingOperationsContext(e.binding.context, b.context)
    );
  }
  function safeComplete(e: Entry): boolean {
    return (
      !e.invalid &&
      !!e.view &&
      (e.view.phase === "idle" || e.view.phase === "completed") &&
      (!e.current ||
        (e.current.settled &&
          e.current.result?.quiescence === "confirmed" &&
          !e.current.result.recoveryRequired)) &&
      (!e.read || (e.read.settled && e.read.completionValid === true))
    );
  }
  function qualified(e: Entry): boolean {
    const b = currentBinding();
    return (
      !!b &&
      sameOwner(e, b) &&
      !!b.desired &&
      (!e.request || sameRecordingPlan(b.desired, e.request.apply.desired))
    );
  }
  function publish() {
    if (disposed) return;
    const e = entry,
      v = e?.view,
      b = currentBinding(),
      t = e?.current,
      r = t?.result;
    const same = !!e && qualified(e),
      ready = same && !locked && !e.invalid;
    const settled =
      !!t?.settled && r?.quiescence === "confirmed" && !r.recoveryRequired;
    const canReconcile =
      !!e &&
      !locked &&
      !e.read?.timer &&
      (!e.read || (e.read.settled && e.read.completionValid === true)) &&
      !!t?.settled &&
      t.captured.request.stage === "apply" &&
      !!e.view?.change &&
      (e.invalid ||
        r?.quiescence === "unknown" ||
        r?.recoveryRequired === true);
    state = Object.freeze({
      connection: selection.phase,
      previous,
      phase: e?.invalid ? "uncertain" : (v?.phase ?? "idle"),
      binding: e?.binding,
      view: v,
      latest: r,
      lastApplied: e?.lastApplied,
      oldOwner: !!e && (!b || !sameOwner(e, b)),
      issuing: locked,
      invalid: e?.invalid ?? false,
      timedOut: e?.timedOut ?? false,
      refusal: e?.refusal,
      cancel: e?.cancel,
      canPreflight: ready && !!e && safeComplete(e),
      canPause:
        ready &&
        settled &&
        v?.phase === "candidate" &&
        r?.outcome.kind === "candidate",
      canApply:
        ready &&
        settled &&
        v?.phase === "paused" &&
        r?.outcome.kind === "paused",
      canDiscard:
        ready &&
        settled &&
        (v?.phase === "candidate" || v?.phase === "paused") &&
        (!e?.read || e.read.settled),
      canDiscardOriginal:
        !!e &&
        !same &&
        !locked &&
        !e.invalid &&
        !e.ownerBlocked &&
        settled &&
        (v?.phase === "candidate" || v?.phase === "paused") &&
        (!e.read || (e.read.settled && e.read.completionValid === true)),
      canReconcile,
      canCancel:
        !!e &&
        !locked &&
        !!t &&
        !t.settled &&
        t.captured.request.stage !== "pauseJoin",
      canCancelRead: !!e && !locked && !!e.read && !e.read.settled,
      canSwitch: !!e && !!b && !sameOwner(e, b) && !locked && safeComplete(e),
    });
    const issued = state;
    for (const listener of [...listeners]) {
      if (state !== issued) break;
      if (!listeners.has(listener)) continue;
      try {
        listener(issued);
      } catch {
        /* consumer isolation */
      }
    }
  }
  function invalid(e: Entry) {
    e.invalid = true;
    publish();
  }
  function clearTimer(t: Track | ReadTrack | undefined) {
    if (t?.timer !== undefined) {
      clearTimeout(t.timer);
      t.timer = undefined;
    }
  }
  function deadline(timeoutMs: number): number {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw Error("Recording operation timeout: invalid");
    const start = now();
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(start + timeoutMs)
    )
      throw Error("Recording operation clock: invalid");
    return start + timeoutMs;
  }
  function arm(e: Entry, t: Track | ReadTrack, end: number) {
    clearTimer(t);
    const fire = () => {
      if (disposed || entry !== e || t.settled) return;
      if (now() < end) {
        t.timer = setTimeout(fire, end - now());
        return;
      }
      e.timedOut = true;
      publish();
    };
    t.timer = setTimeout(fire, Math.max(0, end - now()));
  }
  function result(e: Entry, t: Track, input: unknown) {
    const next = parseRecordingOperationResult(input);
    if (!sameRecordingOperationRequest(t.captured.request, next.request))
      throw Error("wrong operation");
    t.result = mergeResult(t.result, next);
    if (t.result.outcome.kind === "applied") {
      const pair = Object.freeze({
        request: t.result.request,
        receipt: t.result.outcome.receipt,
      });
      if (
        e.lastApplied &&
        sameRecordingOperationRequest(e.lastApplied.request, pair.request) &&
        receiptKey(e.lastApplied.receipt) !== receiptKey(pair.receipt)
      )
        throw Error("receipt conflict");
      e.lastApplied = pair;
    }
  }
  function track(e: Entry, raw: OperationHandle): Track {
    const captured = operationHandle(raw),
      old = e.operations[captured.request.stage];
    if (
      !e.request ||
      !sameRecordingChangeRequest(e.request, captured.request.change)
    )
      throw Error("wrong change");
    if (old) {
      if (
        old.raw !== raw ||
        old.captured.opaqueOperation !== captured.opaqueOperation ||
        old.captured.completion !== captured.completion ||
        old.captured.requestCancel !== captured.requestCancel ||
        !sameRecordingOperationRequest(old.captured.request, captured.request)
      )
        throw Error("changed handle");
      return old;
    }
    const t: Track = { raw, captured, settled: false };
    e.operations[captured.request.stage] = t;
    Promise.prototype.then.call(
      captured.completion,
      (value: unknown) => {
        if (
          disposed ||
          entry !== e ||
          e.operations[t.captured.request.stage] !== t
        )
          return;
        t.settled = true;
        clearTimer(t);
        try {
          result(e, t, value);
          pull(e);
        } catch {
          invalid(e);
        }
        publish();
      },
      () => {
        if (
          disposed ||
          entry !== e ||
          e.operations[t.captured.request.stage] !== t
        )
          return;
        t.settled = true;
        clearTimer(t);
        invalid(e);
      },
    );
    return t;
  }
  function readResult(e: Entry, t: ReadTrack, input: unknown) {
    const next = parseRecordingReconciliationResult(input);
    if (
      !sameRecordingReconciliationRequest(t.captured.request, next.request) ||
      !e.current ||
      !sameRecordingOperationRequest(
        e.current.captured.request,
        next.request.operation,
      )
    )
      throw Error("wrong read");
    if (t.result) {
      // The immutable reply can arrive through both subscribe and completion.
      if (canonical(t.result) !== canonical(next))
        throw Error("changed read result");
      return;
    }
    const old = e.current.result;
    if (old?.quiescence === "confirmed" && next.quiescence !== "confirmed")
      throw Error("quiescence rollback");
    if (next.outcome.kind === "receiptFound") {
      result(e, e.current, {
        version: 1,
        kind: "recordingOperationResult",
        request: next.request.operation,
        outcome: { kind: "applied", receipt: next.outcome.receipt },
        quiescence: next.quiescence,
        recoveryRequired:
          next.recoveryRequired || old?.recoveryRequired === true,
      });
    } else if (old) {
      // A missing receipt cannot erase evidence or authorize a retry.
      e.current.result = parseRecordingOperationResult({
        ...old,
        quiescence:
          old.quiescence === "confirmed" || next.quiescence === "confirmed"
            ? "confirmed"
            : "unknown",
        recoveryRequired: old.recoveryRequired || next.recoveryRequired,
      });
    }
    t.result = next;
  }
  function watchRead(e: Entry, raw: ReconciliationHandle): ReadTrack {
    const captured = reconciliationHandle(raw);
    if (
      !e.current ||
      !sameRecordingOperationRequest(
        captured.request.operation,
        e.current.captured.request,
      )
    )
      throw Error("wrong read");
    if (e.read?.raw === raw) {
      if (
        e.read.captured.completion !== captured.completion ||
        e.read.captured.requestCancel !== captured.requestCancel ||
        !sameRecordingReconciliationRequest(
          e.read.captured.request,
          captured.request,
        )
      )
        throw Error("changed read");
      return e.read;
    }
    if (e.read && !e.read.settled) throw Error("overlapping read");
    if (
      e.read?.captured.request.reconciliationId ===
      captured.request.reconciliationId
    )
      throw Error("reused read ID");
    const t: ReadTrack = { raw, captured, settled: false };
    e.read = t;
    Promise.prototype.then.call(
      captured.completion,
      (value: unknown) => {
        if (disposed || entry !== e || e.read !== t) return;
        t.settled = true;
        clearTimer(t);
        try {
          readResult(e, t, value);
          t.completionValid = true;
          pull(e);
        } catch {
          invalid(e);
        }
        publish();
      },
      () => {
        if (disposed || entry !== e || e.read !== t) return;
        t.settled = true;
        clearTimer(t);
        invalid(e);
      },
    );
    return t;
  }
  function ingest(e: Entry, input: unknown, allowReset = false) {
    const v = ownerView(input, e.binding.context);
    if (
      e.request &&
      v.request &&
      !sameRecordingChangeRequest(e.request, v.request)
    ) {
      if (!allowReset && !safeComplete(e)) throw Error("unexpected workflow");
      e.operations = {};
      e.current = undefined;
      e.read = undefined;
      e.request = undefined;
      e.changeToken = undefined;
    }
    if (e.request && !v.request && !allowReset) throw Error("lost workflow");
    if (!v.request) {
      e.request = undefined;
      e.current = undefined;
      e.operations = {};
      e.read = undefined;
      e.changeToken = undefined;
    } else {
      const changeToken = data(v.change, "opaqueChange") as object;
      if (e.changeToken && e.changeToken !== changeToken)
        throw Error("changed change handle");
      e.request = v.request;
      e.changeToken = changeToken;
      const t = track(e, v.active!);
      if (
        e.current &&
        stages[t.captured.request.stage] <
          stages[e.current.captured.request.stage]
      )
        return;
      e.current = t;
      if (v.latest) {
        const known = e.operations[v.latest.request.stage];
        if (known) result(e, known, v.latest);
        else if (v.latest.request.stage === t.captured.request.stage)
          throw Error("missing handle");
        // Earlier stage's display result on initial reattachment is not current authority.
      }
      if (v.reconciling) watchRead(e, v.reconciling);
      if (
        v.lastReconciliation &&
        e.read &&
        sameRecordingReconciliationRequest(
          v.lastReconciliation.request,
          e.read.captured.request,
        )
      )
        readResult(e, e.read, v.lastReconciliation);
    }
    if (v.lastApplied) {
      if (
        e.lastApplied &&
        sameRecordingOperationRequest(
          e.lastApplied.request,
          v.lastApplied.request,
        )
      ) {
        if (
          receiptKey(e.lastApplied.receipt) !==
          receiptKey(v.lastApplied.receipt)
        )
          throw Error("changed receipt");
      } else if (
        !e.lastApplied ||
        (e.current &&
          sameRecordingOperationRequest(
            e.current.captured.request,
            v.lastApplied.request,
          ))
      ) {
        e.lastApplied = v.lastApplied;
      }
    }
    // Do not erase locally verified evidence while owner notification catches up.
    const r = e.current?.result;
    if (v.phase === "blocked" && !r?.recoveryRequired) e.ownerBlocked = true;
    const phase = e.ownerBlocked
      ? "blocked"
      : v.phase === "blocked" || v.phase === "uncertain"
        ? v.phase
        : r &&
            v.active &&
            sameRecordingOperationRequest(r.request, v.active.request)
          ? r.quiescence === "unknown"
            ? "uncertain"
            : r.recoveryRequired
              ? "blocked"
              : r.outcome.kind === "candidate"
                ? "candidate"
                : r.outcome.kind === "paused"
                  ? "paused"
                  : "completed"
          : v.phase;
    e.view = Object.freeze({ ...v, phase });
  }
  function incoming(e: Entry, input: unknown) {
    if (disposed || entry !== e) return;
    if (locked) {
      e.queued = input;
      e.queuedPresent = true;
      return;
    }
    try {
      ingest(e, input);
    } catch {
      invalid(e);
    }
    publish();
  }
  function pull(e: Entry, allowReset = false) {
    const raw = e.binding.methods.current.call(e.binding.service);
    ingest(e, raw, allowReset);
  }
  function flush(e: Entry) {
    if (e.queuedPresent) {
      const raw = e.queued;
      e.queued = undefined;
      e.queuedPresent = false;
      try {
        ingest(e, raw);
      } catch {
        invalid(e);
      }
    }
    publish();
  }
  function release(e: Entry) {
    try {
      e.unsubscribe?.();
    } catch {
      /* unsubscription does not control the operation */
    }
    Object.values(e.operations).forEach(clearTimer);
    clearTimer(e.read);
  }
  function attach(b: OperationsBinding) {
    const e: Entry = {
      binding: b,
      operations: {},
      invalid: false,
      timedOut: false,
      queuedPresent: false,
    };
    entry = e;
    try {
      pull(e);
      const off = b.methods.subscribe.call(b.service, (next) =>
        incoming(e, next),
      );
      if (typeof off !== "function") throw Error("invalid subscription");
      if (disposed || entry !== e) off();
      else e.unsubscribe = off;
    } catch {
      e.invalid = true;
    }
  }
  function refused(e: Entry, error: unknown) {
    try {
      if (
        error instanceof RecordingOperationRejected &&
        operationErrorCode(data(error, "code"))
      ) {
        e.refusal = data(error, "code") as OperationError;
        ingest(e, data(error, "ownerState"));
        return;
      }
    } catch {
      /* Unknown dispatch evidence remains blocked. */
    }
    e.invalid = true;
  }
  function action(
    b: OperationsBinding,
    allowed: () => boolean,
    run: (e: Entry, end: number) => void,
    timeoutMs: number,
    requireSender = true,
  ): boolean {
    if (
      disposed ||
      locked ||
      (requireSender ? currentBinding() !== b : entry?.binding !== b) ||
      !allowed() ||
      !entry
    )
      return false;
    const end = deadline(timeoutMs),
      e = entry;
    locked = true;
    e.timedOut = false;
    e.refusal = undefined;
    e.cancel = undefined;
    publish();
    if (
      disposed ||
      entry !== e ||
      (requireSender ? currentBinding() !== b : e.binding !== b)
    ) {
      locked = false;
      if (!disposed) flush(e);
      return false;
    }
    if (now() >= end) {
      e.refusal = "deadlineExceeded";
      locked = false;
      flush(e);
      return false;
    }
    try {
      run(e, end);
    } catch (error) {
      refused(e, error);
    } finally {
      locked = false;
      if (!disposed) flush(e);
    }
    return true;
  }
  return {
    get state() {
      return state;
    },
    subscribe(listener: (state: OperationsMonitorState) => void) {
      if (!disposed) listeners.add(listener);
      try {
        listener(state);
      } catch {
        /* isolate */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    select(next: OperationsSelection) {
      if (disposed) return;
      selection = next;
      if (locked) {
        publish();
        return;
      }
      const b = currentBinding();
      if (b && !entry) {
        locked = true;
        if (entry) release(entry);
        attach(b);
        locked = false;
        if (entry) flush(entry);
      } else publish();
    },
    switchToSelected() {
      const b = currentBinding();
      if (disposed || locked || !state.canSwitch || !b || !entry) return false;
      locked = true;
      previous = Object.freeze({
        latest: entry.current?.result,
        lastApplied: entry.lastApplied,
      });
      release(entry);
      attach(b);
      locked = false;
      if (entry) flush(entry);
      return true;
    },
    preflight(
      b: OperationsBinding,
      input: unknown,
      timeoutMs: number,
    ): boolean {
      const request = parseRecordingChangeRequest(input);
      if (
        !sameRecordingOperationsContext(request.context, b.context) ||
        !b.desired ||
        !sameRecordingPlan(request.apply.desired, b.desired)
      )
        return false;
      return action(
        b,
        () => state.canPreflight,
        (e, end) => {
          const accepted = b.methods.preflight.call(
            b.service,
            request,
            Object.freeze({ deadlineMonotonicMs: end }),
          );
          previous = undefined;
          const change = changeHandle(data(accepted, "change")),
            raw = data(accepted, "operation") as OperationHandle;
          e.request = request;
          e.changeToken = data(change, "opaqueChange") as object;
          e.operations = {};
          e.current = undefined;
          e.read = undefined;
          const t = track(e, raw);
          if (t.captured.request.stage !== "preflight")
            throw Error("wrong stage");
          e.current = t;
          pull(e);
          if (e.view?.change !== change) throw Error("wrong handle");
          arm(e, t, end);
        },
        timeoutMs,
      );
    },
    pauseJoin(b: OperationsBinding, timeoutMs: number) {
      return action(
        b,
        () => state.canPause,
        (e, end) => {
          const operationId = id("pause"),
            raw = b.methods.pauseJoin.call(
              b.service,
              e.view!.change!,
              operationId,
              Object.freeze({ deadlineMonotonicMs: end }),
            );
          const t = track(e, raw);
          if (
            t.captured.request.stage !== "pauseJoin" ||
            t.captured.request.operationId !== operationId
          )
            throw Error("wrong stage");
          e.current = t;
          pull(e);
          arm(e, t, end);
        },
        timeoutMs,
      );
    },
    apply(b: OperationsBinding, timeoutMs: number) {
      return action(
        b,
        () => state.canApply,
        (e, end) => {
          const operationId = id("apply"),
            raw = b.methods.apply.call(
              b.service,
              e.view!.change!,
              operationId,
              Object.freeze({ deadlineMonotonicMs: end }),
            );
          const t = track(e, raw);
          if (
            t.captured.request.stage !== "apply" ||
            t.captured.request.operationId !== operationId
          )
            throw Error("wrong stage");
          e.current = t;
          pull(e);
          arm(e, t, end);
        },
        timeoutMs,
      );
    },
    discard(b: OperationsBinding) {
      return action(
        b,
        () => state.canDiscard,
        (e) => {
          b.methods.discard.call(b.service, e.view!.change!);
          pull(e, true);
          e.invalid = false;
        },
        10000,
      );
    },
    discardOriginal() {
      const b = entry?.binding;
      if (!b) return false;
      return action(
        b,
        () => state.canDiscardOriginal,
        (e) => {
          b.methods.discard.call(b.service, e.view!.change!);
          pull(e, true);
        },
        10000,
        false,
      );
    },
    reconcile(timeoutMs: number): boolean {
      if (disposed || locked || !state.canReconcile || !entry) return false;
      const e = entry,
        b = e.binding,
        end = deadline(timeoutMs);
      locked = true;
      e.timedOut = false;
      e.refusal = undefined;
      publish();
      if (disposed || entry !== e) {
        locked = false;
        return false;
      }
      if (now() >= end) {
        e.refusal = "deadlineExceeded";
        locked = false;
        flush(e);
        return false;
      }
      try {
        const reconciliationId = id("reconcile"),
          raw = b.methods.reconcile.call(
            b.service,
            e.view!.change!,
            e.current!.raw,
            reconciliationId,
            Object.freeze({ deadlineMonotonicMs: end }),
          );
        const t = watchRead(e, raw);
        if (t.captured.request.reconciliationId !== reconciliationId)
          throw Error("wrong read ID");
        pull(e);
        arm(e, t, end);
      } catch (error) {
        refused(e, error);
      } finally {
        locked = false;
        if (!disposed) flush(e);
      }
      return true;
    },
    requestCancel(read = false): CancelDisposition | undefined {
      if (
        disposed ||
        locked ||
        !entry ||
        !(read ? state.canCancelRead : state.canCancel)
      )
        return;
      const e = entry,
        t = read ? e.read : e.current;
      if (!t) return;
      locked = true;
      try {
        const disposition = t.captured.requestCancel.call(t.raw);
        if (
          !["requested", "alreadyCompleted", "notSupported"].includes(
            disposition,
          )
        )
          throw Error("invalid cancel");
        e.cancel = disposition;
        return disposition;
      } catch {
        e.invalid = true;
        return;
      } finally {
        locked = false;
        if (!disposed) flush(e);
      }
    },
    refresh() {
      if (disposed || locked || !entry) return;
      locked = true;
      try {
        pull(entry);
      } catch {
        entry.invalid = true;
      } finally {
        locked = false;
        flush(entry);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (entry) release(entry);
      entry = undefined;
    },
  };
}
