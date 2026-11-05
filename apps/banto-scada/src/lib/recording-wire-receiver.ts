/** Standalone pure receiver. Never wired into the App or used as dispatch authority. */
import { parseRecordingWireAttachRequest } from "./recording-wire-contract";
import {
  Core,
  parseLimits,
  reject,
  success,
} from "./recording-wire-receiver/core";
import * as calls from "./recording-wire-receiver/calls";
import * as frames from "./recording-wire-receiver/frames";
import { display, terminal } from "./recording-wire-receiver/readout";
import type {
  ReceiverLimits,
  ReceiverResult,
  WireReceiver,
} from "./recording-wire-receiver/types";
export type * from "./recording-wire-receiver/types";
const receiverInstances = new WeakSet<object>();
export function isRecordingWireReceiver(value: unknown): value is WireReceiver {
  return (
    typeof value === "object" && value !== null && receiverInstances.has(value)
  );
}
export function createRecordingWireReceiver(
  scope: unknown,
  options?: Partial<ReceiverLimits>,
): Readonly<
  | { ok: true; value: WireReceiver }
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
    published = c.view(),
    publishedDisplay = display(published);
  function guard<T>(
    fn: () => ReceiverResult<T>,
    commit = true,
  ): ReceiverResult<T> {
    if (busy) return reject("busy");
    busy = true;
    try {
      return fn();
    } finally {
      try {
        if (commit) {
          const next = c.view(),
            nextDisplay = display(next);
          published = next;
          publishedDisplay = nextDisplay;
        }
      } finally {
        busy = false;
      }
    }
  }
  const receiver: WireReceiver = Object.freeze<WireReceiver>({
    beginAttach: (q) => guard(() => calls.beginAttach(c, q)),
    acceptAttach: (g, r) => guard(() => calls.acceptAttach(c, g, r)),
    beginControl: (g, q) => guard(() => calls.beginControl(c, g, q)),
    acceptControlReply: (t, r) =>
      guard(() => calls.acceptControlReply(c, t, r)),
    acceptState: (g, f) => guard(() => frames.acceptState(c, g, f)),
    acceptControlFrame: (g, f) =>
      guard(() => frames.acceptControlFrame(c, g, f)),
    setConnected: (connected) =>
      guard(() => {
        if (typeof connected !== "boolean") return reject("invalidRequest");
        if (c.disposed) return reject("disposed");
        c.connected = connected;
        if (!connected) c.retire();
        return success(null);
      }),
    retire: (token) =>
      guard(() => {
        const g = c.generation(token);
        if (!g) return reject("foreignToken");
        c.retire(g);
        return success(null);
      }),
    current: () => published,
    currentDisplay: () => publishedDisplay,
    attachTerminal: (token) =>
      guard(() => {
        const record = c.generation(token);
        return record ? success(terminal(record)) : reject("foreignToken");
      }, false),
    controlTerminal: (token) =>
      guard(() => {
        const record = c.control(token);
        return record ? success(terminal(record)) : reject("foreignToken");
      }, false),
    dispose: () =>
      guard(() => {
        c.disposed = true;
        c.stopped ??= "disposed";
        c.retire();
        return success(null);
      }),
  });
  receiverInstances.add(receiver);
  return Object.freeze({ ok: true, value: receiver });
}
