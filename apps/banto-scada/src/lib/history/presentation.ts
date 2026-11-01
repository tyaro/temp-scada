import {
  parseHistoryContract,
  type HistoryQuery,
  type HistoryResult,
} from "../history-contract";
import { ownHistoryJson, freezeHistory } from "./owned-json";

export interface HistorySource {
  /** Settle only after the underlying read is quiescent. Abort is a request,
   * not proof of cleanup; the controller waits before starting another read. */
  query(
    query: HistoryQuery,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
export type HistoryFailureCode =
  "failed" | "deadline" | "tooManyPoints" | "busy";
export class HistorySourceError extends Error {
  constructor(readonly code: HistoryFailureCode) {
    super("History request failed");
  }
}
export type HistoryRequestToken = object;
export interface HistoryPresentation {
  readonly phase:
    | "offline"
    | "idle"
    | "loading"
    | "ready"
    | "partial"
    | "unavailable"
    | "invalid"
    | "error"
    | "cancelled"
    | "disposed";
  readonly request?: HistoryRequestToken;
  readonly query?: HistoryQuery;
  readonly result?: HistoryResult;
  readonly waiting: boolean;
  readonly errorCode?:
    HistoryFailureCode | "query" | "response" | "queryMismatch";
}
interface Job {
  token: object;
  source: HistorySource;
  query: HistoryQuery;
  abort: AbortController;
}

export function sameHistoryQuery(a: HistoryQuery, b: HistoryQuery): boolean {
  return (
    a.version === b.version &&
    a.kind === b.kind &&
    a.requestId === b.requestId &&
    a.fromMs === b.fromMs &&
    a.toMs === b.toMs &&
    a.mode === b.mode &&
    a.maxPointsPerSeries === b.maxPointsPerSeries &&
    a.seriesIds.length === b.seriesIds.length &&
    a.seriesIds.every((id, i) => id === b.seriesIds[i])
  );
}

export function createHistoryController(initialSource?: HistorySource) {
  let source = initialSource;
  let current = Object.freeze({});
  let disposed = false;
  let active: Job | undefined;
  let pending: Job | undefined;
  let scheduled = false;
  let snapshot: HistoryPresentation = Object.freeze({
    phase: source ? "idle" : "offline",
    waiting: false,
  });
  const listeners = new Set<(state: HistoryPresentation) => void>();
  const isCurrent = (job: Job) =>
    !disposed && current === job.token && source === job.source;
  function publish(next: HistoryPresentation) {
    snapshot = Object.freeze(next);
    const issued = snapshot;
    for (const listener of [...listeners]) {
      if (snapshot !== issued) break;
      if (!listeners.has(listener)) continue;
      try {
        listener(issued);
      } catch {
        /* one consumer cannot prevent cleanup */
      }
    }
  }
  function retire() {
    const token = Object.freeze({});
    current = token;
    pending = undefined;
    if (active && !active.abort.signal.aborted) active.abort.abort();
    return token;
  }
  function schedule() {
    if (!scheduled && !disposed) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }
  function finish(job: Job) {
    if (active === job) active = undefined;
    schedule();
  }
  function receive(job: Job, input: unknown) {
    if (!isCurrent(job)) return;
    let result: HistoryResult;
    try {
      const parsed = parseHistoryContract(
        ownHistoryJson(input, 8 * 1024 * 1024),
      );
      if (parsed.kind !== "result") throw Error("History response kind");
      result = freezeHistory(parsed);
    } catch {
      if (isCurrent(job))
        publish({
          phase: "invalid",
          request: job.token,
          query: job.query,
          waiting: false,
          errorCode: "response",
        });
      return;
    }
    if (!isCurrent(job)) return;
    if (!sameHistoryQuery(job.query, result.query)) {
      publish({
        phase: "invalid",
        request: job.token,
        query: job.query,
        waiting: false,
        errorCode: "queryMismatch",
      });
      return;
    }
    publish({
      phase: result.status,
      request: job.token,
      query: job.query,
      result,
      waiting: false,
    });
  }
  function fail(job: Job, error: unknown) {
    if (!isCurrent(job)) return;
    let code: HistoryFailureCode = "failed";
    try {
      if (
        error instanceof HistorySourceError &&
        ["failed", "deadline", "tooManyPoints", "busy"].includes(error.code)
      )
        code = error.code;
    } catch {
      /* no raw error text crosses the presentation boundary */
    }
    if (isCurrent(job))
      publish({
        phase: "error",
        request: job.token,
        query: job.query,
        waiting: false,
        errorCode: code,
      });
  }
  function pump() {
    scheduled = false;
    if (disposed || active || !pending) return;
    const job = pending;
    pending = undefined;
    if (!isCurrent(job)) return;
    active = job;
    publish({
      phase: "loading",
      request: job.token,
      query: job.query,
      waiting: false,
    });
    if (!isCurrent(job)) {
      finish(job);
      return;
    }
    try {
      const reply = job.source.query(structuredClone(job.query), {
        signal: job.abort.signal,
      });
      void Promise.resolve(reply)
        .then(
          (value) => receive(job, value),
          (error) => fail(job, error),
        )
        .finally(() => finish(job));
    } catch (error) {
      fail(job, error);
      finish(job);
    }
  }
  return {
    get state() {
      return snapshot;
    },
    subscribe(listener: (state: HistoryPresentation) => void) {
      if (disposed) {
        try {
          listener(snapshot);
        } catch {
          /* consumer callback isolation */
        }
        return () => {};
      }
      listeners.add(listener);
      try {
        listener(snapshot);
      } catch {
        /* consumer callback isolation */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    setSource(next?: HistorySource) {
      if (disposed || source === next) return;
      source = next;
      const token = retire();
      if (!disposed && current === token)
        publish({ phase: source ? "idle" : "offline", waiting: false });
    },
    load(input: unknown): HistoryRequestToken | undefined {
      if (disposed) return undefined;
      const token = retire();
      let query: HistoryQuery;
      try {
        const parsed = parseHistoryContract(ownHistoryJson(input, 8192));
        if (parsed.kind !== "query") throw Error("History query kind");
        query = freezeHistory(parsed);
      } catch {
        if (!disposed && current === token)
          publish({
            phase: "invalid",
            request: token,
            waiting: false,
            errorCode: "query",
          });
        return token;
      }
      if (disposed || current !== token) return token;
      if (!source) {
        publish({ phase: "offline", request: token, query, waiting: false });
        return token;
      }
      pending = { token, source, query, abort: new AbortController() };
      publish({
        phase: "loading",
        request: token,
        query,
        waiting: active !== undefined,
      });
      schedule();
      return token;
    },
    cancel(expected?: HistoryRequestToken) {
      if (
        disposed ||
        (expected && expected !== current) ||
        snapshot.phase !== "loading"
      )
        return false;
      const token = retire();
      if (!disposed && current === token)
        publish({ phase: "cancelled", waiting: false });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retire();
      publish({ phase: "disposed", waiting: false });
      listeners.clear();
    },
  };
}
