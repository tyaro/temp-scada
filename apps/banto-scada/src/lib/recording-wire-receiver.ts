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
import type {
  ReceiverLimits,
  ReceiverResult,
  WireReceiver,
} from "./recording-wire-receiver/types";
export type * from "./recording-wire-receiver/types";
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
    published = c.view();
  function guard<T>(fn: () => ReceiverResult<T>): ReceiverResult<T> {
    if (busy) return reject("busy");
    busy = true;
    try {
      return fn();
    } finally {
      published = c.view();
      busy = false;
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
    dispose: () =>
      guard(() => {
        c.disposed = true;
        c.stopped ??= "disposed";
        c.retire();
        return success(null);
      }),
  });
  return Object.freeze({ ok: true, value: receiver });
}
