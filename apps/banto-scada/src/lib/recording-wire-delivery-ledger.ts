/** Standalone pure client ledger. Registration is never dispatch or native authority. */
import { parseRecordingWireAttachRequest } from "./recording-wire-contract";
import {
  Core,
  parseLimits,
  yes,
  no,
  rejected,
} from "./recording-wire-delivery-ledger/core";
import * as original from "./recording-wire-delivery-ledger/original";
import * as inspection from "./recording-wire-delivery-ledger/inspection";
import * as observation from "./recording-wire-delivery-ledger/observation";
import type {
  DeliveryLimits,
  LedgerResult,
  WireDeliveryLedger,
  ObservationAcceptResult,
} from "./recording-wire-delivery-ledger/types";
export type * from "./recording-wire-delivery-ledger/types";
const ledgerInstances = new WeakSet<object>();
export function isRecordingWireDeliveryLedger(
  value: unknown,
): value is WireDeliveryLedger {
  return (
    typeof value === "object" && value !== null && ledgerInstances.has(value)
  );
}
export function createRecordingWireDeliveryLedger(
  scope: unknown,
  options?: Partial<DeliveryLimits>,
): Readonly<
  | { ok: true; value: WireDeliveryLedger }
  | { ok: false; reason: "invalidScope" | "invalidOptions" }
> {
  let limits;
  try {
    limits = parseLimits(options);
  } catch {
    return Object.freeze({ ok: false, reason: "invalidOptions" });
  }
  let c: Core;
  try {
    const q = parseRecordingWireAttachRequest({
      version: 1,
      kind: "recordingWireAttachRequest",
      scope,
      attachId: "validation",
      afterRevision: null,
    });
    c = new Core(q.scope, limits);
  } catch {
    return Object.freeze({ ok: false, reason: "invalidScope" });
  }
  let busy = false,
    published = c.view();
  function guard<T>(fn: () => T, whenBusy: () => T): T {
    if (busy) return whenBusy();
    busy = true;
    try {
      return fn();
    } finally {
      try {
        if (c.dirty) {
          const next = c.view();
          published = next;
          c.dirty = false;
        }
      } finally {
        busy = false;
      }
    }
  }
  const read = <T>(fn: () => LedgerResult<T>) => guard(fn, () => no("busy"));
  const observationBusy = (): ObservationAcceptResult =>
    Object.freeze({
      ok: false,
      reason: "busy",
      attemptStored: false,
      queryTerminalStored: false,
      targetResultStored: false,
    });
  const receiver: WireDeliveryLedger = Object.freeze<WireDeliveryLedger>({
    beginOriginal: (q) => read(() => original.begin(c, q)),
    acceptOriginal: (t, r) =>
      guard(
        () => original.accept(c, t, r),
        () => rejected("busy"),
      ),
    original: (t) =>
      read(() => {
        const r = c.lookup(c.originalTokens, t);
        return r
          ? yes(
              Object.freeze({
                request: r.request,
                terminal: r.terminal,
                learnedBy: r.learnedBy,
              }),
            )
          : no("foreignToken");
      }),
    beginInspection: (t, q) => read(() => inspection.begin(c, t, q)),
    repeatInspection: (t) => read(() => inspection.repeat(c, t)),
    acceptInspection: (t, r) =>
      guard(
        () => inspection.accept(c, t, r),
        () => rejected("busy"),
      ),
    inspection: (t) =>
      read(() => {
        const q = c.lookup(c.queryTokens, t);
        return q
          ? yes(
              Object.freeze({
                request: q.request,
                original: q.original.token,
                latestAttempt: q.latest.token,
                terminal: q.terminal,
              }),
            )
          : no("foreignToken");
      }),
    attempt: (t) =>
      read(() => {
        const a = c.lookup(c.attemptTokens, t);
        return a
          ? yes(
              Object.freeze({
                request: a.query.request,
                reply:
                  a.outcome === null
                    ? null
                    : Object.freeze({
                        version: 1 as const,
                        kind: "recordingWireCallInspectionReply" as const,
                        request: a.query.request,
                        outcome: a.outcome,
                      }),
              }),
            )
          : no("foreignToken");
      }),
    bindObservationTarget: (t) => read(() => observation.bind(c, t)),
    observationTarget: (t) => read(() => observation.target(c, t)),
    beginObservation: (t, q) => read(() => observation.begin(c, t, q)),
    repeatObservation: (t) => read(() => observation.repeat(c, t)),
    acceptObservation: (t, r) =>
      guard(() => observation.accept(c, t, r), observationBusy),
    observation: (t) => read(() => observation.query(c, t)),
    observationAttempt: (t) => read(() => observation.attempt(c, t)),
    current: () => published,
    retire: () =>
      read(() => {
        if (!c.retired) {
          c.retired = true;
          c.dirty = true;
        }
        return yes(null);
      }),
    dispose: () =>
      read(() => {
        if (!c.disposed) {
          c.disposed = true;
          c.dirty = true;
        }
        return yes(null);
      }),
  });
  ledgerInstances.add(receiver);
  return Object.freeze({ ok: true, value: receiver });
}
