import { expect, it } from "vitest";
import {
  createRecordingWireDeliveryLedger,
  type WireDeliveryLedger,
} from "./recording-wire-delivery-ledger";
import {
  deliveryFixtures,
  deliveryRequest,
  deliveryTake as take,
  cloneDelivery as clone,
  frozenDelivery,
} from "./__fixtures__/recording-wire-delivery-ledger-cases";
import { wireFixtures } from "./__fixtures__/recording-wire-cases";
import { recordingWireReplyCapacity } from "./recording-wire-contract";
import { measureWire, wireProfile } from "./recording-wire/budget";
import {
  observationLedgerCases,
  runObservationLedgerScenario,
} from "./__fixtures__/recording-wire-observation-ledger-cases";

for (const scenario of observationLedgerCases.scenarios)
  it(`shared Observation scenario: ${scenario.name}`, () => {
    expect(runObservationLedgerScenario(scenario).attempts).toBe(
      scenario.steps.length,
    );
  });

function setup(
  options?: Parameters<typeof createRecordingWireDeliveryLedger>[1],
) {
  const created = createRecordingWireDeliveryLedger(
    deliveryFixtures.scope,
    options,
  );
  if (!created.ok) throw Error(created.reason);
  const ledger = created.value;
  const observation = clone(wireFixtures.bases.observe);
  const terminal = clone(wireFixtures.bases.observationReply);
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
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  return {
    ledger,
    admission,
    accepted,
    original,
    target,
    observation,
    terminal,
  };
}
function response(request: any, outcome: any) {
  return {
    version: 1,
    kind: "recordingWireObservationReply",
    request: clone(request),
    outcome: clone(outcome),
  };
}
function query(
  ledger: WireDeliveryLedger,
  target: ReturnType<typeof setup>["target"],
  request: any,
) {
  return take(ledger.beginObservation(target, request));
}

it("binds only stored Accepted evidence and shares exact target", () => {
  const { ledger, original, target, accepted, admission, observation } =
    setup();
  expect(take(ledger.bindObservationTarget(original))).toBe(target);
  expect(take(ledger.observationTarget(target))).toMatchObject({
    admission,
    accepted: accepted.outcome.handle,
    target: observation.target,
    result: null,
  });
  expect(frozenDelivery(take(ledger.observationTarget(target)))).toBe(true);
  expect(ledger.bindObservationTarget({} as typeof original)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  const other = setup().ledger;
  expect(other.observationTarget(target)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
});

it("binds a found inspection without rewriting an unknown original", () => {
  const { admission, accepted } = setup();
  const made = createRecordingWireDeliveryLedger(deliveryFixtures.scope);
  if (!made.ok) throw Error(made.reason);
  const ledger = made.value;
  const original = take(ledger.beginOriginal(admission));
  const unknown = {
    version: 1,
    kind: "recordingAdmissionReply",
    request: clone(admission),
    outcome: clone(deliveryFixtures.replyOutcomes.unknown),
  };
  expect(ledger.acceptOriginal(original, unknown).ok).toBe(true);
  expect(ledger.bindObservationTarget(original)).toMatchObject({
    ok: false,
    reason: "invalidRequest",
  });
  const inspectionRequest = {
    version: 1,
    kind: "recordingAdmissionInspectionRequest",
    inspectionId: "inspection:accepted",
    original: clone(admission),
  };
  const inspectionToken = take(ledger.beginOriginal(inspectionRequest));
  const inspectionReply = {
    version: 1,
    kind: "recordingAdmissionInspectionReply",
    request: clone(inspectionRequest),
    outcome: { kind: "found", reply: clone(accepted) },
  };
  expect(ledger.acceptOriginal(inspectionToken, inspectionReply).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(inspectionToken));
  expect(take(ledger.bindObservationTarget(inspectionToken))).toBe(target);
  expect(take(ledger.original(inspectionToken)).learnedBy).toBe("direct");
  expect(take(ledger.original(original)).terminal).toEqual(unknown);
  expect(take(ledger.original(original)).learnedBy).toBe("direct");
});

it("refuses unknown admission and conflicting accepted refs", () => {
  const { ledger, observation } = setup();
  const unknown = deliveryRequest("admit");
  unknown.admissionId = "admit:unknown";
  const unknownToken = take(ledger.beginOriginal(unknown));
  expect(
    ledger.acceptOriginal(unknownToken, {
      version: 1,
      kind: "recordingAdmissionReply",
      request: clone(unknown),
      outcome: clone(deliveryFixtures.replyOutcomes.unknown),
    }).ok,
  ).toBe(true);
  expect(ledger.bindObservationTarget(unknownToken)).toMatchObject({
    ok: false,
    reason: "invalidRequest",
  });

  const admission = deliveryRequest("admit");
  admission.admissionId = "admit:collision";
  admission.action = {
    kind: "apply",
    changeRef: "change-ref",
    operation: clone(observation.target.request),
  };
  const original = take(ledger.beginOriginal(admission));
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
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  expect(ledger.bindObservationTarget(original)).toMatchObject({
    ok: false,
    reason: "protocolViolation",
  });
  expect(ledger.current().stoppedReason).toBe("protocolViolation");
});

it("keeps query identity, target scope and unknown references separate", () => {
  const { ledger, target, observation } = setup();
  const first = query(ledger, target, observation);
  const changed = {
    ...observation,
    target: { ...observation.target, operationRef: "other" },
  };
  expect(ledger.beginObservation(target, changed)).toMatchObject({
    ok: false,
    reason: "protocolViolation",
  });
  expect(take(ledger.observation(first.query)).request).toEqual(observation);
  expect(ledger.current().stoppedReason).toBe("protocolViolation");
  const clean = setup();
  expect(
    clean.ledger.beginObservation(clean.target, {
      ...clean.observation,
      scope: { ...clean.observation.scope, ownerEpoch: "other" },
    }),
  ).toMatchObject({ ok: false, reason: "invalidRequest" });
  expect(
    clean.ledger.beginObservation(clean.target, {
      ...clean.observation,
      target: { ...clean.observation.target, operationRef: "unknown" },
    }),
  ).toMatchObject({ ok: false, reason: "invalidRequest" });
});

it("records reconciliation delivery independently of operation results", () => {
  const created = createRecordingWireDeliveryLedger(deliveryFixtures.scope);
  if (!created.ok) throw Error(created.reason);
  const ledger = created.value;
  const admission = deliveryRequest("readAdmit");
  const observation = clone(wireFixtures.bases.read);
  const terminal = clone(wireFixtures.bases.readReply);
  const accepted = {
    version: 1,
    kind: "recordingAdmissionReply",
    request: clone(admission),
    outcome: {
      kind: "accepted",
      handle: {
        kind: "reconciliation",
        readRef: observation.target.readRef,
        request: clone(observation.target.request),
      },
    },
  };
  const original = take(ledger.beginOriginal(admission));
  expect(ledger.acceptOriginal(original, accepted).ok).toBe(true);
  const target = take(ledger.bindObservationTarget(original));
  const pair = query(ledger, target, observation);
  expect(ledger.acceptObservation(pair.attempt, terminal)).toMatchObject({
    ok: true,
    value: { targetResultStored: true },
  });
  expect(take(ledger.observationTarget(target)).result).toEqual(
    terminal.outcome.delivery,
  );
});

it("holds a lost attempt; pending reply permits one explicit repeat and terminal is immutable", () => {
  const { ledger, target, observation, terminal } = setup();
  const pair = query(ledger, target, observation);
  expect(ledger.beginObservation(target, clone(observation))).toEqual({
    ok: true,
    value: pair,
  });
  expect(ledger.repeatObservation(pair.query)).toMatchObject({
    ok: false,
    reason: "busy",
  });
  const pending = response(observation, { kind: "pending" });
  expect(ledger.acceptObservation(pair.attempt, pending)).toMatchObject({
    ok: true,
    value: {
      disposition: "stored",
      attemptStored: true,
      queryTerminalStored: false,
      targetResultStored: false,
    },
  });
  expect(take(ledger.observation(pair.query)).terminal).toBeNull();
  const second = take(ledger.repeatObservation(pair.query));
  expect(second).not.toBe(pair.attempt);
  expect(ledger.acceptObservation(second, terminal)).toMatchObject({
    ok: true,
    value: {
      disposition: "stored",
      attemptStored: true,
      queryTerminalStored: true,
      targetResultStored: true,
    },
  });
  expect(ledger.acceptObservation(second, clone(terminal))).toMatchObject({
    ok: true,
    value: {
      disposition: "duplicate",
      attemptStored: true,
      queryTerminalStored: true,
      targetResultStored: true,
    },
  });
  expect(take(ledger.observation(pair.query)).terminal).toEqual(terminal);
  expect(take(ledger.observationAttempt(pair.attempt)).reply).toEqual(pending);
  expect(take(ledger.observationTarget(target)).result).toEqual(
    terminal.outcome.result,
  );
  expect(ledger.current().usage).toMatchObject({
    awaitingObservationReply: 0,
    pendingObservationQueries: 0,
    observationAttempts: 2,
  });
  expect(frozenDelivery(take(ledger.observationAttempt(second)))).toBe(true);
});

it("keeps unavailable terminal for its ID and accepts another ID", () => {
  const { ledger, target, observation } = setup();
  const first = query(ledger, target, observation);
  const unavailable = response(observation, {
    kind: "unavailable",
    error: "ownerUnavailable",
  });
  expect(ledger.acceptObservation(first.attempt, unavailable)).toMatchObject({
    ok: true,
    value: { queryTerminalStored: true, targetResultStored: false },
  });
  expect(ledger.repeatObservation(first.query)).toMatchObject({
    ok: false,
    reason: "busy",
  });
  const next = { ...observation, observationId: "next" };
  const second = query(ledger, target, next);
  expect(second.query).not.toBe(first.query);
  expect(take(ledger.observationTarget(target)).result).toBeNull();
});

it("does not turn a saved pending attempt into a terminal reply", () => {
  const { ledger, target, observation, terminal } = setup();
  const pair = query(ledger, target, observation);
  const pending = response(observation, { kind: "pending" });
  expect(ledger.acceptObservation(pair.attempt, pending).ok).toBe(true);
  expect(ledger.acceptObservation(pair.attempt, terminal)).toMatchObject({
    ok: false,
    reason: "protocolViolation",
    attemptStored: false,
  });
  expect(take(ledger.observationAttempt(pair.attempt)).reply).toEqual(pending);
  expect(take(ledger.observation(pair.query)).terminal).toBeNull();
});

it("malformed reply retains the physical attempt slot and stops new reads", () => {
  const { ledger, target, observation } = setup();
  const pair = query(ledger, target, observation);
  const malformed = response(observation, {
    kind: "unavailable",
    error: "not-an-error",
  });
  expect(ledger.acceptObservation(pair.attempt, malformed)).toMatchObject({
    ok: false,
    reason: "invalidDocument",
    attemptStored: false,
  });
  expect(ledger.current()).toMatchObject({
    stoppedReason: "invalidDocument",
    usage: { awaitingObservationReply: 1, pendingObservationQueries: 1 },
  });
  expect(ledger.repeatObservation(pair.query)).toMatchObject({
    ok: false,
    reason: "protocolViolation",
  });
  expect(
    ledger.acceptObservation(
      pair.attempt,
      response(observation, { kind: "pending" }),
    ).ok,
  ).toBe(true);
  expect(ledger.current().usage.awaitingObservationReply).toBe(0);
});

it("guards nested calls before parsing and publishes only the committed view", () => {
  const { ledger, target, observation } = setup();
  const pair = query(ledger, target, observation);
  const before = ledger.current();
  let traps = 0;
  const incoming = new Proxy(response(observation, { kind: "pending" }), {
    getOwnPropertyDescriptor(object, key) {
      traps++;
      expect(ledger.current()).toBe(before);
      expect(ledger.observation(pair.query)).toMatchObject({
        ok: false,
        reason: "busy",
      });
      expect(ledger.repeatObservation(pair.query)).toMatchObject({
        ok: false,
        reason: "busy",
      });
      expect(ledger.acceptObservation(pair.attempt, object)).toMatchObject({
        ok: false,
        reason: "busy",
      });
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  expect(ledger.acceptObservation(pair.attempt, incoming).ok).toBe(true);
  expect(traps).toBeGreaterThan(0);
  expect(ledger.current()).not.toBe(before);
  const after = ledger.current();
  for (let i = 0; i < 100; i++) ledger.observationAttempt(pair.attempt);
  expect(ledger.current()).toBe(after);
});

it("restores the guard after a hostile begin request throws", () => {
  const { ledger, target, observation } = setup();
  const before = ledger.current();
  let traps = 0;
  const hostile = new Proxy(observation, {
    getPrototypeOf() {
      traps++;
      expect(ledger.current()).toBe(before);
      expect(ledger.beginObservation(target, observation)).toMatchObject({
        ok: false,
        reason: "busy",
      });
      expect(ledger.observationTarget(target)).toMatchObject({
        ok: false,
        reason: "busy",
      });
      throw Error("hostile");
    },
  });
  expect(ledger.beginObservation(target, hostile)).toMatchObject({
    ok: false,
    reason: "invalidRequest",
  });
  expect(traps).toBeGreaterThan(0);
  expect(ledger.current()).toBe(before);
  expect(ledger.beginObservation(target, observation).ok).toBe(true);
});

it("retire and dispose retain exact records and late normal reply", () => {
  const { ledger, target, observation } = setup();
  const first = query(ledger, target, observation);
  take(ledger.retire());
  expect(
    ledger.acceptObservation(
      first.attempt,
      response(observation, { kind: "pending" }),
    ).ok,
  ).toBe(true);
  const another = { ...observation, observationId: "another" };
  const second = query(ledger, target, another);
  take(ledger.dispose());
  expect(
    ledger.beginObservation(target, { ...observation, observationId: "new" }),
  ).toMatchObject({ ok: false, reason: "disposed" });
  expect(
    ledger.acceptObservation(
      second.attempt,
      response(another, { kind: "unavailable", error: "ownerUnavailable" }),
    ).ok,
  ).toBe(true);
  expect(take(ledger.observation(second.query)).terminal?.outcome.kind).toBe(
    "unavailable",
  );
  expect(take(ledger.observation(first.query)).terminal).toBeNull();
});

it("reserves Observation bytes independently and one byte short is atomic", () => {
  const { observation } = setup();
  const p = wireProfile(observation.kind);
  const Q = measureWire(observation, p.limit, p.accounting).bytes;
  const R = recordingWireReplyCapacity(observation).reply.bytes;
  const exact = 1024 + Q + R + 2048;
  const { ledger, target } = setup({ observationBytes: exact });
  const beforeRead = ledger.current().usage.readBytes;
  query(ledger, target, observation);
  expect(ledger.current().usage).toMatchObject({
    observationBytes: exact,
    readBytes: beforeRead,
  });
  const short = setup({ observationBytes: exact - 1 });
  const before = short.ledger.current();
  expect(
    short.ledger.beginObservation(short.target, observation),
  ).toMatchObject({ ok: false, reason: "capacity" });
  expect(short.ledger.current()).toBe(before);
});

it("reserves repeat R and attempt ID before advancing the latest attempt", () => {
  const { observation } = setup();
  const p = wireProfile(observation.kind);
  const Q = measureWire(observation, p.limit, p.accounting).bytes;
  const R = recordingWireReplyCapacity(observation).reply.bytes;
  const exact = 1024 + Q + R + 2048 + R + 1024;
  const full = setup({ observationBytes: exact, observationAttempts: 2 });
  const first = query(full.ledger, full.target, full.observation);
  expect(
    full.ledger.acceptObservation(
      first.attempt,
      response(full.observation, { kind: "pending" }),
    ).ok,
  ).toBe(true);
  expect(full.ledger.repeatObservation(first.query).ok).toBe(true);
  expect(full.ledger.current().usage.observationBytes).toBe(exact);

  const short = setup({ observationBytes: exact - 1, observationAttempts: 2 });
  const pair = query(short.ledger, short.target, short.observation);
  expect(
    short.ledger.acceptObservation(
      pair.attempt,
      response(short.observation, { kind: "pending" }),
    ).ok,
  ).toBe(true);
  const before = short.ledger.current();
  expect(short.ledger.repeatObservation(pair.query)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  expect(short.ledger.current()).toBe(before);
  expect(take(short.ledger.observation(pair.query)).latestAttempt).toBe(
    pair.attempt,
  );

  const ids = setup({ observationAttempts: 1 });
  const idPair = query(ids.ledger, ids.target, ids.observation);
  expect(
    ids.ledger.acceptObservation(
      idPair.attempt,
      response(ids.observation, { kind: "pending" }),
    ).ok,
  ).toBe(true);
  expect(ids.ledger.repeatObservation(idPair.query)).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  const noQuery = setup({ observationQueries: 0 });
  expect(
    noQuery.ledger.beginObservation(noQuery.target, noQuery.observation),
  ).toMatchObject({ ok: false, reason: "capacity" });
  expect(() => setup({ observationTargets: 0 })).toThrow("capacity");
});

it("stores a normal attempt before conflicting target result and keeps the first result", () => {
  const { ledger, target, observation, terminal } = setup();
  const first = query(ledger, target, observation);
  expect(ledger.acceptObservation(first.attempt, terminal).ok).toBe(true);
  const next = { ...observation, observationId: "next" };
  const second = query(ledger, target, next);
  const conflicting = response(next, {
    kind: "operation",
    result: { ...terminal.outcome.result, recoveryRequired: true },
  });
  expect(ledger.acceptObservation(second.attempt, conflicting)).toMatchObject({
    ok: false,
    reason: "protocolViolation",
    attemptStored: true,
    queryTerminalStored: true,
    targetResultStored: false,
  });
  expect(take(ledger.observationTarget(target)).result).toEqual(
    terminal.outcome.result,
  );
  expect(take(ledger.observationAttempt(second.attempt)).reply).toEqual(
    conflicting,
  );
  expect(
    ledger.acceptObservation(second.attempt, clone(conflicting)),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "duplicate",
      attemptStored: true,
      queryTerminalStored: true,
      targetResultStored: false,
    },
  });
  expect(ledger.current().stoppedReason).toBe("protocolViolation");
});

it("shares the owned request and identical result across Observation IDs", () => {
  const { ledger, target, observation, terminal } = setup();
  const first = query(ledger, target, observation);
  expect(ledger.acceptObservation(first.attempt, terminal).ok).toBe(true);
  const another = { ...observation, observationId: "same-result" };
  const second = query(ledger, target, another);
  const sameReply = response(another, terminal.outcome);
  expect(ledger.acceptObservation(second.attempt, sameReply)).toMatchObject({
    ok: true,
    value: { targetResultStored: true },
  });
  const state = take(ledger.observation(second.query));
  const attempt = take(ledger.observationAttempt(second.attempt));
  const result = take(ledger.observationTarget(target)).result;
  expect(attempt.request).toBe(state.request);
  expect(attempt.reply?.request).toBe(state.request);
  expect(state.terminal?.outcome.kind).toBe("operation");
  if (state.terminal?.outcome.kind !== "operation") throw Error("operation");
  expect(state.terminal.outcome.result).toBe(result);
  expect(
    take(ledger.observationAttempt(first.attempt)).reply?.outcome,
  ).toMatchObject(terminal.outcome);
});
