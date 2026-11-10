import { expect, it } from "vitest";
import {
  deliveryFixtures,
  deliveryRequest,
  deliveryReply,
  cloneDelivery as clone,
} from "../../lib/__fixtures__/recording-wire-delivery-ledger-cases";
import { wireFixtures } from "../../lib/__fixtures__/recording-wire-cases";
import type {
  PortStateV2,
  PortTransportEnd,
} from "../../lib/recording-async/port";
import { createNativeRecordingPortV2, type PortSignal } from "./port";
import { RECORDING_EVENT } from "./events";

const scope = clone(deliveryFixtures.scope);

type Handler = (args: any, call: number) => unknown;

/**
 * A fake desktop host. Each command answers `{seq, reply}` from a handler;
 * a handler that throws rejects (vitest 5 treats `mockRejectedValue` as
 * unhandled, so the rejection is a plain thrown value in an async function).
 */
function fakeHost() {
  const calls: { cmd: string; args: any }[] = [];
  const handlers: Record<string, Handler> = {};
  let seq = 1;
  let listener: ((event: { payload: unknown }) => void) | undefined;
  const listenOrder: string[] = [];
  const counts: Record<string, number> = {};
  const invoke = async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args: clone(args) });
    listenOrder.push(cmd);
    counts[cmd] = (counts[cmd] ?? 0) + 1;
    const handler = handlers[cmd] ?? defaults[cmd];
    if (!handler) throw { kind: "invalidRequest" };
    const reply = await handler(args, counts[cmd]);
    return { seq, reply };
  };
  const listen = async (event: string, handler: any) => {
    expect(event).toBe(RECORDING_EVENT);
    listenOrder.push("listen");
    listener = handler;
    return () => {
      listener = undefined;
    };
  };
  const snapshot = (revision: number, patch: object = {}) => ({
    scope,
    revision,
    closed: false,
    ownerBlocked: false,
    admission: null,
    operation: null,
    reconciliation: null,
    ...patch,
  });
  const defaults: Record<string, Handler> = {
    recording_attach: (args, n) => ({
      version: 1,
      kind: "recordingWireAttachReply",
      request: args.request,
      outcome: {
        kind: "attached",
        subscriptionRef: `native-subscription:${n}`,
        snapshot: snapshot(args.request.afterRevision ?? 1),
      },
    }),
    recording_workflow_reserve: (args) => ({ changeId: args.request.changeId }),
    recording_workflow_lease: (args) => deliveryReply(args.request),
    recording_lease: (args) => deliveryReply(args.request),
    recording_cancel: (args) => deliveryReply(args.request),
    recording_control: (args) => ({
      version: 1,
      kind: "recordingWireControlReply",
      request: args.request,
      outcome: { kind: "detached" },
    }),
  };
  return {
    calls,
    handlers,
    invoke,
    listen,
    listenOrder,
    snapshot,
    setSeq: (n: number) => (seq = n),
    emit(payload: unknown) {
      listener?.({ payload });
    },
    get listening() {
      return !!listener;
    },
  };
}

function timers() {
  const queue: (() => void)[] = [];
  return {
    setTimer: (run: () => void) => queue.push(run),
    clearTimer: () => {},
    /** Runs the timers due now (not the ones they schedule). */
    run() {
      for (const run of queue.splice(0)) run();
    },
    get size() {
      return queue.length;
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(access: "mutation" | "read" = "mutation") {
  const host = fakeHost(),
    clock = timers(),
    signals: PortSignal[] = [];
  let ids = 0;
  const native = createNativeRecordingPortV2({
    invoke: host.invoke,
    listen: host.listen as never,
    scope,
    access,
    signal: (s) => signals.push(s),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: (tag) => `${tag}:${++ids}`,
  });
  const states: PortStateV2[] = [];
  native.port.subscribe((s) => states.push(s));
  return { host, clock, signals, native, port: native.port, states };
}

const frames = (
  host: ReturnType<typeof fakeHost>,
  revision: number,
  patch: object = {},
) => ({
  kind: "frames",
  subscriptionRef: "native-subscription:1",
  ownerEpoch: scope.ownerEpoch,
  seq: 1,
  state: {
    version: 1,
    kind: "recordingWireStateFrame",
    subscriptionRef: "native-subscription:1",
    snapshot: host.snapshot(revision),
  },
  control: null,
  ...patch,
});

it("listens before it attaches and binds the attach reply's seq", async () => {
  const { host, native, port } = setup();
  expect(port.current()).toMatchObject({
    version: 2,
    subscription: "idle",
    seq: null,
  });
  await native.start();
  expect(host.listenOrder.slice(0, 2)).toEqual(["listen", "recording_attach"]);
  expect(host.calls[0].args.request).toMatchObject({
    kind: "recordingWireAttachRequest",
    scope,
    attachId: "at:1",
    afterRevision: null,
  });
  expect(port.current()).toMatchObject({
    subscription: "attached",
    seq: 1,
    display: { snapshotRelation: "currentSubscription", highwater: 1 },
  });
  host.emit(frames(host, 2));
  expect(port.current().display.snapshot?.revision).toBe(2);
  // Another generation, another root or another subscription: dropped.
  host.emit(frames(host, 3, { seq: 2 }));
  host.emit(frames(host, 3, { ownerEpoch: "epoch:other" }));
  host.emit(frames(host, 3, { subscriptionRef: "native-subscription:9" }));
  expect(port.current().display.snapshot?.revision).toBe(2);
  expect(port.current().authorizationLost).toBe(null);
});

it("sends each lease stage to its command with the stage and operation ID", async () => {
  const { host, port } = setup();
  const lease = deliveryRequest("lease");
  const change = { changeId: "change:1" } as never;
  const preflight = port.prepareLease({
    role: "mutation",
    stage: "preflight",
    change,
    lease,
  });
  expect(await preflight.transport).toEqual({ kind: "returned" });
  expect((await preflight.reply).outcome.kind).toBe("issued");
  expect(host.calls.map((c) => c.cmd)).toEqual([
    "recording_workflow_reserve",
    "recording_workflow_lease",
  ]);
  expect(host.calls[0].args).toEqual({ request: change });
  expect(host.calls[1].args).toEqual({
    stage: "preflight",
    operationId: null,
    request: lease,
  });
  const pause = port.prepareLease({
    role: "mutation",
    stage: "pauseJoin",
    operationId: "op:1",
    lease: deliveryRequest("lease", [
      { path: "leaseRequestId", value: "lease-2" },
      { path: "admissionId", value: "admission-2" },
    ]),
  });
  expect(await pause.transport).toEqual({ kind: "returned" });
  expect(host.calls[2].args).toMatchObject({
    stage: "pauseJoin",
    operationId: "op:1",
  });
  const read = deliveryRequest("lease", [
    { path: "leaseRequestId", value: "lease-3" },
    { path: "admissionId", value: "admission-3" },
    { path: "role", value: "reconciliation" },
  ]);
  const reconcile = port.prepareLease({ role: "reconciliation", lease: read });
  expect(await reconcile.transport).toEqual({ kind: "returned" });
  expect(host.calls[3]).toEqual({
    cmd: "recording_lease",
    args: { request: read },
  });
});

it("refuses a lease whose outer role differs, and mutation on a read port, unsent", async () => {
  const { host, port } = setup();
  const wrong = port.prepareLease({
    role: "reconciliation",
    lease: deliveryRequest("lease"),
  });
  expect(await wrong.transport).toEqual({
    kind: "refused",
    refusal: { kind: "invalidRequest" },
  });
  const reader = setup("read");
  const denied = reader.port.prepareLease({
    role: "mutation",
    stage: "discard",
    lease: deliveryRequest("lease"),
  });
  expect(await denied.transport).toEqual({
    kind: "refused",
    refusal: { kind: "forbidden" },
  });
  expect(host.calls).toEqual([]);
  expect(reader.host.calls).toEqual([]);
});

it("drops a reply of another session generation and asks for the slot again", async () => {
  const { host, port, native, signals } = setup();
  await native.start();
  host.setSeq(2);
  const cancel = port.requestCancel(deliveryRequest("cancel"));
  expect(await cancel.transport).toEqual({ kind: "staleSeq", seq: 2 });
  expect(port.current()).toMatchObject({
    seq: 1,
    authorizationLost: "seqChanged",
  });
  expect(signals).toEqual(["seqChanged"]);
  // Its reply was never stored, so it never resolves.
  let replied = false;
  void cancel.reply.then(() => (replied = true));
  await settle();
  expect(replied).toBe(false);
});

it("records the host's refusals as owner and authorization causes", async () => {
  for (const [refusal, field, value, signal] of [
    [
      { kind: "recordingUnavailable", reason: "no_recording_run" },
      "ownerClosed",
      "slotEmpty",
      ["ownerClosed"],
    ],
    [{ kind: "closed" }, "ownerClosed", "hostClosed", ["ownerClosed"]],
    [{ kind: "unauthorized" }, "authorizationLost", "refused", []],
  ] as const) {
    const { host, port, signals } = setup();
    host.handlers.recording_cancel = () => {
      throw refusal;
    };
    const cancel = port.requestCancel(deliveryRequest("cancel"));
    expect(await cancel.transport).toEqual({ kind: "refused", refusal });
    expect(port.current()[field]).toBe(value);
    expect(signals).toEqual(signal);
  }
  const { host, port } = setup();
  host.handlers.recording_cancel = () => {
    throw new Error("ipc");
  };
  expect(await port.requestCancel(deliveryRequest("cancel")).transport).toEqual(
    {
      kind: "failed",
    },
  );
});

it("recovers a lost admission reply with CallInspection, never sending it again", async () => {
  const { host, port, native } = setup();
  await native.start();
  const admission = deliveryRequest("admit");
  const accepted = deliveryReply(admission, "accepted");
  host.handlers.recording_admission = () => {
    throw new Error("lost");
  };
  const admit = port.admit(admission);
  expect(await admit.transport).toEqual({ kind: "failed" });
  host.handlers.recording_call_inspection = (args) => ({
    version: 1,
    kind: "recordingWireCallInspectionReply",
    request: args.request,
    outcome: { kind: "terminal", reply: accepted },
  });
  const inspection = port.inspectCall(admit as never);
  expect(inspection.request).toMatchObject({
    kind: "recordingWireCallInspectionRequest",
    callInspectionId: "ci:2",
    original: admission,
  });
  expect(await inspection.transport).toEqual({ kind: "returned" });
  expect((await inspection.reply).outcome.kind).toBe("terminal");
  expect(await admit.reply).toEqual(accepted);
  expect(
    host.calls.filter((c) => c.cmd === "recording_admission"),
  ).toHaveLength(1);
  // A call the port did not make is not inspected.
  const foreign = port.inspectCall({ request: admission } as never);
  expect(await foreign.transport).toMatchObject({ kind: "refused" });
});

function observable() {
  const observation = clone(wireFixtures.bases.observe);
  const admission = deliveryRequest("admit");
  admission.action = {
    kind: "apply",
    changeRef: "change-ref",
    operation: clone(observation.target.request),
  };
  const accepted = {
    version: 1,
    kind: "recordingAdmissionReply",
    request: clone(admission),
    outcome: {
      kind: "accepted",
      handle: {
        kind: "operation",
        changeRef: "change-ref",
        operationRef: observation.target.operationRef,
        request: clone(observation.target.request),
      },
    },
  };
  return {
    admission,
    accepted,
    target: observation.target,
    terminal: wireFixtures.bases.observationReply.outcome,
  };
}

it("repeats a pending observation and resolves on its terminal reply only", async () => {
  const { host, port, clock } = setup();
  const { admission, accepted, target, terminal } = observable();
  host.handlers.recording_admission = () => accepted;
  await port.admit(admission).transport;
  const outcomes = [{ kind: "pending" }, { kind: "pending" }, terminal];
  host.handlers.recording_observation = (args, n) => ({
    version: 1,
    kind: "recordingWireObservationReply",
    request: args.request,
    outcome: outcomes[n - 1],
  });
  const observed = port.observe(target);
  expect(port.observe(target)).toBe(observed);
  let result: any;
  void observed.result.then((r) => (result = r));
  await settle();
  expect(result).toBeUndefined();
  expect(port.current().observations).toEqual([
    { target, query: "pending", attemptsInFlight: 0 },
  ]);
  clock.run();
  await settle();
  clock.run();
  await settle();
  expect(result.outcome).toEqual(terminal);
  const sent = host.calls.filter((c) => c.cmd === "recording_observation");
  expect(sent).toHaveLength(3);
  // One query: every attempt repeats the same request.
  expect(new Set(sent.map((c) => c.args.request.observationId))).toEqual(
    new Set(["ob:1"]),
  );
  expect(port.current().observations[0].query).toBe("terminal");
});

it("makes a new query after a lost reply, at most twice, then reports transportLost", async () => {
  const { host, port, clock } = setup();
  const { admission, accepted, target } = observable();
  host.handlers.recording_admission = () => accepted;
  await port.admit(admission).transport;
  host.handlers.recording_observation = () => {
    throw { kind: "phase", phase: "transitioning" };
  };
  port.observe(target);
  for (let i = 0; i < 4; i++) {
    await settle();
    clock.run();
  }
  await settle();
  const sent = host.calls.filter((c) => c.cmd === "recording_observation");
  expect(sent.map((c) => c.args.request.observationId)).toEqual([
    "ob:1",
    "ob:2",
    "ob:3",
  ]);
  expect(port.current().observations[0].query).toBe("transportLost");
});

it("ends without attaching again on unauthorized, and attaches once more on other reasons", async () => {
  const lost = setup();
  await lost.native.start();
  const ended = (reason: string, ref = "native-subscription:1") => ({
    kind: "ended",
    subscriptionRef: ref,
    ownerEpoch: scope.ownerEpoch,
    reason,
  });
  lost.host.emit(ended("unauthorized"));
  await settle();
  expect(lost.port.current()).toMatchObject({
    subscription: "stopped",
    ended: "unauthorized",
    authorizationLost: "ended",
  });
  expect(
    lost.host.calls.filter((c) => c.cmd === "recording_attach"),
  ).toHaveLength(1);

  const { host, native, port, signals } = setup();
  await native.start();
  // Another root's end (the references restart with each root) is not ours.
  host.emit({ ...ended("invalidInput"), ownerEpoch: "epoch:old" });
  expect(port.current().subscription).toBe("attached");
  host.emit(ended("invalidInput"));
  await settle();
  const attaches = host.calls.filter((c) => c.cmd === "recording_attach");
  expect(attaches.map((c) => c.args.request.attachId)).toEqual([
    "at:1",
    "at:2",
  ]);
  expect(attaches[1].args.request.afterRevision).toBe(1);
  expect(port.current()).toMatchObject({
    subscription: "attached",
    ended: "invalidInput",
  });
  host.emit(ended("invalidInput", "native-subscription:2"));
  await settle();
  expect(port.current().subscription).toBe("stopped");
  expect(signals).toEqual(["stopped"]);
});

it("takes frames that arrive before the attach reply, and an ownerClosed control frame", async () => {
  const { host, native, port, signals } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  host.handlers.recording_attach = async (args) => {
    await gate;
    return {
      version: 1,
      kind: "recordingWireAttachReply",
      request: args.request,
      outcome: {
        kind: "attached",
        subscriptionRef: "native-subscription:1",
        snapshot: host.snapshot(1),
      },
    };
  };
  const started = native.start();
  await settle();
  expect(port.current().subscription).toBe("attaching");
  host.emit(frames(host, 2));
  release();
  await started;
  expect(port.current().display.snapshot?.revision).toBe(2);
  host.emit(
    frames(host, 3, {
      state: {
        version: 1,
        kind: "recordingWireStateFrame",
        subscriptionRef: "native-subscription:1",
        snapshot: host.snapshot(3, { closed: true }),
      },
      control: {
        version: 1,
        kind: "recordingWireControlFrame",
        scope,
        subscriptionRef: "native-subscription:1",
        reason: "ownerClosed",
      },
    }),
  );
  expect(port.current()).toMatchObject({ ownerClosed: "controlFrame" });
  expect(port.current().display.ownerClosed).toBe(true);
  expect(signals).toEqual(["ownerClosed"]);
});

it("detaches on dispose and stops listening", async () => {
  const { host, native, port } = setup();
  await native.start();
  native.dispose();
  await settle();
  expect(host.calls.at(-1)).toMatchObject({
    cmd: "recording_control",
    args: {
      request: { action: "detach", subscriptionRef: "native-subscription:1" },
    },
  });
  expect(host.listening).toBe(false);
  expect(port.current().subscription).toBe("stopped");
  const end: PortTransportEnd = await port.requestCancel(
    deliveryRequest("cancel"),
  ).transport;
  // Calls still go (a closed coordinator keeps monitoring accepted work).
  expect(end.kind).toBe("returned");
});

it("waits for the admission's own stored reply before observing a target seen in a frame first", async () => {
  const { host, port } = setup();
  const { admission, accepted, target, terminal } = observable();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  host.handlers.recording_admission = async () => {
    await gate;
    return accepted;
  };
  host.handlers.recording_observation = (args) => ({
    version: 1,
    kind: "recordingWireObservationReply",
    request: args.request,
    outcome: terminal,
  });
  const admit = port.admit(admission);
  // A cached frame announced the accepted admission: the coordinator observes.
  const observed = port.observe(target);
  await settle();
  expect(host.calls.filter((c) => c.cmd === "recording_observation")).toEqual(
    [],
  );
  expect(port.current().observations[0].query).toBe("pending");
  release();
  await admit.transport;
  expect((await observed.result).outcome).toEqual(terminal);
});
