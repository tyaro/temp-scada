import {
  parseRecordingWireAttachRequest,
  parseRecordingWireAttachReply,
  parseRecordingWireControlRequest,
  parseRecordingWireControlReply,
  recordingWireReplyMatchesRequest,
  WIRE_LIMITS,
} from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import {
  Core,
  Fault,
  success,
  reject,
  received,
  measured,
  requireReceiver,
  type Generation,
  type ControlRecord,
} from "./core";
import { project, applyControl } from "./snapshots";
import type {
  AttachGeneration,
  ControlCall,
  ReceiverResult,
  ReceiveResult,
} from "./types";
function beginFailure(error: unknown): ReceiverResult<never> {
  return reject(
    error instanceof Fault && error.reason === "capacity"
      ? "capacity"
      : "invalidRequest",
  );
}
export function beginAttach(
  c: Core,
  input: unknown,
): ReceiverResult<AttachGeneration> {
  try {
    const q = parseRecordingWireAttachRequest(input);
    if (!c.matches(q.scope)) return reject("invalidRequest");
    const known = c.generations.get(q.attachId);
    if (known) {
      if (!sameOwnedJson(known.request, q)) {
        c.fail("protocolViolation", false, false);
        return reject("protocolViolation");
      }
      return success(known.token);
    }
    const gate = c.gate();
    if (gate) return reject(gate);
    if (c.pendingAttach() || c.pendingControl()) return reject("busy");
    if (
      c.highwater !== null &&
      (q.afterRevision === null || q.afterRevision < c.highwater)
    )
      return reject("invalidRequest");
    requireReceiver(c.generations.size < c.limits.attachIds, "capacity");
    const cost =
      measured(q, "request") + WIRE_LIMITS.reply.bytes + c.controlBound + 1024;
    c.checkCost(cost);
    const token = Object.freeze({}) as AttachGeneration;
    const generation: Generation = {
      token,
      request: q,
      floor: c.highwater,
      phase: "attaching",
      provisional: new Map(),
      controlPending: false,
    };
    c.retire();
    c.generations.set(q.attachId, generation);
    c.tokens.set(token, generation);
    c.current = generation;
    c.callBytes += cost;
    c.resync = false;
    return success(token);
  } catch (error) {
    return beginFailure(error);
  }
}
export function beginControl(
  c: Core,
  token: unknown,
  input: unknown,
): ReceiverResult<ControlCall> {
  const g = c.generation(token);
  if (!g) return reject("foreignToken");
  try {
    const q = parseRecordingWireControlRequest(input);
    if (!c.matches(q.scope)) return reject("invalidRequest");
    const known = c.controls.get(q.controlId);
    if (known) {
      if (known.generation !== g || !sameOwnedJson(known.request, q)) {
        c.fail("protocolViolation", false, false);
        return reject("protocolViolation");
      }
      return success(known.token);
    }
    const gate = c.gate();
    if (gate) return reject(gate);
    if (c.current !== g || g.phase !== "attached" || c.pendingControl())
      return reject("busy");
    if (q.subscriptionRef !== g.ref) return reject("invalidRequest");
    requireReceiver(c.controls.size < c.limits.controlIds, "capacity");
    const cost = measured(q, "request") + WIRE_LIMITS.reply.bytes + 1024;
    c.checkCost(cost);
    const callToken = Object.freeze({}) as ControlCall;
    const call: ControlRecord = { token: callToken, generation: g, request: q };
    c.controls.set(q.controlId, call);
    c.controlTokens.set(callToken, call);
    c.callBytes += cost;
    return success(callToken);
  } catch (error) {
    return beginFailure(error);
  }
}
export function acceptAttach(
  c: Core,
  token: unknown,
  input: unknown,
): ReceiveResult {
  const g = c.generation(token);
  if (!g) return reject("foreignToken");
  let reply;
  try {
    reply = parseRecordingWireAttachReply(input);
  } catch {
    return c.fail("invalidDocument");
  }
  if (!recordingWireReplyMatchesRequest(reply, g.request))
    return c.fail("protocolViolation");
  if (g.reply)
    return sameOwnedJson(g.reply, reply)
      ? received("duplicate")
      : c.fail("protocolViolation");
  // The request's reserved reply budget protects this terminal even if projection fails.
  g.reply = reply;
  if (reply.outcome.kind === "rejected") {
    c.retire(g);
    return received("applied");
  }
  const { subscriptionRef: ref, snapshot } = reply.outcome;
  const reused = [...c.generations.values()].some(
    (other) => other !== g && other.ref === ref,
  );
  g.ref = ref;
  if (reused) return c.fail("protocolViolation", true);
  if (!c.isLive(g)) return received("ignoredRetired");
  try {
    requireReceiver(snapshot.revision >= (g.floor ?? 0));
    requireReceiver(!g.provisionalRef || g.provisionalRef === ref);
    requireReceiver(
      [...g.provisional.values()].every((s) => s.revision >= snapshot.revision),
    );
    project(c, [snapshot, ...g.provisional.values()]);
    g.phase = "attached";
    g.provisional.clear();
    g.stateSlot = undefined;
    if (g.control) {
      applyControl(c, g, g.control);
    }
    return received("applied");
  } catch (error) {
    return c.failure(error, true);
  }
}
export function acceptControlReply(
  c: Core,
  token: unknown,
  input: unknown,
): ReceiveResult {
  const call = c.control(token);
  if (!call) return reject("foreignToken");
  let reply;
  try {
    reply = parseRecordingWireControlReply(input);
  } catch {
    return c.fail("invalidDocument");
  }
  if (!recordingWireReplyMatchesRequest(reply, call.request))
    return c.fail("protocolViolation");
  if (call.reply)
    return sameOwnedJson(call.reply, reply)
      ? received("duplicate")
      : c.fail("protocolViolation");
  call.reply = reply;
  if (!c.isLive(call.generation)) return received("ignoredRetired");
  try {
    if (reply.outcome.kind === "snapshot") project(c, [reply.outcome.snapshot]);
    else if (reply.outcome.kind === "detached") c.retire(call.generation);
    return received("applied");
  } catch (error) {
    return c.failure(error, true);
  }
}
