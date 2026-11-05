import { it, expect } from "vitest";
import {
  makeDelivery,
  deliveryRequest as q,
  deliveryReply as reply,
  deliveryQuery as query,
  deliveryInspection as inspection,
  deliveryTake as take,
  deliveryFixtures,
  cloneDelivery as clone,
} from "./__fixtures__/recording-wire-delivery-ledger-cases";
import { Core, DEFAULT_LIMITS } from "./recording-wire-delivery-ledger/core";
import * as originals from "./recording-wire-delivery-ledger/original";
import * as inspections from "./recording-wire-delivery-ledger/inspection";
import { bytes } from "./recording-wire-delivery-ledger/validation";
import { parseRecordingWireAttachRequest } from "./recording-wire-contract";
import * as factory from "./recording-wire-delivery-ledger";
const outerMethods = [
  "beginOriginal",
  "acceptOriginal",
  "beginInspection",
  "acceptInspection",
] as const;
for (const outer of outerMethods)
  for (const trap of ["getPrototypeOf", "getOwnPropertyDescriptor"] as const)
    it(outer + " guards every nested mutation/getter before " + trap, () => {
      const l = makeDelivery(),
        request = q();
      let o: any,
        p: any = { query: {}, attempt: {} };
      if (outer !== "beginOriginal") o = take(l.beginOriginal(request));
      if (outer === "acceptOriginal" || outer === "acceptInspection")
        p = take(l.beginInspection(o, query(request)));
      const before = l.current();
      let invoked = 0;
      const forbidden = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error("nested input was inspected");
          },
          getPrototypeOf() {
            throw Error("nested input was inspected");
          },
          ownKeys() {
            throw Error("nested input was inspected");
          },
        },
      );
      const check = () => {
        invoked++;
        expect(l.current()).toBe(before);
        const calls = [
          () => l.beginOriginal(forbidden),
          () => l.acceptOriginal(o, forbidden),
          () => l.beginInspection(o, forbidden),
          () => l.repeatInspection(p.query),
          () => l.acceptInspection(p.attempt, forbidden),
          () => l.original(o),
          () => l.inspection(p.query),
          () => l.attempt(p.attempt),
          () => l.retire(),
          () => l.dispose(),
        ];
        for (const call of calls) {
          expect(call()).toMatchObject({ ok: false, reason: "busy" });
          expect(l.current()).toBe(before);
        }
      };
      const value =
        outer === "beginOriginal"
          ? request
          : outer === "acceptOriginal"
            ? reply(request)
            : outer === "beginInspection"
              ? query(request)
              : inspection(query(request), "terminal", reply(request));
      const input = new Proxy(
        value,
        trap === "getPrototypeOf"
          ? {
              getPrototypeOf(target) {
                check();
                return Reflect.getPrototypeOf(target);
              },
            }
          : {
              getOwnPropertyDescriptor(target, key) {
                check();
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
      );
      const result =
        outer === "beginOriginal"
          ? l.beginOriginal(input)
          : outer === "acceptOriginal"
            ? l.acceptOriginal(o, input)
            : outer === "beginInspection"
              ? l.beginInspection(o, input)
              : l.acceptInspection(p.attempt, input);
      expect(result.ok).toBe(true);
      expect(invoked).toBeGreaterThan(0);
      expect(l.current()).toMatchObject({
        retired: false,
        disposed: false,
        stoppedReason: null,
      });
      expect(l.retire().ok).toBe(true);
    });
it("throwing request traps release guard and never consume registration capacity", () => {
  const l = makeDelivery(),
    before = l.current();
  const input = new Proxy(q(), {
    ownKeys() {
      expect(l.current()).toBe(before);
      expect(l.dispose()).toEqual({ ok: false, reason: "busy" });
      throw Error("private error");
    },
  });
  expect(l.beginOriginal(input)).toEqual({
    ok: false,
    reason: "invalidRequest",
  });
  expect(l.current()).toBe(before);
  expect(l.beginOriginal(q()).ok).toBe(true);
});
it("accessor and throwing reply traps preserve pending until normal late delivery", () => {
  const l = makeDelivery(),
    request = q(),
    o = take(l.beginOriginal(request)),
    p = take(l.beginInspection(o, query(request))),
    before = l.current();
  let getter = 0;
  const bad = Object.defineProperty(inspection(query(request)), "outcome", {
    enumerable: true,
    get() {
      getter++;
      throw Error("private");
    },
  });
  expect(l.acceptInspection(p.attempt, bad)).toEqual({
    ok: false,
    reason: "invalidDocument",
    terminalStored: false,
    attemptStored: false,
  });
  expect(getter).toBe(0);
  expect(take(l.attempt(p.attempt)).reply).toBeNull();
  expect(l.current().usage).toEqual(before.usage);
  expect(
    l.acceptInspection(
      p.attempt,
      inspection(query(request), "terminal", reply(request)),
    ),
  ).toMatchObject({
    ok: true,
    value: { terminalStored: true, attemptStored: true },
  });
  expect(take(l.original(o)).terminal).toEqual(reply(request));
});
function internal() {
  const scope = parseRecordingWireAttachRequest({
    version: 1,
    kind: "recordingWireAttachRequest",
    scope: deliveryFixtures.scope,
    attachId: "validation",
    afterRevision: null,
  }).scope;
  return new Core(scope, DEFAULT_LIMITS);
}
// Deliberately inject a corrupted private reservation: these inequalities cannot
// be exceeded by legal closed-schema replies when the upper-bound proof holds.
it("original reply must satisfy the reserved R as well as the independent root budget", () => {
  const c = internal(),
    request = q(),
    o = take(originals.begin(c, request)),
    record = c.lookup(c.originalTokens, o)!;
  record.R = bytes(reply(request)) - 1;
  const before = c.view();
  expect(originals.accept(c, o, reply(request))).toEqual({
    ok: false,
    reason: "invalidDocument",
    terminalStored: false,
    attemptStored: false,
  });
  expect(record.terminal).toBeNull();
  expect(c.view().usage).toEqual(before.usage);
});
it("query I underflow refuses credit migration atomically", () => {
  const c = internal(),
    request = q(),
    o = take(originals.begin(c, request)),
    record = c.lookup(c.originalTokens, o)!;
  record.I = bytes(query(request)) - 1;
  const before = c.view();
  expect(inspections.begin(c, o, query(request))).toEqual({
    ok: false,
    reason: "invalidRequest",
  });
  expect(c.view()).toEqual(before);
  expect(record.credit).toBe(true);
});
it("inspection echoed I underflow is rejected before storing its normal reply", () => {
  const c = internal(),
    request = q(),
    o = take(originals.begin(c, request)),
    p = take(inspections.begin(c, o, query(request))),
    record = c.lookup(c.queryTokens, p.query)!;
  record.I = bytes(query(request)) - 1;
  const before = c.view();
  expect(inspections.accept(c, p.attempt, inspection(query(request)))).toEqual({
    ok: false,
    reason: "invalidDocument",
    terminalStored: false,
    attemptStored: false,
  });
  expect(c.lookup(c.attemptTokens, p.attempt)!.outcome).toBeNull();
  expect(c.view().usage).toEqual(before.usage);
});
it("inspection R underflow leaves the original and attempt uncollected", () => {
  const c = internal(),
    request = q(),
    o = take(originals.begin(c, request)),
    p = take(inspections.begin(c, o, query(request))),
    record = c.lookup(c.attemptTokens, p.attempt)!;
  record.R = bytes(reply(request)) - 1;
  const before = c.view();
  expect(
    inspections.accept(
      c,
      p.attempt,
      inspection(query(request), "terminal", reply(request)),
    ),
  ).toEqual({
    ok: false,
    reason: "invalidDocument",
    terminalStored: false,
    attemptStored: false,
  });
  expect(record.outcome).toBeNull();
  expect(c.lookup(c.originalTokens, o)!.terminal).toBeNull();
  expect(c.view().usage).toEqual(before.usage);
});
it("a maximum length query ID and escaped UTF-8 scope fit the independent first credit", () => {
  const scope = clone(deliveryFixtures.scope);
  scope.context.target.projectId = '日本語😀\r\n"\\';
  const request = q();
  request.scope = clone(scope);
  const { createRecordingWireDeliveryLedger } = factory,
    made = createRecordingWireDeliveryLedger(scope);
  if (!made.ok) throw Error();
  const l = made.value,
    o = take(l.beginOriginal(request));
  const iq = {
    version: 1,
    kind: "recordingWireCallInspectionRequest",
    scope: clone(scope),
    callInspectionId: "z".repeat(64),
    original: clone(request),
  };
  const before = l.current().usage.readBytes,
    p = take(l.beginInspection(o, iq));
  expect(l.current().usage.readBytes).toBe(before);
  take(
    l.acceptInspection(p.attempt, inspection(iq, "terminal", reply(request))),
  );
  expect(take(l.original(o)).terminal).toEqual(reply(request));
});
