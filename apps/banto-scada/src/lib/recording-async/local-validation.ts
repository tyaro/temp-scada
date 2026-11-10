import { ownHistoryJson, freezeHistory } from "../history/owned-json";
import { sameOwnedJson } from "../json-equality";
import {
  parseRecordingWireObservationRequest,
  parseRecordingWireStateFrame,
  type RecordingWireScope,
} from "../recording-wire-contract";
import { data } from "../recording-operations/view";
import type { PortStateV2, PortTransportEnd } from "./port";
export function fields(v: unknown, keys: readonly string[]): void {
  if (!v || typeof v !== "object" || Reflect.ownKeys(v).length !== keys.length)
    throw Error("invalid local metadata");
  keys.forEach((k) => data(v, k));
}
export function id(v: unknown): asserts v is string {
  if (
    typeof v !== "string" ||
    v.length > 64 ||
    /[^A-Za-z0-9._:-]/.test(v) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)
  )
    throw Error("invalid ID");
}
const refusalKinds = new Set([
  "invalidRequest",
  "unauthorized",
  "forbidden",
  "authUnavailable",
  "invalidInput",
  "protocolViolation",
  "capacity",
  "busy",
  "expired",
  "closed",
]);
function short(v: unknown): asserts v is string {
  if (typeof v !== "string" || v.length > 256 || /[\u0000-\u001f]/.test(v))
    throw Error("invalid text");
}
/** One physical call end. Closed kinds only; host text is bounded and never interpreted. */
export function parseTransportEnd(input: unknown): PortTransportEnd {
  const v = ownHistoryJson(input, 4096, 64, "localMetadata") as any;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("end");
  if (v.kind === "returned" || v.kind === "failed") fields(v, ["kind"]);
  else if (v.kind === "staleSeq") {
    fields(v, ["kind", "seq"]);
    if (!Number.isSafeInteger(v.seq) || v.seq < 0) throw Error("seq");
  } else if (v.kind === "refused") {
    fields(v, ["kind", "refusal"]);
    const r = v.refusal;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("refusal");
    if (r.kind === "recordingUnavailable") {
      fields(r, ["kind", "reason"]);
      short(r.reason);
    } else if (r.kind === "phase") {
      fields(r, ["kind", "phase"]);
      short(r.phase);
    } else {
      fields(r, ["kind"]);
      if (!refusalKinds.has(r.kind)) throw Error("refusal");
    }
  } else throw Error("end");
  return freezeHistory(v);
}
const subscriptions = ["idle", "attaching", "attached", "ended", "stopped"];
const ownerClosed = ["controlFrame", "hostClosed", "slotEmpty"];
const authorizationLost = ["controlFrame", "ended", "refused", "seqChanged"];
const receiverStatus = ["ready", "awaitingAttach", "resyncRequired", "stopped"];
const relations = ["none", "currentSubscription", "lastKnown"];
function bool(v: unknown): asserts v is boolean {
  if (typeof v !== "boolean") throw Error("invalid flag");
}
function count(v: unknown) {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error("count");
}
function usage(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("usage");
  for (const k of Reflect.ownKeys(v)) count(data(v, k as string));
}
/** Port state v2. The cached snapshot is validated as a wire state frame body. */
export function parsePortState(
  input: unknown,
  scope: RecordingWireScope,
): PortStateV2 {
  const v = ownHistoryJson(input, 8 * 1024 * 1024, 250_000, "wireReply") as any;
  fields(v, [
    "version",
    "scope",
    "access",
    "seq",
    "display",
    "subscription",
    "ended",
    "ownerClosed",
    "authorizationLost",
    "resyncRequired",
    "nativeRecoveryRequired",
    "observations",
    "usage",
  ]);
  if (v.version !== 2 || !sameOwnedJson(v.scope, scope))
    throw Error("foreign state");
  if (v.access !== "mutation" && v.access !== "read") throw Error("access");
  if (v.seq !== null) count(v.seq);
  if (!subscriptions.includes(v.subscription)) throw Error("subscription");
  if (v.ended !== null) short(v.ended);
  if (v.ownerClosed !== null && !ownerClosed.includes(v.ownerClosed))
    throw Error("ownerClosed");
  if (
    v.authorizationLost !== null &&
    !authorizationLost.includes(v.authorizationLost)
  )
    throw Error("authorizationLost");
  bool(v.resyncRequired);
  bool(v.nativeRecoveryRequired);
  const d = v.display;
  fields(d, [
    "scope",
    "transportConnected",
    "receiverStatus",
    "receiverStoppedReason",
    "generation",
    "ownerClosed",
    "nativeRecoveryRequired",
    "authorizationLost",
    "highwater",
    "snapshotRelation",
    "snapshot",
    "usage",
  ]);
  if (!sameOwnedJson(d.scope, scope)) throw Error("foreign display");
  bool(d.transportConnected);
  bool(d.ownerClosed);
  bool(d.nativeRecoveryRequired);
  bool(d.authorizationLost);
  if (!receiverStatus.includes(d.receiverStatus)) throw Error("receiver");
  if (d.receiverStoppedReason !== null) short(d.receiverStoppedReason);
  if (d.highwater !== null) count(d.highwater);
  if (!relations.includes(d.snapshotRelation)) throw Error("relation");
  if ((d.snapshotRelation === "none") !== (d.snapshot === null))
    throw Error("snapshot relation");
  if (d.snapshot !== null) {
    parseRecordingWireStateFrame({
      version: 1,
      kind: "recordingWireStateFrame",
      subscriptionRef: "display",
      snapshot: d.snapshot,
    });
    if (!sameOwnedJson(d.snapshot.scope, scope))
      throw Error("foreign snapshot");
  }
  usage(d.usage);
  if (!Array.isArray(v.observations) || v.observations.length > 4096)
    throw Error("observations");
  for (const o of v.observations) {
    fields(o, ["target", "query", "attemptsInFlight"]);
    parseRecordingWireObservationRequest({
      version: 1,
      kind: "recordingWireObservationRequest",
      scope,
      observationId: "validation",
      target: o.target,
    });
    if (!["pending", "terminal", "transportLost"].includes(o.query))
      throw Error("query");
    count(o.attemptsInFlight);
  }
  fields(v.usage, ["ledger", "receiver"]);
  usage(v.usage.ledger);
  usage(v.usage.receiver);
  return freezeHistory(v);
}
/** Require a genuine same-realm Promise, not a user-defined thenable. */
export function onPromise(
  input: unknown,
  yes: (v: unknown) => void,
  no: () => void,
): void {
  if (!(input instanceof Promise)) throw Error("invalid Promise");
  Promise.prototype.then.call(input, yes, no);
}
