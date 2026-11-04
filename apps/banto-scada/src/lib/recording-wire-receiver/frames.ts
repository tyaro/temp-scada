import {
  parseRecordingWireStateFrame,
  parseRecordingWireControlFrame,
  recordingWireFrameMatchesSubscription,
} from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import {
  Core,
  received,
  reject,
  requireReceiver,
  type Generation,
} from "./core";
import { project, provisional, applyControl } from "./snapshots";
import type { ReceiveResult } from "./types";
function provisionalRef(g: Generation, ref: string): void {
  requireReceiver(!g.provisionalRef || g.provisionalRef === ref);
}
export function acceptState(
  c: Core,
  token: unknown,
  input: unknown,
): ReceiveResult {
  const g = c.generation(token);
  if (!g) return reject("foreignToken");
  if (!c.isLive(g)) return received("ignoredRetired");
  try {
    const f = parseRecordingWireStateFrame(input);
    requireReceiver(c.matches(f.snapshot.scope));
    if (g.phase === "attaching") {
      provisionalRef(g, f.subscriptionRef);
      const duplicate =
        g.provisional.has(f.snapshot.revision) ||
        c.history.has(f.snapshot.revision);
      provisional(c, g, f.snapshot);
      g.provisionalRef = f.subscriptionRef;
      return received(duplicate ? "duplicate" : "applied");
    }
    requireReceiver(recordingWireFrameMatchesSubscription(f, g.reply));
    const duplicate = c.history.has(f.snapshot.revision);
    project(c, [f.snapshot]);
    return received(duplicate ? "duplicate" : "applied");
  } catch (error) {
    return c.failure(error);
  }
}
export function acceptControlFrame(
  c: Core,
  token: unknown,
  input: unknown,
): ReceiveResult {
  const g = c.generation(token);
  if (!g) return reject("foreignToken");
  if (!c.isLive(g)) return received("ignoredRetired");
  try {
    const f = parseRecordingWireControlFrame(input);
    requireReceiver(c.matches(f.scope));
    if (g.phase === "attaching") provisionalRef(g, f.subscriptionRef);
    else requireReceiver(recordingWireFrameMatchesSubscription(f, g.reply));
    if (g.control) {
      if (sameOwnedJson(g.control, f)) return received("duplicate");
      c.resync = true;
      c.retire(g);
      return received("resyncRequired");
    }
    // One closed-schema control record was reserved with this generation.
    g.control = f;
    g.provisionalRef ??= f.subscriptionRef;
    if (g.phase === "attaching") g.controlPending = true;
    else applyControl(c, g, f);
    return received("applied");
  } catch (error) {
    return c.failure(error);
  }
}
