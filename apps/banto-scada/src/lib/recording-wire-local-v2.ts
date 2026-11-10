/**
 * Same-realm delivery only. A settled Promise proves a stored reply, not transport quiescence.
 * `mode: "native"` is the desktop port's delivery (product-owner design C5 §7.2, §8.1-11);
 * the default `testOnly` is unchanged. The mode changes no behavior: it names the user.
 */
import { sameOwnedJson } from "./json-equality";
import { isRecordingWireDeliveryLedger } from "./recording-wire-delivery-ledger";
import { isRecordingWireReceiver } from "./recording-wire-receiver";
import type {
  WireDeliveryLedger,
  OriginalCallToken,
  OriginalRequest,
  OriginalReply,
  InspectionAttemptToken,
  ObservationAttemptToken,
  ObservationQueryToken,
} from "./recording-wire-delivery-ledger";
import type {
  WireReceiver,
  AttachGeneration,
  ControlCall,
  RecordingWireDisplay,
} from "./recording-wire-receiver";
import type {
  RecordingWireScope,
  RecordingWireCallInspectionRequest,
  RecordingWireCallInspectionReply,
  RecordingWireObservationRequest,
  RecordingWireObservationReply,
  RecordingWireAttachRequest,
  RecordingWireAttachReply,
  RecordingWireControlRequest,
  RecordingWireControlReply,
} from "./recording-wire-contract";

export type LocalV2Reason =
  | "busy"
  | "foreignToken"
  | "capacity"
  | "invalidSource"
  | "scopeMismatch"
  | "sourceFailure";
export type LocalV2Result<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: LocalV2Reason }
>;
export type LocalV2Handle<Q, R> = Readonly<{
  scope: RecordingWireScope;
  request: Q;
  completion: Promise<R>;
}>;
export type LocalV2Mode = "testOnly" | "native";
export type LocalV2Options = Readonly<{
  maxHandles?: number;
  mode?: LocalV2Mode;
}>;
export type LocalV2State = Readonly<{
  version: 2;
  mode: LocalV2Mode;
  scope: RecordingWireScope;
  display: RecordingWireDisplay;
  usage: Readonly<{
    handles: number;
    pending: number;
    delivered: number;
    maxHandles: number;
  }>;
}>;
export interface RecordingWireLocalV2 {
  readonly version: 2;
  readonly mode: LocalV2Mode;
  readonly scope: RecordingWireScope;
  watchOriginal(
    token: OriginalCallToken,
  ): LocalV2Result<LocalV2Handle<OriginalRequest, OriginalReply>>;
  watchInspectionAttempt(
    token: InspectionAttemptToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireCallInspectionRequest,
      RecordingWireCallInspectionReply
    >
  >;
  watchObservationAttempt(
    token: ObservationAttemptToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireObservationRequest,
      RecordingWireObservationReply
    >
  >;
  watchObservationQuery(
    token: ObservationQueryToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireObservationRequest,
      RecordingWireObservationReply
    >
  >;
  watchAttach(
    token: AttachGeneration,
  ): LocalV2Result<
    LocalV2Handle<RecordingWireAttachRequest, RecordingWireAttachReply>
  >;
  watchControl(
    token: ControlCall,
  ): LocalV2Result<
    LocalV2Handle<RecordingWireControlRequest, RecordingWireControlReply>
  >;
  pump(): LocalV2Result<
    Readonly<{ delivered: number; pending: number; sourceFailures: number }>
  >;
  current(): LocalV2State;
}

const localSources = new WeakMap<
  object,
  Readonly<{ ledger: WireDeliveryLedger; receiver: WireReceiver }>
>();
export function isRecordingWireLocalV2For(
  value: unknown,
  ledger: WireDeliveryLedger,
  receiver: WireReceiver,
): value is RecordingWireLocalV2 {
  if (!value || typeof value !== "object") return false;
  const source = localSources.get(value);
  return source?.ledger === ledger && source.receiver === receiver;
}

type Route =
  | "original"
  | "inspectionAttempt"
  | "observationAttempt"
  | "observationQuery"
  | "attach"
  | "control";
type Snapshot<Q, R> = Readonly<{ request: Q; reply: R | null }>;
type SourceRead<Q, R> =
  | Readonly<{ ok: true; value: Snapshot<Q, R> }>
  | Readonly<{ ok: false; reason: string }>;
type AnyRecord = {
  route: Route;
  request: unknown;
  handle: LocalV2Handle<unknown, unknown>;
  read: () => SourceRead<unknown, unknown>;
  resolve: ((value: unknown) => void) | null;
  delivered: boolean;
};
const yes = <T>(value: T): LocalV2Result<T> =>
  Object.freeze({ ok: true, value });
const no = (reason: LocalV2Reason): LocalV2Result<never> =>
  Object.freeze({ ok: false, reason });
function reason(value: string): LocalV2Reason {
  return value === "busy" || value === "foreignToken" ? value : "sourceFailure";
}
function parseOptions(input: unknown): {
  maxHandles: number;
  mode: LocalV2Mode;
} {
  if (input === undefined) return { maxHandles: 256, mode: "testOnly" };
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error("invalid options");
  const keys = Reflect.ownKeys(input);
  if (keys.length < 1 || keys.some((k) => k !== "maxHandles" && k !== "mode"))
    throw Error("invalid options");
  const value = (key: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d) return undefined;
    if (!d.enumerable || !("value" in d)) throw Error("invalid options");
    return d.value;
  };
  const maxHandles = value("maxHandles") ?? 256,
    mode = value("mode") ?? "testOnly";
  if (
    !Number.isSafeInteger(maxHandles) ||
    (maxHandles as number) < 0 ||
    (maxHandles as number) > 256 ||
    (mode !== "testOnly" && mode !== "native")
  )
    throw Error("invalid options");
  return { maxHandles: maxHandles as number, mode };
}

export function createRecordingWireLocalV2(
  ledger: WireDeliveryLedger,
  receiver: WireReceiver,
  options?: LocalV2Options,
): Readonly<
  | { ok: true; value: RecordingWireLocalV2 }
  | { ok: false; reason: "invalidOptions" | "invalidSource" | "scopeMismatch" }
> {
  let maxHandles: number, mode: LocalV2Mode;
  try {
    ({ maxHandles, mode } = parseOptions(options));
  } catch {
    return Object.freeze({ ok: false, reason: "invalidOptions" });
  }
  if (
    !isRecordingWireDeliveryLedger(ledger) ||
    !isRecordingWireReceiver(receiver)
  )
    return Object.freeze({ ok: false, reason: "invalidSource" });
  let scope: RecordingWireScope, display: RecordingWireDisplay;
  try {
    scope = ledger.current().scope;
    display = receiver.currentDisplay();
    if (!scope || !display?.scope) throw Error("invalid source");
    if (!sameOwnedJson(scope, display.scope))
      return Object.freeze({ ok: false, reason: "scopeMismatch" });
  } catch {
    return Object.freeze({ ok: false, reason: "invalidSource" });
  }
  const records = new Map<object, AnyRecord>();
  let busy = false;
  let dirty = false;
  let published = state();
  function state(): LocalV2State {
    let pending = 0;
    for (const record of records.values()) if (!record.delivered) pending++;
    return Object.freeze({
      version: 2 as const,
      mode,
      scope,
      display,
      usage: Object.freeze({
        handles: records.size,
        pending,
        delivered: records.size - pending,
        maxHandles,
      }),
    });
  }
  function guard<T>(fn: () => T, nested: () => T): T {
    if (busy) return nested();
    busy = true;
    try {
      return fn();
    } finally {
      if (dirty) {
        published = state();
        dirty = false;
      }
      busy = false;
    }
  }
  function deliver(record: AnyRecord, reply: unknown): boolean {
    if (record.delivered || reply === null) return false;
    record.delivered = true;
    dirty = true;
    const resolve = record.resolve;
    record.resolve = null;
    resolve?.(reply);
    return true;
  }
  function watch<Q, R>(
    route: Route,
    token: unknown,
    read: () => SourceRead<Q, R>,
  ): LocalV2Result<LocalV2Handle<Q, R>> {
    return guard(
      () => {
        if (!token || typeof token !== "object") return no("foreignToken");
        const known = records.get(token);
        if (known)
          return known.route === route
            ? yes(known.handle as LocalV2Handle<Q, R>)
            : no("foreignToken");
        let source: SourceRead<Q, R>;
        try {
          source = read();
        } catch {
          return no("sourceFailure");
        }
        if (!source.ok) return no(reason(source.reason));
        if (records.size >= maxHandles) return no("capacity");
        let resolve!: (value: R) => void;
        const completion = Object.freeze(
          new Promise<R>((done) => {
            resolve = done;
          }),
        );
        const handle = Object.freeze({
          scope,
          request: source.value.request,
          completion,
        });
        const record: AnyRecord = {
          route,
          request: source.value.request,
          handle,
          read: read as () => SourceRead<unknown, unknown>,
          resolve: resolve as (value: unknown) => void,
          delivered: false,
        };
        records.set(token, record);
        dirty = true;
        deliver(record, source.value.reply);
        return yes(handle);
      },
      () => no("busy"),
    );
  }
  function readOriginal(
    token: OriginalCallToken,
  ): SourceRead<OriginalRequest, OriginalReply> {
    const r = ledger.original(token);
    return r.ok
      ? {
          ok: true,
          value: { request: r.value.request, reply: r.value.terminal },
        }
      : r;
  }
  function readInspectionAttempt(
    token: InspectionAttemptToken,
  ): SourceRead<
    RecordingWireCallInspectionRequest,
    RecordingWireCallInspectionReply
  > {
    const r = ledger.attempt(token);
    return r.ok
      ? { ok: true, value: { request: r.value.request, reply: r.value.reply } }
      : r;
  }
  function readObservationAttempt(
    token: ObservationAttemptToken,
  ): SourceRead<
    RecordingWireObservationRequest,
    RecordingWireObservationReply
  > {
    const r = ledger.observationAttempt(token);
    return r.ok
      ? { ok: true, value: { request: r.value.request, reply: r.value.reply } }
      : r;
  }
  function readObservationQuery(
    token: ObservationQueryToken,
  ): SourceRead<
    RecordingWireObservationRequest,
    RecordingWireObservationReply
  > {
    const r = ledger.observation(token);
    return r.ok
      ? {
          ok: true,
          value: { request: r.value.request, reply: r.value.terminal },
        }
      : r;
  }
  function readAttach(
    token: AttachGeneration,
  ): SourceRead<RecordingWireAttachRequest, RecordingWireAttachReply> {
    const r = receiver.attachTerminal(token);
    return r.ok
      ? {
          ok: true,
          value: {
            request: r.value.request,
            reply: r.value.kind === "terminal" ? r.value.reply : null,
          },
        }
      : r;
  }
  function readControl(
    token: ControlCall,
  ): SourceRead<RecordingWireControlRequest, RecordingWireControlReply> {
    const r = receiver.controlTerminal(token);
    return r.ok
      ? {
          ok: true,
          value: {
            request: r.value.request,
            reply: r.value.kind === "terminal" ? r.value.reply : null,
          },
        }
      : r;
  }
  const adapter: RecordingWireLocalV2 = Object.freeze({
    version: 2,
    mode,
    scope,
    watchOriginal: (t: OriginalCallToken) =>
      watch("original", t, () => readOriginal(t)),
    watchInspectionAttempt: (t: InspectionAttemptToken) =>
      watch("inspectionAttempt", t, () => readInspectionAttempt(t)),
    watchObservationAttempt: (t: ObservationAttemptToken) =>
      watch("observationAttempt", t, () => readObservationAttempt(t)),
    watchObservationQuery: (t: ObservationQueryToken) =>
      watch("observationQuery", t, () => readObservationQuery(t)),
    watchAttach: (t: AttachGeneration) =>
      watch("attach", t, () => readAttach(t)),
    watchControl: (t: ControlCall) => watch("control", t, () => readControl(t)),
    pump: () =>
      guard(
        () => {
          let delivered = 0,
            sourceFailures = 0;
          for (const record of records.values()) {
            if (record.delivered) continue;
            let source: SourceRead<unknown, unknown>;
            try {
              source = record.read();
              if (!source.ok) {
                if (source.reason !== "busy") sourceFailures++;
                continue;
              }
              if (!sameOwnedJson(source.value.request, record.request)) {
                sourceFailures++;
                continue;
              }
              if (deliver(record, source.value.reply)) delivered++;
            } catch {
              sourceFailures++;
            }
          }
          try {
            const next = receiver.currentDisplay();
            if (sameOwnedJson(next.scope, scope)) {
              if (next !== display) {
                display = next;
                dirty = true;
              }
            } else sourceFailures++;
          } catch {
            sourceFailures++;
          }
          const pending = [...records.values()].filter(
            (r) => !r.delivered,
          ).length;
          return yes(Object.freeze({ delivered, pending, sourceFailures }));
        },
        () => no("busy"),
      ),
    current: () => published,
  });
  localSources.set(adapter, Object.freeze({ ledger, receiver }));
  return Object.freeze({ ok: true, value: adapter });
}
