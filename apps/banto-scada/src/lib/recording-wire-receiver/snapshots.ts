import type {
  RecordingWireOwnerSnapshot as Snapshot,
  RecordingWireControlFrame,
} from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import { Core, requireReceiver, measured, type Generation } from "./core";
/** Retention is separate from trust: provisional records do not become formal evidence. */
function retainedPlan(c: Core, values: Snapshot[]) {
  const added = new Map<Snapshot, number>(),
    canonical = new Map<Snapshot, Snapshot>();
  let bytes = 0;
  for (const v of values) {
    const known = [...c.retained.keys(), ...added.keys()].find(
      (s) => s.revision === v.revision && sameOwnedJson(s, v),
    );
    if (known) {
      canonical.set(v, known);
      continue;
    }
    const cost = measured(v, "snapshot");
    bytes += cost;
    requireReceiver(
      c.retained.size + added.size + 1 <= c.limits.snapshotRevisions &&
        c.snapshotBytes + bytes <= c.limits.snapshotBytes,
      "capacity",
    );
    added.set(v, cost);
    canonical.set(v, v);
  }
  return { added, canonical, bytes };
}
function commitRetention(c: Core, p: ReturnType<typeof retainedPlan>) {
  for (const [v, cost] of p.added) c.retained.set(v, cost);
  c.snapshotBytes += p.bytes;
}
export function provisional(c: Core, g: Generation, value: Snapshot): void {
  const known =
    g.provisional.get(value.revision) ?? c.history.get(value.revision);
  if (known) requireReceiver(sameOwnedJson(known, value));
  const plan = retainedPlan(c, [value]);
  commitRetention(c, plan);
  const canonical = plan.canonical.get(value)!;
  g.provisional.set(value.revision, canonical);
  g.stateSlot = canonical;
}
export function project(c: Core, values: Snapshot[]): void {
  const ordered = new Map<number, Snapshot>();
  for (const s of values) {
    const known = ordered.get(s.revision) ?? c.history.get(s.revision);
    if (known) requireReceiver(sameOwnedJson(known, s));
    ordered.set(s.revision, s);
  }
  let h = c.highwater,
    latest = c.latest,
    closed = c.ownerClosed,
    blocked = c.ownerBlocked;
  for (const s of [...ordered.values()].sort(
    (a, b) => a.revision - b.revision,
  )) {
    if (c.history.has(s.revision)) continue;
    requireReceiver(h === null || s.revision > h, "resyncRequired");
    requireReceiver((!closed || s.closed) && (!blocked || s.ownerBlocked));
    h = s.revision;
    latest = s;
    closed ||= s.closed;
    blocked ||= s.ownerBlocked;
  }
  const plan = retainedPlan(c, [...ordered.values()]);
  commitRetention(c, plan);
  for (const [rev, s] of ordered) c.history.set(rev, plan.canonical.get(s)!);
  c.highwater = h;
  c.latest = latest ? (plan.canonical.get(latest) ?? latest) : null;
  c.ownerClosed = closed;
  c.ownerBlocked = blocked;
}
export function applyControl(
  c: Core,
  g: Generation,
  frame: RecordingWireControlFrame,
): void {
  if (frame.reason === "ownerClosed") c.ownerClosed = true;
  else if (frame.reason === "authorizationLost") c.authorizationLost = true;
  else c.resync = true;
  c.retire(g);
  g.controlPending = false;
}
