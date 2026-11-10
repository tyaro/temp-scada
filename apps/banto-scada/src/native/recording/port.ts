// The desktop's port v2 (product-owner design C5 §7.2 "native実装"): one
// root (ownerEpoch) and one desktop session generation (`seq`). Every call
// goes through the delivery ledger (originals, CallInspection, Observation)
// or the receiver (attach, control, frames), and stored replies reach the
// coordinator only through local-v2 (`mode: "native"`). Nothing here judges
// a native deadline: leases expire by the host's `Instant` alone (§7.2
// "時計"); the JS timers only pace observation repeats and the end of a
// subscription.
import { sameOwnedJson } from "../../lib/json-equality";
import { freezeHistory } from "../../lib/history/owned-json";
import {
  defineAsyncRecordingPortV2,
  type AsyncRecordingOperationsPortV2,
  type PortCallV2,
  type PortHostRefusal,
  type PortLeaseRequestV2,
  type PortObservationV2,
  type PortStateV2,
  type PortTransportEnd,
  type PortOwnerClosed,
  type PortAuthorizationLost,
} from "../../lib/recording-async/port";
import {
  createRecordingWireDeliveryLedger,
  type OriginalCallToken,
  type WireDeliveryLedger,
} from "../../lib/recording-wire-delivery-ledger";
import {
  createRecordingWireReceiver,
  type AttachGeneration,
  type WireReceiver,
} from "../../lib/recording-wire-receiver";
import {
  createRecordingWireLocalV2,
  type RecordingWireLocalV2,
} from "../../lib/recording-wire-local-v2";
import type {
  RecordingWireScope,
  RecordingWireObservationTarget,
  RecordingWireObservationReply,
} from "../../lib/recording-wire-contract";
import {
  callRecording,
  type CommandAnswer,
  type RecordingCommand,
  type RecordingInvoke,
} from "./commands";
import {
  listenRecording,
  type RecordingEventPayload,
  type RecordingListen,
} from "./events";

/** Pending observation queries are asked again at the host's frame poll interval. */
export const OBSERVATION_REPEAT_MS = 250;
/** New queries after a query's attempt lost its reply (design §8.1-8). */
export const OBSERVATION_RETRIES = 2;
/** Attaches again after an `ended` or a resync, shared (design §7.2). */
export const REATTACH_LIMIT = 1;

/** Why the port asks for `recording_slot` to be read again (§7.2). */
export type PortSignal = "ownerClosed" | "seqChanged" | "stopped";

export interface NativePortOptions {
  invoke: RecordingInvoke;
  listen: RecordingListen;
  scope: RecordingWireScope;
  access: "mutation" | "read";
  /** Called once per cause: the slot is read again (§7.2 "slotの読み直し"). */
  signal?: (signal: PortSignal) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  newId?: (tag: string) => string;
}

export interface NativeRecordingPort {
  readonly port: AsyncRecordingOperationsPortV2;
  /** Listens, then attaches. Resolves once the first attach has ended either way. */
  start(): Promise<void>;
  /**
   * Stops listening and attaching (a detach is sent when attached). Calls and
   * observations already sent still settle, so a closed coordinator can keep
   * monitoring accepted work.
   */
  dispose(): void;
}

type Observed = {
  target: RecordingWireObservationTarget;
  view: PortObservationV2;
  query: "pending" | "terminal" | "transportLost";
  inFlight: number;
};

function take<T>(
  r: Readonly<{ ok: true; value: T } | { ok: false; reason: string }>,
): T {
  if (!r.ok) throw Error(r.reason);
  return r.value;
}

function localRefusal(reason: string): PortHostRefusal {
  return Object.freeze({
    kind:
      reason === "busy"
        ? "busy"
        : reason === "capacity"
          ? "capacity"
          : reason === "protocolViolation" || reason === "retired"
            ? "protocolViolation"
            : "invalidRequest",
  }) as PortHostRefusal;
}

export function createNativeRecordingPortV2(
  options: NativePortOptions,
): NativeRecordingPort {
  const { invoke, listen, access } = options;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const newId =
    options.newId ?? ((tag: string) => `${tag}:${crypto.randomUUID()}`);
  const ledger: WireDeliveryLedger = take(
    createRecordingWireDeliveryLedger(options.scope),
  );
  const receiver: WireReceiver = take(
    createRecordingWireReceiver(options.scope),
  );
  const local: RecordingWireLocalV2 = take(
    createRecordingWireLocalV2(ledger, receiver, { mode: "native" }),
  );
  const scope = ledger.current().scope;
  take(receiver.setConnected(true));

  let seq: number | null = null;
  let subscription: PortStateV2["subscription"] = "idle";
  let ended: string | null = null;
  let ownerClosed: PortOwnerClosed | null = null;
  let authorizationLost: PortAuthorizationLost | null = null;
  let resyncRequired = false;
  let nativeRecoveryRequired = false;
  let generation: AttachGeneration | undefined;
  let reattachLeft = REATTACH_LIMIT;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const signalled = new Set<PortSignal>();
  const observed: Observed[] = [];
  const originals = new WeakMap<object, OriginalCallToken>();
  /** Observations whose admission reply is not stored yet. */
  let unbound: (() => boolean)[] = [];
  const admissions: OriginalCallToken[] = [];
  const listeners = new Set<(state: PortStateV2) => void>();
  const timers = new Set<unknown>();
  let published = build();

  function signal(s: PortSignal) {
    if (signalled.has(s)) return;
    signalled.add(s);
    try {
      options.signal?.(s);
    } catch {
      /* the slot reader's own failure is not the port's */
    }
  }
  function build(): PortStateV2 {
    const display = local.current().display;
    nativeRecoveryRequired ||= display.nativeRecoveryRequired;
    return freezeHistory({
      version: 2,
      scope,
      access,
      seq,
      display,
      subscription,
      ended,
      ownerClosed,
      authorizationLost,
      resyncRequired,
      nativeRecoveryRequired,
      observations: observed.map((o) => ({
        target: o.target,
        query: o.query,
        attemptsInFlight: o.inFlight,
      })),
      usage: {
        ledger: ledger.current().usage,
        receiver: display.usage,
      },
    }) as PortStateV2;
  }
  function publish() {
    if (unbound.length) {
      const waiting = unbound;
      unbound = [];
      unbound = waiting.filter((bind) => !bind()).concat(unbound);
    }
    try {
      local.pump();
    } catch {
      /* a source failure stays in the ledger or receiver */
    }
    const next = build();
    if (sameOwnedJson(next, published)) return;
    published = next;
    for (const fn of [...listeners])
      if (listeners.has(fn))
        try {
          fn(next);
        } catch {
          /* a listener's failure is its own */
        }
  }
  function later(run: () => void, ms: number) {
    const t = setTimer(() => {
      timers.delete(t);
      run();
    }, ms);
    timers.add(t);
  }
  function closeOwner(cause: PortOwnerClosed) {
    ownerClosed ??= cause;
    signal("ownerClosed");
  }
  function loseAuthorization(cause: PortAuthorizationLost) {
    authorizationLost ??= cause;
    if (cause === "seqChanged") signal("seqChanged");
  }
  /**
   * One physical call. Binds the first returned `seq`; a reply of another
   * generation is dropped (`staleSeq`). Host refusals record their cause.
   */
  async function send(
    command: RecordingCommand,
    args: Record<string, unknown>,
  ): Promise<
    | Readonly<{ end: PortTransportEnd; reply: unknown; returned: true }>
    | Readonly<{ end: PortTransportEnd; returned: false }>
  > {
    const answer: CommandAnswer = await callRecording(invoke, command, args);
    if (answer.kind === "failed")
      return { end: Object.freeze({ kind: "failed" }), returned: false };
    if (answer.kind === "refused") {
      const r = answer.refusal;
      if (r.kind === "recordingUnavailable") closeOwner("slotEmpty");
      else if (r.kind === "closed") closeOwner("hostClosed");
      else if (r.kind === "unauthorized") loseAuthorization("refused");
      return {
        end: Object.freeze({ kind: "refused", refusal: r }),
        returned: false,
      };
    }
    seq ??= answer.seq;
    if (answer.seq !== seq) {
      loseAuthorization("seqChanged");
      return {
        end: Object.freeze({ kind: "staleSeq", seq: answer.seq }),
        returned: false,
      };
    }
    return {
      end: Object.freeze({ kind: "returned" }),
      reply: answer.reply,
      returned: true,
    };
  }
  function settled<T>(value: T): Promise<T> {
    return Promise.resolve(value);
  }
  const never = <T>() => new Promise<T>(() => {});
  /** A call refused before anything was sent. */
  function unsent<Q, R>(
    request: Q,
    refusal: PortHostRefusal,
  ): PortCallV2<Q, R> {
    return Object.freeze({
      request,
      reply: never<R>(),
      transport: settled<PortTransportEnd>(
        Object.freeze({ kind: "refused", refusal }),
      ),
    });
  }

  /**
   * An original call (lease, admission, admission inspection, cancel): the
   * ledger reserves it before anything is sent, and its stored terminal is
   * the call's `reply`, delivered once by local-v2 (also when CallInspection
   * recovers it later). A lost reply leaves the original pending in the
   * ledger; it is never sent again.
   */
  function original<Q, R>(
    request: Q,
    wire: unknown,
    steps: (token: OriginalCallToken) => Promise<PortTransportEnd>,
    admission = false,
  ): PortCallV2<Q, R> {
    const begun = ledger.beginOriginal(wire);
    if (!begun.ok) {
      publish();
      return unsent(request, localRefusal(begun.reason));
    }
    const token = begun.value;
    const watched = local.watchOriginal(token);
    if (!watched.ok) {
      publish();
      return unsent(request, localRefusal(watched.reason));
    }
    if (admission) admissions.push(token);
    const call: PortCallV2<Q, R> = Object.freeze({
      request,
      reply: watched.value.completion as Promise<R>,
      transport: steps(token).then(
        (end) => {
          publish();
          return end;
        },
        () => {
          publish();
          return Object.freeze({ kind: "failed" }) as PortTransportEnd;
        },
      ),
    });
    originals.set(call, token);
    publish();
    return call;
  }
  /** Sends the original and stores its reply. */
  async function deliverOriginal(
    token: OriginalCallToken,
    command: RecordingCommand,
    args: Record<string, unknown>,
  ): Promise<PortTransportEnd> {
    const sent = await send(command, args);
    if (!sent.returned) return sent.end;
    const accepted = ledger.acceptOriginal(token, sent.reply);
    return accepted.ok ? sent.end : Object.freeze({ kind: "failed" });
  }

  function prepareLease(
    request: PortLeaseRequestV2,
  ): PortCallV2<PortLeaseRequestV2, never> {
    const lease = request?.lease;
    const role = request?.role;
    if (
      !lease ||
      (role !== "mutation" && role !== "reconciliation") ||
      lease.role !== role
    )
      return unsent(request, Object.freeze({ kind: "invalidRequest" }));
    if (role === "mutation" && access !== "mutation")
      return unsent(request, Object.freeze({ kind: "forbidden" }));
    return original(request, lease, async (token) => {
      if (request.role === "reconciliation")
        return deliverOriginal(token, "recording_lease", { request: lease });
      if (request.stage === "preflight") {
        const reserved = await send("recording_workflow_reserve", {
          request: request.change,
        });
        if (!reserved.returned) return reserved.end;
        const changeId = (reserved.reply as { changeId?: unknown } | null)
          ?.changeId;
        if (changeId !== request.change.changeId)
          return Object.freeze({ kind: "failed" });
      }
      return deliverOriginal(token, "recording_workflow_lease", {
        stage: request.stage,
        operationId: "operationId" in request ? request.operationId : null,
        request: lease,
      });
    });
  }

  function inspectCall(
    originalCall: PortCallV2<unknown, unknown>,
  ): PortCallV2<unknown, never> {
    const token =
      originalCall && typeof originalCall === "object"
        ? originals.get(originalCall)
        : undefined;
    if (!token) return unsent(null, Object.freeze({ kind: "invalidRequest" }));
    const stored = take(ledger.original(token));
    const request = freezeHistory({
      version: 1,
      kind: "recordingWireCallInspectionRequest",
      scope,
      callInspectionId: newId("ci"),
      original: stored.request,
    });
    const begun = ledger.beginInspection(token, request);
    if (!begun.ok) return unsent(request, localRefusal(begun.reason));
    const watched = local.watchInspectionAttempt(begun.value.attempt);
    if (!watched.ok) return unsent(request, localRefusal(watched.reason));
    const transport = (async () => {
      const sent = await send("recording_call_inspection", { request });
      if (!sent.returned) return sent.end;
      return ledger.acceptInspection(begun.value.attempt, sent.reply).ok
        ? sent.end
        : (Object.freeze({ kind: "failed" }) as PortTransportEnd);
    })().then(
      (end) => {
        publish();
        return end;
      },
      () => {
        publish();
        return Object.freeze({ kind: "failed" }) as PortTransportEnd;
      },
    );
    publish();
    return Object.freeze({
      request,
      reply: watched.value.completion as Promise<never>,
      transport,
    });
  }

  /** The admission whose stored accepted handle is this target. */
  function targetSource(
    target: RecordingWireObservationTarget,
  ): OriginalCallToken | undefined {
    for (const token of admissions) {
      const bound = ledger.bindObservationTarget(token);
      if (!bound.ok) continue;
      const t = ledger.observationTarget(bound.value);
      if (t.ok && sameOwnedJson(t.value.target, target)) return token;
    }
    return undefined;
  }

  /**
   * One query per target at a time; `pending` is asked again every 250 ms
   * with a new attempt. An attempt whose call ends without a reply is
   * abandoned and a new query (new observationId) is made, at most twice;
   * then the target is `transportLost` and its `result` never resolves.
   */
  function observe(target: RecordingWireObservationTarget): PortObservationV2 {
    const known = observed.find((o) => sameOwnedJson(o.target, target));
    if (known) return known.view;
    let resolve!: (reply: RecordingWireObservationReply) => void;
    const result = new Promise<RecordingWireObservationReply>((done) => {
      resolve = done;
    });
    const owned = freezeHistory(
      JSON.parse(JSON.stringify(target)),
    ) as RecordingWireObservationTarget;
    const o: Observed = {
      target: owned,
      view: Object.freeze({ target: owned, result }),
      query: "pending",
      inFlight: 0,
    };
    observed.push(o);
    let targetToken!: Parameters<WireDeliveryLedger["beginObservation"]>[0];
    let queries = 0;
    const lose = () => {
      o.query = "transportLost";
      publish();
    };
    function newQuery() {
      if (queries > OBSERVATION_RETRIES) return lose();
      const request = freezeHistory({
        version: 1,
        kind: "recordingWireObservationRequest",
        scope,
        observationId: newId("ob"),
        target: owned,
      });
      const begun = ledger.beginObservation(targetToken, request);
      if (!begun.ok) {
        // Another target's attempt is in flight: wait for it.
        if (begun.reason === "busy")
          return later(newQuery, OBSERVATION_REPEAT_MS);
        return lose();
      }
      queries++;
      const watched = local.watchObservationQuery(begun.value.query);
      if (!watched.ok) return lose();
      watched.value.completion.then((reply) => {
        o.query = "terminal";
        publish();
        resolve(reply as RecordingWireObservationReply);
      });
      void attempt(begun.value.query, begun.value.attempt, request);
    }
    async function attempt(
      query: Parameters<WireDeliveryLedger["repeatObservation"]>[0],
      token: Parameters<WireDeliveryLedger["acceptObservation"]>[0],
      request: unknown,
    ) {
      o.inFlight++;
      publish();
      const sent = await send("recording_observation", { request });
      o.inFlight--;
      if (!sent.returned) {
        ledger.abandonObservationAttempt(token);
        publish();
        return later(newQuery, OBSERVATION_REPEAT_MS);
      }
      const accepted = ledger.acceptObservation(token, sent.reply);
      publish();
      if (!accepted.ok) return lose();
      if (accepted.value.queryTerminalStored) return;
      const repeat = () => {
        const next = ledger.repeatObservation(query);
        if (next.ok) return void attempt(query, next.value, request);
        if (next.reason === "busy") return later(repeat, OBSERVATION_REPEAT_MS);
        lose();
      };
      later(repeat, OBSERVATION_REPEAT_MS);
    }
    // A cached frame may show the accepted admission before its own reply
    // is stored: the query waits for the stored reply (cached frames are
    // never evidence for the ledger).
    const bind = (): boolean => {
      const source = targetSource(owned);
      const bound = source ? ledger.bindObservationTarget(source) : undefined;
      if (!bound?.ok) return false;
      targetToken = bound.value;
      newQuery();
      return true;
    };
    if (!bind()) unbound.push(bind);
    publish();
    return o.view;
  }

  // ---- subscription ----
  function currentRef(): string | null {
    return receiver.current().generation?.subscriptionRef ?? null;
  }
  function stop(reason: PortSignal = "stopped") {
    subscription = "stopped";
    publish();
    signal(reason);
  }
  async function attach(): Promise<void> {
    if (disposed) return;
    const request = {
      version: 1,
      kind: "recordingWireAttachRequest",
      scope,
      attachId: newId("at"),
      afterRevision: receiver.current().highwater,
    };
    const begun = receiver.beginAttach(request);
    if (!begun.ok) return stop();
    const g = begun.value;
    generation = g;
    subscription = "attaching";
    publish();
    const sent = await send("recording_attach", { request });
    if (generation !== g) return;
    if (!sent.returned) {
      if (ownerClosed || authorizationLost) {
        subscription = "stopped";
        return publish();
      }
      return stop();
    }
    const received = receiver.acceptAttach(g, sent.reply);
    const terminal = receiver.attachTerminal(g);
    const outcome =
      terminal.ok && terminal.value.kind === "terminal"
        ? terminal.value.reply.outcome
        : null;
    if (!received.ok || !outcome) return stop();
    if (outcome.kind === "rejected") {
      if (outcome.error === "unauthorized" || outcome.error === "forbidden")
        loseAuthorization("refused");
      else if (outcome.error === "ownerUnavailable") closeOwner("hostClosed");
      return stop();
    }
    subscription = disposed ? "stopped" : "attached";
    resyncRequired = receiver.current().status === "resyncRequired";
    publish();
    if (resyncRequired) resync();
  }
  function reattach(): boolean {
    if (disposed || reattachLeft < 1) return false;
    reattachLeft--;
    void attach();
    return true;
  }
  function resync() {
    resyncRequired = true;
    publish();
    if (!reattach()) stop();
  }
  function onEvent(event: RecordingEventPayload) {
    if (disposed || event.ownerEpoch !== scope.ownerEpoch) return;
    const g = generation;
    if (!g) return;
    const phase = receiver.current().generation?.phase;
    const ref = currentRef();
    if (event.kind === "ended") {
      if (ref === null || event.subscriptionRef !== ref) return;
      receiver.retire(g);
      generation = undefined;
      subscription = "ended";
      ended = event.reason;
      publish();
      if (event.reason === "unauthorized" || event.reason === "forbidden") {
        loseAuthorization("ended");
        subscription = "stopped";
        return publish();
      }
      if (event.reason === "closed") {
        closeOwner("hostClosed");
        subscription = "stopped";
        return publish();
      }
      if (!reattach()) stop();
      return;
    }
    if (seq !== null && event.seq !== seq) return;
    if (phase === "attached" && event.subscriptionRef !== ref) return;
    if (phase !== "attached" && phase !== "attaching") return;
    const state = event.state as { snapshot?: { scope?: unknown } } | null;
    const control = event.control as { scope?: unknown; reason?: unknown };
    if (state !== null && !sameOwnedJson(state?.snapshot?.scope, scope)) return;
    if (control !== null && !sameOwnedJson(control?.scope, scope)) return;
    let applied = false;
    if (state !== null) {
      const r = receiver.acceptState(g, state);
      applied ||= r.ok && r.value.disposition === "applied";
    }
    if (control !== null) {
      const r = receiver.acceptControlFrame(g, control);
      if (r.ok && r.value.disposition !== "resyncRequired") {
        if (control.reason === "ownerClosed") closeOwner("controlFrame");
        if (control.reason === "authorizationLost")
          loseAuthorization("controlFrame");
      }
    }
    // A successful re-attach that delivers again earns its retry back.
    if (applied && subscription === "attached" && reattachLeft < REATTACH_LIMIT)
      reattachLeft = REATTACH_LIMIT;
    if (receiver.current().status === "resyncRequired") return resync();
    if (receiver.current().status === "stopped") return stop();
    publish();
  }

  function detach() {
    const g = generation,
      ref = currentRef();
    if (!g || !ref || subscription !== "attached") return;
    const request = {
      version: 1,
      kind: "recordingWireControlRequest",
      scope,
      controlId: newId("ct"),
      subscriptionRef: ref,
      action: "detach",
    };
    const begun = receiver.beginControl(g, request);
    if (!begun.ok) return;
    void send("recording_control", { request }).then((sent) => {
      if (sent.returned) receiver.acceptControlReply(begun.value, sent.reply);
      publish();
    });
  }

  const port = defineAsyncRecordingPortV2({
    scope,
    access,
    prepareLease: prepareLease as never,
    admit: (request) =>
      original(
        request,
        request,
        (token) => deliverOriginal(token, "recording_admission", { request }),
        true,
      ),
    inspectAdmission: (request) =>
      original(
        request,
        request,
        (token) =>
          deliverOriginal(token, "recording_admission_inspection", {
            request,
          }),
        true,
      ),
    inspectCall: inspectCall as never,
    requestCancel: (request) =>
      original(request, request, (token) =>
        deliverOriginal(token, "recording_cancel", { request }),
      ),
    observe,
    current: () => published,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });

  return Object.freeze({
    port,
    async start() {
      if (disposed || subscription !== "idle") return;
      try {
        const off = await listenRecording(listen, onEvent);
        if (disposed) off();
        else unlisten = off;
      } catch {
        return stop();
      }
      await attach();
    },
    dispose() {
      if (disposed) return;
      detach();
      disposed = true;
      generation = undefined;
      if (subscription !== "ended") subscription = "stopped";
      unlisten?.();
      unlisten = undefined;
      publish();
    },
  });
}
