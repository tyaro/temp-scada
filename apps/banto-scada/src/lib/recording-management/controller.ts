import {
  compareDesiredApplied,
  parseRecordingInspectionRequest,
  parseRecordingInspectionResponse,
  sameRecordingInspectionRequest,
  type RecordingInspectionRequest,
  type RecordingInspectionResponse,
  type DesiredAppliedComparison,
} from "../recording-management-contract";
import type {
  RecordingManagementOwner,
  RecordingManagementSelection,
} from "./service";
export type InspectionToken = object;
export interface RecordingManagementState {
  readonly phase:
    | "offline"
    | "invalidContext"
    | "contextMismatch"
    | "idle"
    | "loading"
    | "ready"
    | "cancelled"
    | "timeout"
    | "serviceFailure"
    | "invalidResponse";
  readonly owner?: RecordingManagementOwner;
  readonly token?: InspectionToken;
  readonly waiting: boolean;
  readonly response?: RecordingInspectionResponse;
  readonly comparison?: DesiredAppliedComparison;
}
interface Job {
  readonly token: InspectionToken;
  readonly owner: RecordingManagementOwner;
  readonly request: RecordingInspectionRequest;
  readonly deadline: number;
  readonly abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
/** Persistent per-App controller. Abort/timeout retire a logical result; only
 * Promise settlement releases the physical slot. now is injectable for tests. */
export function createRecordingManagementController(
  now = () => performance.now(),
) {
  let selection: RecordingManagementSelection = Object.freeze({
    phase: "offline",
  });
  let current: object = Object.freeze({});
  let logical: Job | undefined,
    active: Job | undefined,
    pending: Job | undefined;
  // Controller-local correlation only; never reset on owner changes. Future
  // adapters must not use requestId alone as a cross-App deduplication key.
  let sequence = 0;
  let disposed = false,
    scheduled = false;
  let state: RecordingManagementState = Object.freeze({
    phase: "offline",
    waiting: false,
  });
  const listeners = new Set<(value: RecordingManagementState) => void>();
  const owner = () =>
    selection.phase === "idle" ? selection.owner : undefined;
  const isCurrent = (job: Job) =>
    !disposed && current === job.token && owner() === job.owner;
  function publish(next: RecordingManagementState) {
    state = Object.freeze(next);
    const issued = state;
    for (const listener of [...listeners]) {
      if (state !== issued) break;
      if (!listeners.has(listener)) continue;
      try {
        listener(issued);
      } catch {
        /* isolate consumers */
      }
    }
  }
  function clear(job: Job | undefined) {
    if (job?.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
  }
  function abort(job: Job | undefined) {
    if (job && !job.abort.signal.aborted) job.abort.abort();
  }
  function retire() {
    current = Object.freeze({});
    clear(logical);
    logical = undefined;
    pending = undefined;
    return active;
  }
  function schedule() {
    if (!scheduled && !disposed) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }
  function finish(job: Job) {
    if (active === job) active = undefined;
    clear(job);
    schedule();
  }
  function expired(job: Job) {
    return now() >= job.deadline;
  }
  function complete(
    job: Job,
    phase: "timeout" | "serviceFailure" | "invalidResponse",
  ) {
    if (!isCurrent(job)) return;
    clear(job);
    logical = undefined;
    if (pending === job) pending = undefined;
    // Invalidate before callbacks/abort, but keep the retired request token for UI.
    current = Object.freeze({});
    publish({
      phase,
      owner: job.owner,
      token: job.token,
      waiting: false,
    });
    if (phase === "timeout") abort(job);
  }
  function expire(job: Job) {
    if (!isCurrent(job)) return;
    // Browser timers can fire early. They never extend the absolute deadline.
    if (!expired(job)) {
      job.timer = setTimeout(() => expire(job), job.deadline - now());
      return;
    }
    complete(job, "timeout");
  }
  function receive(job: Job, input: unknown) {
    if (!isCurrent(job)) return;
    if (expired(job)) {
      complete(job, "timeout");
      return;
    }
    let response: RecordingInspectionResponse,
      comparison: DesiredAppliedComparison;
    try {
      response = parseRecordingInspectionResponse(input);
      if (!sameRecordingInspectionRequest(job.request, response.request))
        throw Error("mismatch");
      comparison = compareDesiredApplied(job.owner.desired, response);
    } catch {
      complete(job, expired(job) ? "timeout" : "invalidResponse");
      return;
    }
    if (!isCurrent(job)) return;
    if (expired(job)) {
      complete(job, "timeout");
      return;
    }
    clear(job);
    logical = undefined;
    publish({
      phase: "ready",
      owner: job.owner,
      token: job.token,
      waiting: false,
      response,
      comparison,
    });
  }
  function fail(job: Job) {
    if (isCurrent(job))
      complete(job, expired(job) ? "timeout" : "serviceFailure");
  }
  function pump() {
    scheduled = false;
    if (disposed || active || !pending) return;
    const job = pending;
    pending = undefined;
    if (!isCurrent(job)) return;
    if (expired(job)) {
      complete(job, "timeout");
      return;
    }
    active = job;
    publish({
      phase: "loading",
      owner: job.owner,
      token: job.token,
      waiting: false,
    });
    if (!isCurrent(job)) {
      finish(job);
      return;
    }
    if (expired(job)) {
      complete(job, "timeout");
      finish(job);
      return;
    }
    try {
      const reply = job.owner.inspect.call(
        job.owner.service,
        job.request,
        Object.freeze({
          signal: job.abort.signal,
          deadlineMonotonicMs: job.deadline,
        }),
      );
      // Reject synchronous values and arbitrary thenables. Use the Promise brand,
      // not a caller-provided then method. The service contract requires Promise.
      Promise.prototype.then.call(
        reply,
        (value: unknown) => {
          try {
            receive(job, value);
          } finally {
            finish(job);
          }
        },
        () => {
          try {
            fail(job);
          } finally {
            finish(job);
          }
        },
      );
    } catch {
      fail(job);
      finish(job);
    }
  }
  return {
    get state() {
      return state;
    },
    subscribe(listener: (value: RecordingManagementState) => void) {
      if (!disposed) listeners.add(listener);
      try {
        listener(state);
      } catch {
        /* consumer isolation */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    setOwner(next: RecordingManagementSelection) {
      if (disposed || selection === next) return;
      const previous = retire(),
        token = current;
      selection = next;
      publish({ phase: selection.phase, owner: owner(), waiting: false });
      // Only abort the captured old physical job, even after subscriber reentry.
      abort(previous);
      if (current === token) schedule();
    },
    load(timeoutMs: number): InspectionToken | undefined {
      if (disposed) return;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 10000
      )
        throw Error("Recording inspection timeout: invalid");
      const start = now(),
        deadline = start + timeoutMs;
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(deadline))
        throw Error("Recording inspection clock: invalid");
      const previous = retire(),
        token = current,
        binding = owner();
      if (!binding) {
        publish({ phase: selection.phase, waiting: false, token });
        abort(previous);
        return token;
      }
      if (sequence >= Number.MAX_SAFE_INTEGER) {
        publish({
          phase: "serviceFailure",
          owner: binding,
          token,
          waiting: false,
        });
        abort(previous);
        return token;
      }
      const job: Job = {
        token,
        owner: binding,
        request: parseRecordingInspectionRequest({
          version: 1,
          kind: "recordingInspectionRequest",
          requestId: `inspection:${++sequence}`,
          context: binding.context,
        }),
        deadline,
        abort: new AbortController(),
      };
      logical = job;
      pending = job;
      job.timer = setTimeout(() => expire(job), Math.max(0, deadline - now()));
      publish({
        phase: "loading",
        owner: binding,
        token,
        waiting: active !== undefined,
      });
      abort(previous);
      schedule();
      return token;
    },
    cancel(expected?: InspectionToken) {
      if (
        disposed ||
        state.phase !== "loading" ||
        (expected && current !== expected)
      )
        return false;
      const binding = owner(),
        previous = retire();
      publish({ phase: "cancelled", owner: binding, waiting: false });
      abort(previous);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const previous = retire();
      listeners.clear();
      state = Object.freeze({ phase: "offline", waiting: false });
      abort(previous);
    },
  };
}
