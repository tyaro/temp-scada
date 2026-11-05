/** Test-only ownership model. Reply delivery, call-task end and native result remain separate. */
import { sameOwnedJson } from "./json-equality";
import { freezeHistory, ownHistoryJson } from "./history/owned-json";
import {
  parseRecordingWireAttachRequest,
  type RecordingWireScope,
} from "./recording-wire-contract";
import {
  isRecordingWireDeliveryLedger,
  type WireDeliveryLedger,
} from "./recording-wire-delivery-ledger";
import {
  isRecordingWireReceiver,
  type WireReceiver,
  type RecordingWireDisplay,
} from "./recording-wire-receiver";
import {
  isRecordingWireLocalV2For,
  type RecordingWireLocalV2,
  type LocalV2Handle,
} from "./recording-wire-local-v2";

export type CoordinatorRoute =
  | "original"
  | "inspectionAttempt"
  | "observationAttempt"
  | "observationQuery"
  | "attach"
  | "control";
export type SendingRoute = Exclude<CoordinatorRoute, "observationQuery">;
export type CoordinatorReason =
  | "busy"
  | "foreignToken"
  | "invalidSource"
  | "scopeMismatch"
  | "capacity"
  | "closed"
  | "conflict"
  | "endedBeforeStart"
  | "alreadyStarted"
  | "sourceFailure";
export type CoordinatorResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: CoordinatorReason }
>;
const yes = <T>(value: T): CoordinatorResult<T> =>
  Object.freeze({ ok: true, value });
const no = (reason: CoordinatorReason): CoordinatorResult<never> =>
  Object.freeze({ ok: false, reason });
const sending = new Set<CoordinatorRoute>([
  "original",
  "inspectionAttempt",
  "observationAttempt",
  "attach",
  "control",
]);

export type TestTransportTicketV2 = Readonly<{
  scope: RecordingWireScope;
  route: SendingRoute;
  request: unknown;
  completion: Promise<void>;
}>;
type TicketRecord = {
  status: "issued" | "ended";
  outcome: "returned" | "rejected" | null;
  resolve: () => void;
  reject: (error: Error) => void;
};
export interface TestTransportPortV2 {
  readonly mode: "testOnly";
  readonly scope: RecordingWireScope;
  issue(
    route: SendingRoute,
    request: unknown,
  ): CoordinatorResult<TestTransportTicketV2>;
  finish(
    ticket: TestTransportTicketV2,
    outcome: "returned" | "rejected",
  ): CoordinatorResult<null>;
  inspect(ticket: TestTransportTicketV2): Readonly<{
    status: "issued" | "ended";
    outcome: "returned" | "rejected" | null;
  }> | null;
}
const ports = new WeakSet<object>();
const ticketOwners = new WeakMap<object, TestTransportPortV2>();
export function isTestTransportPortV2(
  value: unknown,
): value is TestTransportPortV2 {
  return typeof value === "object" && value !== null && ports.has(value);
}
export function createTestTransportPortV2(
  scopeInput: unknown,
  maxTickets = 256,
): CoordinatorResult<TestTransportPortV2> {
  if (!Number.isSafeInteger(maxTickets) || maxTickets < 0 || maxTickets > 256)
    return no("invalidSource");
  let scope: RecordingWireScope;
  try {
    scope = parseRecordingWireAttachRequest({
      version: 1,
      kind: "recordingWireAttachRequest",
      scope: scopeInput,
      attachId: "test-port",
      afterRevision: null,
    }).scope;
  } catch {
    return no("invalidSource");
  }
  const tickets = new Map<TestTransportTicketV2, TicketRecord>();
  let busy = false;
  function guard<T>(run: () => CoordinatorResult<T>): CoordinatorResult<T> {
    if (busy) return no("busy");
    busy = true;
    try {
      return run();
    } finally {
      busy = false;
    }
  }
  const port: TestTransportPortV2 = Object.freeze({
    mode: "testOnly" as const,
    scope,
    issue(route: SendingRoute, request: unknown) {
      return guard(() => {
        if (!sending.has(route)) return no("invalidSource");
        if (tickets.size >= maxTickets) return no("capacity");
        let owned: unknown;
        try {
          owned = freezeHistory(
            ownHistoryJson(request, 2_000_000, 250_000, "wireRequest"),
          );
        } catch {
          return no("invalidSource");
        }
        let resolve!: () => void, reject!: (error: Error) => void;
        const completion = Object.freeze(
          new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
        );
        // A rejected test task may be observed only after a coordinator is attached.
        void completion.catch(() => {});
        const ticket = Object.freeze({
          scope,
          route,
          request: owned,
          completion,
        });
        tickets.set(ticket, {
          status: "issued",
          outcome: null,
          resolve,
          reject,
        });
        ticketOwners.set(ticket, port);
        return yes(ticket);
      });
    },
    finish(ticket: TestTransportTicketV2, outcome: "returned" | "rejected") {
      return guard(() => {
        const record = tickets.get(ticket);
        if (!record || ticketOwners.get(ticket) !== port)
          return no("foreignToken");
        if (outcome !== "returned" && outcome !== "rejected")
          return no("invalidSource");
        if (record.status === "ended")
          return record.outcome === outcome ? yes(null) : no("conflict");
        // Synchronous lifecycle closes before Promise callbacks run.
        record.status = "ended";
        record.outcome = outcome;
        if (outcome === "returned") record.resolve();
        else record.reject(Error("test transport task rejected"));
        return yes(null);
      });
    },
    inspect(ticket: TestTransportTicketV2) {
      const record = tickets.get(ticket);
      return record && ticketOwners.get(ticket) === port
        ? Object.freeze({ status: record.status, outcome: record.outcome })
        : null;
    },
  });
  ports.add(port);
  return yes(port);
}

export type CoordinatorTrackV2 = Readonly<{
  scope: RecordingWireScope;
  route: CoordinatorRoute;
  request: unknown;
  completion: Promise<unknown>;
}>;
export type CoordinatorAttemptV2 = Readonly<{
  track: CoordinatorTrackV2;
  ticket: TestTransportTicketV2;
}>;
export type AttemptStatusV2 = "reserved" | "inFlight" | "returned" | "rejected";
export type CoordinatorTrackStateV2 = Readonly<{
  track: CoordinatorTrackV2;
  delivery: "pending" | "delivered";
  reply: unknown | null;
  attempt: Readonly<{
    attempt: CoordinatorAttemptV2;
    status: AttemptStatusV2;
    endedBeforeStart: boolean;
  }> | null;
}>;
export type CoordinatorStateV2 = Readonly<{
  version: 2;
  mode: "testOnly";
  scope: RecordingWireScope;
  display: RecordingWireDisplay;
  closed: boolean;
  invalid: boolean;
  view: "none" | "active" | "retired";
  tracks: readonly CoordinatorTrackStateV2[];
  usage: Readonly<{
    tracks: number;
    attempts: number;
    maxTracks: number;
    maxAttempts: number;
  }>;
}>;
export interface CoordinatorViewV2 {
  retire(): CoordinatorResult<null>;
}
export interface RecordingWireCoordinatorV2 {
  readonly version: 2;
  readonly mode: "testOnly";
  readonly scope: RecordingWireScope;
  track(
    route: CoordinatorRoute,
    token: unknown,
  ): CoordinatorResult<CoordinatorTrackV2>;
  reserveAttempt(
    track: CoordinatorTrackV2,
    ticket: TestTransportTicketV2,
  ): CoordinatorResult<CoordinatorAttemptV2>;
  markStarted(attempt: CoordinatorAttemptV2): CoordinatorResult<null>;
  bindView(identity: object): CoordinatorResult<CoordinatorViewV2>;
  pump(): CoordinatorResult<
    Readonly<{ delivered: number; pending: number; sourceFailures: number }>
  >;
  current(): CoordinatorStateV2;
  close(): CoordinatorResult<null>;
}
type AttemptRecord = {
  handle: CoordinatorAttemptV2;
  status: AttemptStatusV2;
  endedBeforeStart: boolean;
};
type TrackRecord = {
  handle: CoordinatorTrackV2;
  token: object;
  reply: unknown | null;
  attempt: AttemptRecord | null;
};
const ledgerClaims = new WeakSet<object>(),
  receiverClaims = new WeakSet<object>(),
  portClaims = new WeakSet<object>();
function parseLimits(
  options: unknown,
): Readonly<{ maxTracks: number; maxAttempts: number }> | null {
  if (options === undefined)
    return Object.freeze({ maxTracks: 256, maxAttempts: 256 });
  try {
    if (
      !options ||
      typeof options !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      return null;
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => key !== "maxTracks" && key !== "maxAttempts"))
      return null;
    let maxTracks = 256,
      maxAttempts = 256;
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(options, key);
      if (
        !d ||
        !("value" in d) ||
        !d.enumerable ||
        !Number.isSafeInteger(d.value) ||
        d.value < 0 ||
        d.value > 256
      )
        return null;
      if (key === "maxTracks") maxTracks = d.value;
      else maxAttempts = d.value;
    }
    return Object.freeze({ maxTracks, maxAttempts });
  } catch {
    return null;
  }
}
function sourceReason(reason: string): CoordinatorReason {
  return reason === "busy" || reason === "foreignToken" || reason === "capacity"
    ? reason
    : "sourceFailure";
}
export function createRecordingWireCoordinatorV2(
  ledger: WireDeliveryLedger,
  receiver: WireReceiver,
  local: RecordingWireLocalV2,
  port: TestTransportPortV2,
  options?: Readonly<{ maxTracks?: number; maxAttempts?: number }>,
): CoordinatorResult<RecordingWireCoordinatorV2> {
  const limits = parseLimits(options);
  if (!limits) return no("invalidSource");
  const { maxTracks, maxAttempts } = limits;
  if (
    !isRecordingWireDeliveryLedger(ledger) ||
    !isRecordingWireReceiver(receiver) ||
    !isRecordingWireLocalV2For(local, ledger, receiver) ||
    !isTestTransportPortV2(port)
  )
    return no("invalidSource");
  if (
    ledgerClaims.has(ledger) ||
    receiverClaims.has(receiver) ||
    portClaims.has(port)
  )
    return no("conflict");
  let scope: RecordingWireScope, display: RecordingWireDisplay;
  try {
    scope = ledger.current().scope;
    display = receiver.currentDisplay();
    if (
      !sameOwnedJson(scope, display.scope) ||
      !sameOwnedJson(scope, local.scope) ||
      !sameOwnedJson(scope, port.scope)
    )
      return no("scopeMismatch");
  } catch {
    return no("invalidSource");
  }
  ledgerClaims.add(ledger);
  receiverClaims.add(receiver);
  portClaims.add(port);
  const tracks = new Map<object, TrackRecord>();
  const byHandle = new Map<CoordinatorTrackV2, TrackRecord>();
  const byAttempt = new Map<CoordinatorAttemptV2, AttemptRecord>();
  const byTicket = new Map<TestTransportTicketV2, AttemptRecord>();
  let attemptCount = 0,
    busy = false,
    dirty = false,
    closed = false,
    invalid = false;
  let viewLease: CoordinatorViewV2 | null = null;
  let viewStatus: CoordinatorStateV2["view"] = "none";
  const views = new WeakMap<object, CoordinatorViewV2>();
  let published: CoordinatorStateV2 = state();
  function state(): CoordinatorStateV2 {
    return Object.freeze({
      version: 2 as const,
      mode: "testOnly" as const,
      scope,
      display,
      closed,
      invalid,
      view: viewStatus,
      tracks: Object.freeze(
        [...tracks.values()].map((record) =>
          Object.freeze({
            track: record.handle,
            delivery:
              record.reply === null
                ? ("pending" as const)
                : ("delivered" as const),
            reply: record.reply,
            attempt: record.attempt
              ? Object.freeze({
                  attempt: record.attempt.handle,
                  status: record.attempt.status,
                  endedBeforeStart: record.attempt.endedBeforeStart,
                })
              : null,
          }),
        ),
      ),
      usage: Object.freeze({
        tracks: tracks.size,
        attempts: attemptCount,
        maxTracks,
        maxAttempts,
      }),
    });
  }
  function publish() {
    if (dirty) {
      published = state();
      dirty = false;
    }
  }
  function guard<T>(run: () => CoordinatorResult<T>): CoordinatorResult<T> {
    if (busy) return no("busy");
    busy = true;
    try {
      return run();
    } finally {
      try {
        publish();
      } finally {
        busy = false;
      }
    }
  }
  function watch(
    route: CoordinatorRoute,
    token: unknown,
  ): ReturnType<RecordingWireLocalV2["watchOriginal"]> {
    switch (route) {
      case "original":
        return local.watchOriginal(token as never);
      case "inspectionAttempt":
        return local.watchInspectionAttempt(token as never) as never;
      case "observationAttempt":
        return local.watchObservationAttempt(token as never) as never;
      case "observationQuery":
        return local.watchObservationQuery(token as never) as never;
      case "attach":
        return local.watchAttach(token as never) as never;
      case "control":
        return local.watchControl(token as never) as never;
    }
  }
  function owned(
    route: CoordinatorRoute,
    token: object,
  ): CoordinatorResult<null> {
    try {
      const result =
        route === "original"
          ? ledger.original(token as never)
          : route === "inspectionAttempt"
            ? ledger.attempt(token as never)
            : route === "observationAttempt"
              ? ledger.observationAttempt(token as never)
              : route === "observationQuery"
                ? ledger.observation(token as never)
                : route === "attach"
                  ? receiver.attachTerminal(token as never)
                  : receiver.controlTerminal(token as never);
      return result.ok ? yes(null) : no(sourceReason(result.reason));
    } catch {
      return no("sourceFailure");
    }
  }
  function completed(record: TrackRecord, reply: unknown) {
    if (record.reply !== null) return;
    try {
      if (
        !reply ||
        typeof reply !== "object" ||
        !sameOwnedJson(
          (reply as { request: unknown }).request,
          record.handle.request,
        )
      )
        throw Error("wrong reply");
      record.reply = reply;
    } catch {
      invalid = true;
    }
    dirty = true;
    publish();
  }
  const root: RecordingWireCoordinatorV2 = Object.freeze({
    version: 2,
    mode: "testOnly",
    scope,
    track(route: CoordinatorRoute, token: unknown) {
      return guard(() => {
        if (!sending.has(route) && route !== "observationQuery")
          return no("foreignToken");
        if (!token || typeof token !== "object") return no("foreignToken");
        const known = tracks.get(token);
        if (known)
          return known.handle.route === route
            ? yes(known.handle)
            : no("foreignToken");
        if (closed) return no("closed");
        const belonging = owned(route, token);
        if (!belonging.ok) return belonging;
        if (tracks.size >= maxTracks) return no("capacity");
        let source: ReturnType<RecordingWireLocalV2["watchOriginal"]>;
        try {
          source = watch(route, token);
        } catch {
          return no("sourceFailure");
        }
        if (!source.ok) return no(sourceReason(source.reason));
        const handle = Object.freeze({
          scope,
          route,
          request: source.value.request,
          completion: source.value.completion as Promise<unknown>,
        });
        const record: TrackRecord = {
          handle,
          token,
          reply: null,
          attempt: null,
        };
        tracks.set(token, record);
        byHandle.set(handle, record);
        dirty = true;
        void source.value.completion.then(
          (reply) => completed(record, reply),
          () => {
            invalid = true;
            dirty = true;
            publish();
          },
        );
        return yes(handle);
      });
    },
    reserveAttempt(track: CoordinatorTrackV2, ticket: TestTransportTicketV2) {
      return guard(() => {
        const record = byHandle.get(track);
        if (!record) return no("foreignToken");
        if (record.handle.route === "observationQuery") return no("conflict");
        const ticketState = port.inspect(ticket);
        if (!ticketState) return no("foreignToken");
        if (
          !sameOwnedJson(ticket.scope, scope) ||
          ticket.route !== record.handle.route ||
          !sameOwnedJson(ticket.request, record.handle.request)
        )
          return no("scopeMismatch");
        if (record.attempt)
          return record.attempt.handle.ticket === ticket
            ? yes(record.attempt.handle)
            : no("conflict");
        if (byTicket.has(ticket)) return no("conflict");
        if (closed) return no("closed");
        if (attemptCount >= maxAttempts) return no("capacity");
        const handle = Object.freeze({ track, ticket });
        const attempt: AttemptRecord = {
          handle,
          status: "reserved",
          endedBeforeStart: ticketState.status === "ended",
        };
        record.attempt = attempt;
        byAttempt.set(handle, attempt);
        byTicket.set(ticket, attempt);
        attemptCount++;
        dirty = true;
        void ticket.completion.then(
          () => ended(attempt, "returned"),
          () => ended(attempt, "rejected"),
        );
        return yes(handle);
      });
    },
    markStarted(handle: CoordinatorAttemptV2) {
      return guard(() => {
        const attempt = byAttempt.get(handle);
        if (!attempt) return no("foreignToken");
        if (attempt.status !== "reserved") return no("alreadyStarted");
        if (closed) return no("closed");
        if (
          attempt.endedBeforeStart ||
          port.inspect(handle.ticket)?.status !== "issued"
        ) {
          attempt.endedBeforeStart = true;
          dirty = true;
          return no("endedBeforeStart");
        }
        attempt.status = "inFlight";
        dirty = true;
        return yes(null);
      });
    },
    bindView(identity: object) {
      return guard(() => {
        if (!identity || typeof identity !== "object")
          return no("foreignToken");
        const old = views.get(identity);
        if (old) return yes(old);
        if (closed) return no("closed");
        if (viewStatus === "active") return no("conflict");
        const lease: CoordinatorViewV2 = Object.freeze({
          retire: () =>
            guard(() => {
              if (viewLease === lease && viewStatus === "active") {
                viewStatus = "retired";
                dirty = true;
              }
              return yes(null);
            }),
        });
        views.set(identity, lease);
        viewLease = lease;
        viewStatus = "active";
        dirty = true;
        return yes(lease);
      });
    },
    pump() {
      return guard(() => {
        let result: ReturnType<RecordingWireLocalV2["pump"]>;
        try {
          result = local.pump();
        } catch {
          return no("sourceFailure");
        }
        if (!result.ok) return no(sourceReason(result.reason));
        const next = local.current().display;
        if (next !== display) {
          display = next;
          dirty = true;
        }
        return yes(result.value);
      });
    },
    current: () => published,
    close: () =>
      guard(() => {
        if (!closed) {
          closed = true;
          dirty = true;
        }
        return yes(null);
      }),
  });
  function ended(attempt: AttemptRecord, outcome: "returned" | "rejected") {
    if (attempt.status === "reserved") attempt.endedBeforeStart = true;
    else if (attempt.status === "inFlight") attempt.status = outcome;
    dirty = true;
    publish();
  }
  return yes(root);
}
