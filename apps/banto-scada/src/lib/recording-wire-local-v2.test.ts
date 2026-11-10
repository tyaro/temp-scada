import { expect, it } from "vitest";
import {
  createRecordingWireLocalV2,
  type LocalV2Result,
} from "./recording-wire-local-v2";
import {
  makeDelivery,
  deliveryRequest,
  deliveryReply,
  deliveryQuery,
  deliveryInspection,
  cloneDelivery as clone,
  deliveryFixtures,
  frozenDelivery,
} from "./__fixtures__/recording-wire-delivery-ledger-cases";
import {
  makeReceiver,
  receiverAttachRequest,
  receiverAttachReply,
  receiverControlRequest,
  receiverControlReply,
} from "./__fixtures__/recording-wire-receiver-cases";
import { wireFixtures } from "./__fixtures__/recording-wire-cases";
import { createRecordingWireReceiver } from "./recording-wire-receiver";
import {
  localV2Cases,
  runLocalV2Scenario,
} from "./__fixtures__/recording-wire-local-v2-cases";

for (const scenario of localV2Cases.scenarios)
  it(`shared local-v2 scenario: ${scenario.name}`, async () => {
    const usage = await runLocalV2Scenario(scenario);
    expect(usage.pending).toBe(0);
  });

function take<T>(
  r: LocalV2Result<T> | { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!r.ok) throw Error(r.reason);
  return r.value;
}
function setup(options?: { maxHandles: number }) {
  const ledger = makeDelivery();
  const receiver = makeReceiver();
  const local = take(createRecordingWireLocalV2(ledger, receiver, options));
  return { ledger, receiver, local };
}
async function remainsPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

it("detects an already settled Promise in the pending assertion", async () => {
  await expect(remainsPending(Promise.resolve(null))).rejects.toThrow();
  await expect(
    remainsPending(Promise.reject(Error("settled"))),
  ).rejects.toThrow();
});

it("delivers one exact original reply after explicit pump", async () => {
  const { ledger, local } = setup();
  const request = deliveryRequest("lease");
  const token = take(ledger.beginOriginal(request));
  const handle = take(local.watchOriginal(token));
  expect(take(local.watchOriginal(token))).toBe(handle);
  await remainsPending(handle.completion);
  expect(local.pump()).toMatchObject({
    ok: true,
    value: { delivered: 0, pending: 1 },
  });
  const reply = deliveryReply(request);
  expect(ledger.acceptOriginal(token, reply).ok).toBe(true);
  await remainsPending(handle.completion);
  expect(local.pump()).toMatchObject({
    ok: true,
    value: { delivered: 1, pending: 0 },
  });
  expect(await handle.completion).toBe(take(ledger.original(token)).terminal);
  expect(await handle.completion).toEqual(reply);
  expect(local.pump()).toMatchObject({
    ok: true,
    value: { delivered: 0, pending: 0 },
  });
  expect(local.current().usage).toMatchObject({
    handles: 1,
    pending: 0,
    delivered: 1,
  });
  expect(frozenDelivery(local.current())).toBe(true);
});

it("keeps unknown original and found accepted inspection independent", async () => {
  const { ledger, local } = setup();
  const admission = deliveryRequest("admit");
  const original = take(ledger.beginOriginal(admission));
  const originalHandle = take(local.watchOriginal(original));
  const unknown = deliveryReply(admission, "unknown");
  expect(ledger.acceptOriginal(original, unknown).ok).toBe(true);
  take(local.pump());
  expect((await originalHandle.completion).outcome.kind).toBe("unknown");
  const inspectionRequest = deliveryRequest("inspect");
  const inspection = take(ledger.beginOriginal(inspectionRequest));
  const inspectionHandle = take(local.watchOriginal(inspection));
  const found = deliveryReply(inspectionRequest, "foundAccepted");
  expect(ledger.acceptOriginal(inspection, found).ok).toBe(true);
  take(local.pump());
  expect((await inspectionHandle.completion).outcome.kind).toBe("found");
  expect((await originalHandle.completion).outcome.kind).toBe("unknown");
});

it("delivers CallInspection pending attempt without resolving its original", async () => {
  const { ledger, local } = setup();
  const request = deliveryRequest("lease");
  const original = take(ledger.beginOriginal(request));
  const originalHandle = take(local.watchOriginal(original));
  const inspectionRequest = deliveryQuery(request);
  const pair = take(ledger.beginInspection(original, inspectionRequest));
  const attemptHandle = take(local.watchInspectionAttempt(pair.attempt));
  const pending = deliveryInspection(inspectionRequest, "pending");
  expect(ledger.acceptInspection(pair.attempt, pending).ok).toBe(true);
  take(local.pump());
  expect((await attemptHandle.completion).outcome.kind).toBe("pending");
  await remainsPending(originalHandle.completion);
  const second = take(ledger.repeatInspection(pair.query));
  const terminalHandle = take(local.watchInspectionAttempt(second));
  expect(
    ledger.acceptInspection(
      second,
      deliveryInspection(inspectionRequest, "terminal", deliveryReply(request)),
    ).ok,
  ).toBe(true);
  take(local.pump());
  expect((await terminalHandle.completion).outcome.kind).toBe("terminal");
  expect((await originalHandle.completion).kind).toBe(
    "recordingWireLeaseReply",
  );
});

it("keeps Observation attempt pending separate from query terminal", async () => {
  const { ledger, local } = setup();
  const request = clone(wireFixtures.bases.observe);
  const terminal = clone(wireFixtures.bases.observationReply);
  const admission = deliveryRequest("admit");
  admission.action = {
    kind: "apply",
    changeRef: "change-ref",
    operation: clone(request.target.request),
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
        operationRef: request.target.operationRef,
        request: clone(request.target.request),
      },
    },
  };
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  const pair = take(ledger.beginObservation(target, request));
  const attempt = take(local.watchObservationAttempt(pair.attempt));
  const query = take(local.watchObservationQuery(pair.query));
  const pending = {
    version: 1,
    kind: "recordingWireObservationReply",
    request: clone(request),
    outcome: { kind: "pending" },
  };
  expect(ledger.acceptObservation(pair.attempt, pending).ok).toBe(true);
  take(local.pump());
  expect((await attempt.completion).outcome.kind).toBe("pending");
  await remainsPending(query.completion);
  const second = take(ledger.repeatObservation(pair.query));
  const terminalAttempt = take(local.watchObservationAttempt(second));
  expect(ledger.acceptObservation(second, terminal).ok).toBe(true);
  take(local.pump());
  expect((await terminalAttempt.completion).outcome.kind).toBe("operation");
  expect(await query.completion).toBe(
    take(ledger.observation(pair.query)).terminal,
  );
  expect(local.current().usage).toMatchObject({ pending: 0, delivered: 3 });
});

it("delivers Attach and Control from receiver-owned terminal only", async () => {
  const { receiver, local } = setup();
  take(receiver.setConnected(true));
  const attachRequest = receiverAttachRequest();
  const generation = take(receiver.beginAttach(attachRequest));
  const attach = take(local.watchAttach(generation));
  await remainsPending(attach.completion);
  const attached = receiverAttachReply(attachRequest);
  expect(receiver.acceptAttach(generation, attached).ok).toBe(true);
  take(local.pump());
  const storedAttach = take(receiver.attachTerminal(generation));
  if (storedAttach.kind !== "terminal") throw Error("attach terminal");
  expect(await attach.completion).toBe(storedAttach.reply);
  const controlRequest = receiverControlRequest();
  const call = take(receiver.beginControl(generation, controlRequest));
  const control = take(local.watchControl(call));
  const controlReply = receiverControlReply(controlRequest);
  expect(receiver.acceptControlReply(call, controlReply).ok).toBe(true);
  take(local.pump());
  const storedControl = take(receiver.controlTerminal(call));
  if (storedControl.kind !== "terminal") throw Error("control terminal");
  expect(await control.completion).toBe(storedControl.reply);
  expect(local.current().display).toBe(receiver.currentDisplay());
});

it("rejects foreign, wrong-kind and mismatched epoch without looking up IDs", () => {
  const { ledger, receiver, local } = setup();
  const original = take(ledger.beginOriginal(deliveryRequest("lease")));
  const other = setup();
  expect(local.watchOriginal({} as typeof original)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  const foreign = take(other.ledger.beginOriginal(deliveryRequest("lease")));
  expect(local.watchOriginal(foreign)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(local.watchAttach(original as any)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  const mismatched = makeReceiver();
  const wrong = createRecordingWireLocalV2(ledger, mismatched);
  expect(wrong.ok).toBe(true);
  const changedScope = { ...deliveryFixtures.scope, ownerEpoch: "different" };
  const newReceiver = take(createRecordingWireReceiver(changedScope));
  expect(createRecordingWireLocalV2(ledger, newReceiver)).toMatchObject({
    ok: false,
    reason: "scopeMismatch",
  });
  expect(receiver.currentDisplay().scope).toEqual(local.scope);
});

it("reserves a finite handle count and returns exact identity after exhaustion", () => {
  const { ledger, local } = setup({ maxHandles: 1 });
  const first = take(ledger.beginOriginal(deliveryRequest("lease")));
  const handle = take(local.watchOriginal(first));
  expect(take(local.watchOriginal(first))).toBe(handle);
  const other = take(ledger.beginOriginal(deliveryRequest("cancel")));
  const before = local.current();
  expect(local.watchOriginal(other)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(local.current()).toBe(before);
  expect(local.current().usage).toMatchObject({
    handles: 1,
    pending: 1,
    maxHandles: 1,
  });
  expect(
    ledger.acceptOriginal(first, deliveryReply(deliveryRequest("lease"))).ok,
  ).toBe(true);
  take(local.pump());
  expect(local.watchOriginal(other)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
});

it("accepts zero capacity but no new token", () => {
  const { ledger, local } = setup({ maxHandles: 0 });
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  expect(local.watchOriginal(token)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(local.current().usage).toMatchObject({ handles: 0, maxHandles: 0 });
});

it("retains a pending delivery through retire, dispose and a late normal reply", async () => {
  const { ledger, local } = setup();
  const request = deliveryRequest("lease");
  const token = take(ledger.beginOriginal(request));
  const handle = take(local.watchOriginal(token));
  take(ledger.retire());
  take(ledger.dispose());
  await remainsPending(handle.completion);
  expect(ledger.acceptOriginal(token, deliveryReply(request)).ok).toBe(true);
  expect(take(local.pump()).delivered).toBe(1);
  expect(await handle.completion).toBe(take(ledger.original(token)).terminal);
});

it("does not settle one Observation query from another query's target result", async () => {
  const { ledger, local } = setup();
  const request = clone(wireFixtures.bases.observe);
  const admission = deliveryRequest("admit");
  admission.action = {
    kind: "apply",
    changeRef: "change-ref",
    operation: clone(request.target.request),
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
        operationRef: request.target.operationRef,
        request: clone(request.target.request),
      },
    },
  };
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  const first = take(ledger.beginObservation(target, request));
  const firstHandle = take(local.watchObservationQuery(first.query));
  const pending = {
    version: 1,
    kind: "recordingWireObservationReply",
    request: clone(request),
    outcome: { kind: "pending" },
  };
  expect(ledger.acceptObservation(first.attempt, pending).ok).toBe(true);
  const otherRequest = { ...request, observationId: "other" };
  const other = take(ledger.beginObservation(target, otherRequest));
  const otherHandle = take(local.watchObservationQuery(other.query));
  const result = clone(wireFixtures.bases.observationReply);
  result.request.observationId = "other";
  expect(ledger.acceptObservation(other.attempt, result).ok).toBe(true);
  expect(take(local.pump()).delivered).toBe(1);
  expect((await otherHandle.completion).outcome.kind).toBe("operation");
  await remainsPending(firstHandle.completion);
  expect(take(ledger.observationTarget(target)).result).not.toBeNull();
});

it("delivers unavailable as a query terminal without an operation result", async () => {
  const { ledger, local } = setup();
  const request = clone(wireFixtures.bases.observe);
  const admission = deliveryRequest("admit");
  admission.action = {
    kind: "apply",
    changeRef: "change-ref",
    operation: clone(request.target.request),
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
        operationRef: request.target.operationRef,
        request: clone(request.target.request),
      },
    },
  };
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  const pair = take(ledger.beginObservation(target, request));
  const attempt = take(local.watchObservationAttempt(pair.attempt));
  const query = take(local.watchObservationQuery(pair.query));
  const reply = {
    version: 1,
    kind: "recordingWireObservationReply",
    request: clone(request),
    outcome: { kind: "unavailable", error: "ownerUnavailable" },
  };
  expect(ledger.acceptObservation(pair.attempt, reply).ok).toBe(true);
  expect(take(local.pump()).delivered).toBe(2);
  expect((await attempt.completion).outcome.kind).toBe("unavailable");
  expect(await query.completion).toBe(
    take(ledger.observation(pair.query)).terminal,
  );
  expect(take(ledger.observationTarget(target)).result).toBeNull();
});

it("delivers stored reconciliation with uncertain native read intact", async () => {
  const { ledger, local } = setup();
  const request = clone(wireFixtures.bases.read);
  const terminal = clone(wireFixtures.bases.readReply);
  const admission = deliveryRequest("readAdmit");
  const accepted = {
    version: 1,
    kind: "recordingAdmissionReply",
    request: clone(admission),
    outcome: {
      kind: "accepted",
      handle: {
        kind: "reconciliation",
        readRef: request.target.readRef,
        request: clone(request.target.request),
      },
    },
  };
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  const pair = take(ledger.beginObservation(target, request));
  const handle = take(local.watchObservationQuery(pair.query));
  expect(ledger.acceptObservation(pair.attempt, terminal).ok).toBe(true);
  expect(take(local.pump()).delivered).toBe(1);
  const delivered = await handle.completion;
  expect(delivered).toBe(take(ledger.observation(pair.query)).terminal);
  expect(delivered.outcome.kind).toBe("reconciliation");
  if (delivered.outcome.kind !== "reconciliation")
    throw Error("reconciliation");
  expect(delivered.outcome.delivery.outcome.kind).toBe("result");
  if (delivered.outcome.delivery.outcome.kind !== "result")
    throw Error("result");
  expect(delivered.outcome.delivery.outcome.result.quiescence).toBe("unknown");
  expect(delivered.outcome.delivery.outcome.result.recoveryRequired).toBe(true);
});

it("rejects structural sources, wrappers and proxies", () => {
  const real = makeDelivery(),
    receiver = makeReceiver();
  const fake = {
    current: () => real.current(),
    original: () => ({ ok: true, value: { request: {}, terminal: {} } }),
  };
  expect(createRecordingWireLocalV2(fake as any, receiver)).toMatchObject({
    ok: false,
    reason: "invalidSource",
  });
  expect(
    createRecordingWireLocalV2(new Proxy(real, {}), receiver),
  ).toMatchObject({ ok: false, reason: "invalidSource" });
  expect(createRecordingWireLocalV2(real, { ...receiver })).toMatchObject({
    ok: false,
    reason: "invalidSource",
  });
});

it("names the native port's delivery by mode and rejects other options", () => {
  expect(setup().local.mode).toBe("testOnly");
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const native = take(
    createRecordingWireLocalV2(ledger, receiver, { mode: "native" }),
  );
  expect(native.mode).toBe("native");
  expect(native.current()).toMatchObject({
    mode: "native",
    usage: { maxHandles: 256 },
  });
  for (const options of [
    { mode: "other" },
    { mode: "native", extra: 1 },
    {},
    { maxHandles: 257, mode: "native" },
  ])
    expect(
      createRecordingWireLocalV2(ledger, receiver, options as never),
    ).toMatchObject({ ok: false, reason: "invalidOptions" });
});
