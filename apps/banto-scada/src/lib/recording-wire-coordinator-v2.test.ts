import { expect, it } from "vitest";
import {
  createRecordingWireCoordinatorV2,
  createTestTransportPortV2,
  type CoordinatorResult,
} from "./recording-wire-coordinator-v2";
import { createRecordingWireLocalV2 } from "./recording-wire-local-v2";
import {
  makeDelivery,
  deliveryFixtures,
  deliveryRequest,
  deliveryReply,
  deliveryQuery,
  deliveryInspection,
  cloneDelivery as clone,
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
  coordinatorV2Cases,
  runCoordinatorV2Scenario,
} from "./__fixtures__/recording-wire-coordinator-v2-cases";

for (const scenario of coordinatorV2Cases.scenarios)
  it(`shared coordinator-v2 scenario: ${scenario.name}`, async () => {
    expect((await runCoordinatorV2Scenario(scenario)).tracks).toBe(1);
  });

function take<T>(
  r:
    | CoordinatorResult<T>
    | { ok: true; value: T }
    | { ok: false; reason: string },
): T {
  if (!r.ok) throw Error(r.reason);
  return r.value;
}
function setup(
  options?: { maxTracks?: number; maxAttempts?: number },
  localLimit?: number,
) {
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const local = take(
    createRecordingWireLocalV2(
      ledger,
      receiver,
      localLimit === undefined ? undefined : { maxHandles: localLimit },
    ),
  );
  const port = take(createTestTransportPortV2(deliveryFixtures.scope));
  const root = take(
    createRecordingWireCoordinatorV2(ledger, receiver, local, port, options),
  );
  return { ledger, receiver, local, port, root };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

it("separates exact original reply from an unfinished transport attempt", async () => {
  const { ledger, root, port } = setup();
  const request = deliveryRequest("lease"),
    token = take(ledger.beginOriginal(request));
  const track = take(root.track("original", token));
  expect(take(root.track("original", token))).toBe(track);
  const ticket = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, ticket));
  expect(take(root.reserveAttempt(track, ticket))).toBe(attempt);
  expect(root.markStarted(attempt).ok).toBe(true);
  expect(ledger.acceptOriginal(token, deliveryReply(request)).ok).toBe(true);
  take(root.pump());
  await flush();
  const state = root.current().tracks[0];
  expect(state.delivery).toBe("delivered");
  expect(state.reply).toBe(take(ledger.original(token)).terminal);
  expect(state.attempt?.status).toBe("inFlight");
  expect(port.finish(ticket, "returned").ok).toBe(true);
  await flush();
  expect(root.current().tracks[0].attempt?.status).toBe("returned");
  expect(root.current().tracks[0].reply).toBe(state.reply);
});

it("keeps reply pending when the transport rejects first, and accepts a later reply", async () => {
  const { ledger, root, port } = setup();
  const request = deliveryRequest("lease"),
    token = take(ledger.beginOriginal(request));
  const track = take(root.track("original", token));
  const ticket = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, ticket));
  take(root.markStarted(attempt));
  take(port.finish(ticket, "rejected"));
  await flush();
  expect(root.current().tracks[0]).toMatchObject({
    delivery: "pending",
    attempt: { status: "rejected" },
  });
  expect(ledger.acceptOriginal(token, deliveryReply(request)).ok).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[0]).toMatchObject({
    delivery: "delivered",
    attempt: { status: "rejected" },
  });
});

it("refuses a ticket ended before start even before its Promise callback runs", async () => {
  const { ledger, root, port } = setup();
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  const track = take(root.track("original", token));
  const ticket = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, ticket));
  take(port.finish(ticket, "returned"));
  expect(root.markStarted(attempt)).toMatchObject({
    ok: false,
    reason: "endedBeforeStart",
  });
  await flush();
  expect(root.current().tracks[0].attempt).toMatchObject({
    status: "reserved",
    endedBeforeStart: true,
  });
});

it("preserves an in-flight attempt after a synchronous dispatch fault until its own late end", async () => {
  const { ledger, root, port } = setup();
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  const track = take(root.track("original", token));
  const ticket = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, ticket));
  take(root.markStarted(attempt));
  try {
    throw Error("simulated synchronous dispatch fault");
  } catch {
    /* task may still be running */
  }
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  take(port.finish(ticket, "rejected"));
  await flush();
  expect(root.current().tracks[0].attempt?.status).toBe("rejected");
  expect(root.current().tracks[0].delivery).toBe("pending");
});

it("keeps Admission unknown unchanged beside a later AdmissionInspection found accepted", async () => {
  const { ledger, root, port } = setup();
  const admission = deliveryRequest("admit"),
    original = take(ledger.beginOriginal(admission));
  const first = take(root.track("original", original));
  const ticket = take(port.issue("original", first.request));
  take(root.markStarted(take(root.reserveAttempt(first, ticket))));
  expect(
    ledger.acceptOriginal(original, deliveryReply(admission, "unknown")).ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  const inspectionRequest = deliveryRequest("inspect");
  const inspection = take(ledger.beginOriginal(inspectionRequest));
  const second = take(root.track("original", inspection));
  expect(
    ledger.acceptOriginal(
      inspection,
      deliveryReply(inspectionRequest, "foundAccepted"),
    ).ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect((root.current().tracks[0].reply as any).outcome.kind).toBe("unknown");
  expect((root.current().tracks[1].reply as any).outcome.kind).toBe("found");
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  expect(root.current().tracks[1].attempt).toBeNull();
});

it("keeps a CallInspection attempt reply separate from the original terminal and its task", async () => {
  const { ledger, root, port } = setup();
  const request = deliveryRequest("lease"),
    original = take(ledger.beginOriginal(request));
  const originalTrack = take(root.track("original", original));
  const originalTicket = take(port.issue("original", originalTrack.request));
  take(
    root.markStarted(take(root.reserveAttempt(originalTrack, originalTicket))),
  );
  const inspectRequest = deliveryQuery(request);
  const pair = take(ledger.beginInspection(original, inspectRequest));
  const inspection = take(root.track("inspectionAttempt", pair.attempt));
  const inspectionTicket = take(
    port.issue("inspectionAttempt", inspection.request),
  );
  take(
    root.markStarted(take(root.reserveAttempt(inspection, inspectionTicket))),
  );
  expect(
    ledger.acceptInspection(
      pair.attempt,
      deliveryInspection(inspectRequest, "pending"),
    ).ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[0].delivery).toBe("pending");
  expect((root.current().tracks[1].reply as any).outcome.kind).toBe("pending");
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  const second = take(ledger.repeatInspection(pair.query));
  const next = take(root.track("inspectionAttempt", second));
  expect(
    ledger.acceptInspection(
      second,
      deliveryInspection(inspectRequest, "terminal", deliveryReply(request)),
    ).ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[0].reply).toBe(
    take(ledger.original(original)).terminal,
  );
  expect((root.current().tracks[2].reply as any).outcome.kind).toBe("terminal");
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  expect(root.current().tracks[1].attempt?.status).toBe("inFlight");
  expect(next).not.toBe(inspection);
});

it("tracks Attach and Control terminal without turning display status into task completion", async () => {
  const { receiver, root, port } = setup();
  take(receiver.setConnected(true));
  const request = receiverAttachRequest(),
    generation = take(receiver.beginAttach(request));
  const attach = take(root.track("attach", generation));
  const ticket = take(port.issue("attach", attach.request));
  take(root.markStarted(take(root.reserveAttempt(attach, ticket))));
  expect(
    receiver.acceptAttach(generation, receiverAttachReply(request)).ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[0].delivery).toBe("delivered");
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  expect(root.current().display).toBe(receiver.currentDisplay());
  const controlRequest = receiverControlRequest(),
    control = take(receiver.beginControl(generation, controlRequest));
  const controlTrack = take(root.track("control", control));
  expect(
    receiver.acceptControlReply(control, receiverControlReply(controlRequest))
      .ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[1].delivery).toBe("delivered");
  expect(root.current().tracks[1].attempt).toBeNull();
});

it("keeps Observation pending attempt separate from its query and refuses direct query transport", async () => {
  const { ledger, root, port } = setup();
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
  const attemptTrack = take(root.track("observationAttempt", pair.attempt));
  const queryTrack = take(root.track("observationQuery", pair.query));
  const ticket = take(port.issue("observationAttempt", attemptTrack.request));
  const attempt = take(root.reserveAttempt(attemptTrack, ticket));
  expect(root.reserveAttempt(queryTrack, ticket)).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  take(root.markStarted(attempt));
  const pending = {
    version: 1,
    kind: "recordingWireObservationReply",
    request: clone(request),
    outcome: { kind: "pending" },
  };
  expect(ledger.acceptObservation(pair.attempt, pending).ok).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[0].delivery).toBe("delivered");
  expect(root.current().tracks[1].delivery).toBe("pending");
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
  const next = take(ledger.repeatObservation(pair.query));
  const nextTrack = take(root.track("observationAttempt", next));
  expect(nextTrack).not.toBe(attemptTrack);
  expect(
    ledger.acceptObservation(next, clone(wireFixtures.bases.observationReply))
      .ok,
  ).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current().tracks[1].delivery).toBe("delivered");
  expect((root.current().tracks[1].reply as any).outcome.kind).toBe(
    "operation",
  );
  expect(root.current().tracks[0].attempt?.status).toBe("inFlight");
});

it("separates capacity and retains an existing track when attempt reservation fails", () => {
  const { ledger, root, port } = setup({ maxTracks: 1, maxAttempts: 0 });
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  const track = take(root.track("original", token));
  const before = root.current();
  expect(
    root.reserveAttempt(track, take(port.issue("original", track.request))),
  ).toMatchObject({ ok: false, reason: "capacity" });
  expect(root.current()).toBe(before);
  const other = take(ledger.beginOriginal(deliveryRequest("cancel")));
  expect(root.track("original", other)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(root.track("original", {})).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(root.current().usage).toMatchObject({ tracks: 1, attempts: 0 });
});

it("keeps coordinator state unchanged when local-v2 runs out of handles", () => {
  const { ledger, root } = setup(undefined, 0);
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  const before = root.current();
  expect(root.track("original", token)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(root.current()).toBe(before);
});

it("rejects another ticket for one track, duplicate starts and foreign tickets", () => {
  const { ledger, root, port } = setup();
  const token = take(ledger.beginOriginal(deliveryRequest("lease")));
  const track = take(root.track("original", token));
  const first = take(port.issue("original", track.request));
  const second = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, first));
  expect(root.reserveAttempt(track, second)).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  const otherPort = take(createTestTransportPortV2(deliveryFixtures.scope));
  const foreign = take(otherPort.issue("original", track.request));
  expect(root.reserveAttempt(track, foreign)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  take(root.markStarted(attempt));
  expect(root.markStarted(attempt)).toMatchObject({
    ok: false,
    reason: "alreadyStarted",
  });
});

it("rejects root recreation by either source identity and preserves a failed factory retry", () => {
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const local = take(createRecordingWireLocalV2(ledger, receiver));
  const port = take(createTestTransportPortV2(deliveryFixtures.scope));
  expect(
    createRecordingWireCoordinatorV2(ledger, receiver, local, port, {
      maxTracks: -1,
    }),
  ).toMatchObject({ ok: false, reason: "invalidSource" });
  const root = take(
    createRecordingWireCoordinatorV2(ledger, receiver, local, port),
  );
  const secondLocal = take(createRecordingWireLocalV2(ledger, receiver));
  expect(
    createRecordingWireCoordinatorV2(
      ledger,
      receiver,
      secondLocal,
      take(createTestTransportPortV2(deliveryFixtures.scope)),
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
  const anotherLedger = makeDelivery(),
    anotherLocal = take(createRecordingWireLocalV2(anotherLedger, receiver));
  expect(
    createRecordingWireCoordinatorV2(
      anotherLedger,
      receiver,
      anotherLocal,
      take(createTestTransportPortV2(deliveryFixtures.scope)),
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
  take(root.close());
  expect(
    createRecordingWireCoordinatorV2(
      ledger,
      receiver,
      secondLocal,
      take(createTestTransportPortV2(deliveryFixtures.scope)),
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
});

it("rejects mismatched epoch and structural sources", () => {
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const local = take(createRecordingWireLocalV2(ledger, receiver));
  const changed = { ...deliveryFixtures.scope, ownerEpoch: "new-epoch" };
  const wrongPort = take(createTestTransportPortV2(changed));
  expect(
    createRecordingWireCoordinatorV2(ledger, receiver, local, wrongPort),
  ).toMatchObject({ ok: false, reason: "scopeMismatch" });
  const wrongReceiver = take(createRecordingWireReceiver(changed));
  expect(
    createRecordingWireCoordinatorV2(
      ledger,
      wrongReceiver,
      local,
      take(createTestTransportPortV2(deliveryFixtures.scope)),
    ),
  ).toMatchObject({ ok: false, reason: "invalidSource" });
  expect(
    createRecordingWireCoordinatorV2(
      ledger,
      receiver,
      { ...local },
      take(createTestTransportPortV2(deliveryFixtures.scope)),
    ),
  ).toMatchObject({ ok: false, reason: "invalidSource" });
});

it("guards test port issue before reading a hostile request and recovers after throw", () => {
  const port = take(createTestTransportPortV2(deliveryFixtures.scope, 1));
  let nested: unknown;
  const reentrant = new Proxy(deliveryRequest("lease"), {
    getPrototypeOf(target) {
      nested = port.issue("original", deliveryRequest("lease"));
      return Reflect.getPrototypeOf(target);
    },
  });
  const ticket = take(port.issue("original", reentrant));
  expect(nested).toMatchObject({ ok: false, reason: "busy" });
  expect(port.issue("original", deliveryRequest("lease"))).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(port.inspect(ticket)?.status).toBe("issued");

  const other = take(createTestTransportPortV2(deliveryFixtures.scope, 2));
  const first = take(other.issue("original", deliveryRequest("lease")));
  let nestedFinish: unknown;
  const hostile = new Proxy(deliveryRequest("lease"), {
    getPrototypeOf() {
      nestedFinish = other.finish(first, "returned");
      throw Error("hostile prototype");
    },
  });
  expect(other.issue("original", hostile)).toMatchObject({
    ok: false,
    reason: "invalidSource",
  });
  expect(nestedFinish).toMatchObject({ ok: false, reason: "busy" });
  expect(other.inspect(first)?.status).toBe("issued");
  expect(other.issue("original", deliveryRequest("lease")).ok).toBe(true);
});

it("records view retirement separately and still accepts late reply after close", async () => {
  const { ledger, root } = setup();
  const identity = {},
    view = take(root.bindView(identity));
  expect(take(root.bindView(identity))).toBe(view);
  expect(root.current().view).toBe("active");
  take(view.retire());
  expect(root.current().view).toBe("retired");
  const request = deliveryRequest("lease"),
    token = take(ledger.beginOriginal(request));
  const track = take(root.track("original", token));
  take(root.close());
  expect(root.track("original", token)).toMatchObject({
    ok: true,
    value: track,
  });
  expect(
    root.track(
      "original",
      take(ledger.beginOriginal(deliveryRequest("cancel"))),
    ),
  ).toMatchObject({ ok: false, reason: "closed" });
  expect(ledger.acceptOriginal(token, deliveryReply(request)).ok).toBe(true);
  take(root.pump());
  await flush();
  expect(root.current()).toMatchObject({
    closed: true,
    view: "retired",
    tracks: [{ delivery: "delivered" }],
  });
});
