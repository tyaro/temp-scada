/** Internal projection of already owned receiver state. No external source or callback. */
import type {
  RecordingWireDisplay,
  ReceiverState,
  StoredTerminal,
} from "./types";
export function display(state: ReceiverState): RecordingWireDisplay {
  // Every nested reference is already owned/frozen by the committed receiver view.
  return Object.freeze({
    scope: state.scope,
    transportConnected: state.connected,
    receiverStatus: state.status,
    receiverStoppedReason: state.stoppedReason,
    generation: state.generation,
    ownerClosed: state.ownerClosed,
    nativeRecoveryRequired: state.ownerBlocked,
    authorizationLost: state.authorizationLost,
    highwater: state.highwater,
    snapshotRelation:
      state.latest === null
        ? "none"
        : state.connected &&
            state.status === "ready" &&
            state.generation?.phase === "attached" &&
            !state.ownerClosed &&
            !state.authorizationLost
          ? "currentSubscription"
          : "lastKnown",
    snapshot: state.latest,
    usage: state.usage,
  });
}
/** Ephemeral wrapper only; no second ledger, body copy, consumption or credit refund. */
export function terminal<Q, R>(record: {
  request: Q;
  reply?: R;
}): StoredTerminal<Q, R> {
  return record.reply === undefined
    ? Object.freeze({ kind: "pending", request: record.request })
    : Object.freeze({
        kind: "terminal",
        request: record.request,
        reply: record.reply,
      });
}
