import { it, expect } from "vitest";
import type { ReceiverResult } from "./recording-wire-receiver";
import {
  receiverReadoutFixtures,
  runReceiverScenario,
  makeReceiver,
  receiverFixtures as f,
  receiverAttachRequest as aq,
  receiverAttachReply as ar,
  receiverSnapshot as snap,
  receiverStateFrame as sf,
  receiverControlRequest as cq,
  receiverControlReply as cr,
  receiverControlFrame as cf,
  cloneReceiverJson as clone,
  deeplyFrozen,
} from "./__fixtures__/recording-wire-receiver-cases";
const take = <T>(r: ReceiverResult<T>): T => {
  if (!r.ok) throw Error(r.reason);
  return r.value;
};
function setup(attached = true) {
  const r = makeReceiver();
  take(r.setConnected(true));
  const g = take(r.beginAttach(aq()));
  if (attached) take(r.acceptAttach(g, ar(aq())));
  return { r, g };
}
for (const scenario of receiverReadoutFixtures.scenarios)
  it(scenario.name, () => runReceiverScenario(scenario));
it("publishes exactly the read-only display contract, never actions or clock freshness", () => {
  const r = makeReceiver(),
    v = r.currentDisplay();
  expect(v).toEqual({
    scope: f.scope,
    transportConnected: false,
    receiverStatus: "awaitingAttach",
    receiverStoppedReason: null,
    generation: null,
    ownerClosed: false,
    nativeRecoveryRequired: false,
    authorizationLost: false,
    highwater: null,
    snapshotRelation: "none",
    snapshot: null,
    usage: {
      attachIds: 0,
      controlIds: 0,
      snapshotRevisions: 0,
      snapshotBytes: 0,
      callBytes: 0,
      pendingAttach: 0,
      pendingControl: 0,
      stateSlot: 0,
      controlSlot: 0,
    },
  });
  expect(deeplyFrozen(v)).toBe(true);
  expect(r.currentDisplay()).toBe(v);
});
it("terminal request and reply are owned frozen references shared across reads", () => {
  const { r, g } = setup(false),
    pending = take(r.attachTerminal(g)),
    source = ar(aq());
  take(r.acceptAttach(g, source));
  source.request.scope.ownerEpoch = "changed";
  source.outcome.snapshot.closed = true;
  const first = take(r.attachTerminal(g)),
    second = take(r.attachTerminal(g));
  expect(pending.kind).toBe("pending");
  expect(first.kind).toBe("terminal");
  expect(first.request).toBe(pending.request);
  expect(first.request).toBe(second.request);
  if (first.kind !== "terminal" || second.kind !== "terminal") throw Error();
  expect(first.reply).toBe(second.reply);
  expect(first.reply.request.scope.ownerEpoch).toBe(f.scope.ownerEpoch);
  expect(first.reply.outcome).toMatchObject({ snapshot: { closed: false } });
  expect(deeplyFrozen(first)).toBe(true);
  const before = first.reply;
  take(r.acceptState(g, sf(snap(2))));
  expect(take(r.attachTerminal(g))).toMatchObject({ reply: before });
  expect(r.currentDisplay().snapshot?.revision).toBe(2);
});
it("control getter shares the original request and terminal without substituting latest", () => {
  const { r, g } = setup(),
    q = cq(),
    t = take(r.beginControl(g, q)),
    pending = take(r.controlTerminal(t));
  q.controlId = "changed";
  const reply = cr(cq());
  take(r.acceptControlReply(t, reply));
  reply.outcome.snapshot.ownerBlocked = true;
  take(r.acceptState(g, sf(snap(3))));
  const first = take(r.controlTerminal(t)),
    again = take(r.controlTerminal(t));
  expect(first.request).toBe(pending.request);
  expect(first.request.controlId).toBe("c");
  if (first.kind !== "terminal" || again.kind !== "terminal") throw Error();
  expect(first.reply).toBe(again.reply);
  expect(first.reply.outcome).toMatchObject({
    snapshot: { revision: 2, ownerBlocked: false },
  });
  expect(r.currentDisplay().snapshot?.revision).toBe(3);
});
it("foreign, wrong-kind, copied and hostile tokens are rejected without descriptor reads", () => {
  const a = setup(),
    b = setup(),
    c = take(a.r.beginControl(a.g, cq())),
    other = take(b.r.beginControl(b.g, cq()));
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw Error();
      },
    },
  );
  const before = a.r.current(),
    display = a.r.currentDisplay();
  for (const token of [
    b.g,
    other,
    {},
    clone(a.g),
    Object.create(a.g),
    hostile,
    null,
    "a",
    undefined,
  ]) {
    expect(a.r.attachTerminal(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
      terminalStored: false,
    });
    expect(a.r.controlTerminal(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
      terminalStored: false,
    });
  }
  expect(a.r.attachTerminal(c as any)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(a.r.controlTerminal(a.g as any)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(traps).toBe(0);
  expect(a.r.current()).toBe(before);
  expect(a.r.currentDisplay()).toBe(display);
  expect(take(a.r.controlTerminal(c)).kind).toBe("pending");
});
it("repeated reads preserve cache identity, capacity and unresolved original slots", () => {
  const r = makeReceiver({ snapshotRevisions: 0 });
  take(r.setConnected(true));
  const g = take(r.beginAttach(aq()));
  expect(r.acceptAttach(g, ar(aq()))).toMatchObject({
    ok: false,
    reason: "capacity",
    terminalStored: true,
  });
  const state = r.current(),
    view = r.currentDisplay(),
    first = take(r.attachTerminal(g));
  for (let n = 0; n < 1000; n++) {
    const value = take(r.attachTerminal(g));
    expect(value.kind).toBe("terminal");
    expect(value.request).toBe(first.request);
    expect(r.current()).toBe(state);
    expect(r.currentDisplay()).toBe(view);
  }
  expect(r.current().usage).toBe(state.usage);
  expect(r.current().usage.pendingAttach).toBe(0);
  expect(r.current().stoppedReason).toBe("capacity");
  const b = setup();
  const t = take(b.r.beginControl(b.g, cq()));
  const old = b.r.current();
  for (let n = 0; n < 100; n++)
    expect(take(b.r.controlTerminal(t)).kind).toBe("pending");
  expect(b.r.current()).toBe(old);
  expect(b.r.beginAttach(aq("b", 1))).toMatchObject({
    ok: false,
    reason: "busy",
  });
});
it("zero resource limits still allow pure initial display and foreign lookup", () => {
  const r = makeReceiver({
      attachIds: 0,
      controlIds: 0,
      callBytes: 0,
      snapshotRevisions: 0,
      snapshotBytes: 0,
    }),
    state = r.current(),
    display = r.currentDisplay();
  expect(r.attachTerminal({} as any)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(r.controlTerminal({} as any)).toMatchObject({
    ok: false,
    reason: "foreignToken",
  });
  expect(r.current()).toBe(state);
  expect(r.currentDisplay()).toBe(display);
  expect(display.snapshotRelation).toBe("none");
});
it("all display generations remain immutable after control and disposal", () => {
  const { r, g } = setup(),
    view = r.currentDisplay();
  const body = view.snapshot;
  take(r.acceptControlFrame(g, cf()));
  const closed = r.currentDisplay();
  expect(closed.snapshot).toBe(body);
  expect(closed.snapshot?.closed).toBe(false);
  expect(closed.ownerClosed).toBe(true);
  expect(closed.snapshotRelation).toBe("lastKnown");
  expect(view.ownerClosed).toBe(false);
  take(r.dispose());
  expect(closed.receiverStoppedReason).toBeNull();
  expect(r.currentDisplay().receiverStoppedReason).toBe("disposed");
  expect(take(r.attachTerminal(g)).kind).toBe("terminal");
  expect(deeplyFrozen(view) && deeplyFrozen(closed)).toBe(true);
});
it("equivalent reply spellings preserve original terminal identity and member order", () => {
  const { r, g } = setup(false),
    reply = ar(aq(), snap(1, {}, "complex"));
  take(r.acceptAttach(g, reply));
  const first = take(r.attachTerminal(g));
  const reordered = Object.fromEntries(Object.entries(reply).reverse());
  expect(
    r.acceptAttach(
      g,
      JSON.parse(
        JSON.stringify(reordered).replace('"revision":1', '"revision":1.0'),
      ),
    ),
  ).toMatchObject({ ok: true, value: { disposition: "duplicate" } });
  const again = take(r.attachTerminal(g));
  if (first.kind !== "terminal" || again.kind !== "terminal") throw Error();
  expect(again.reply).toBe(first.reply);
  expect(JSON.stringify(again.reply)).toBe(JSON.stringify(reply));
});
for (const outer of [
  "beginAttach",
  "acceptAttach",
  "acceptState",
  "acceptControlFrame",
  "beginControl",
  "acceptControlReply",
] as const)
  it(
    "descriptor reentry exposes committed display and rejects getters during " +
      outer,
    () => {
      const { r, g } = setup(outer !== "acceptAttach");
      let t: any;
      if (outer === "acceptControlReply") t = take(r.beginControl(g, cq()));
      const state = r.current(),
        view = r.currentDisplay();
      let traps = 0;
      const q =
        outer === "beginAttach"
          ? aq("b", 1)
          : outer === "acceptAttach"
            ? ar(aq())
            : outer === "acceptState"
              ? sf(snap(2))
              : outer === "acceptControlFrame"
                ? cf("resyncRequired")
                : outer === "beginControl"
                  ? cq()
                  : cr(cq());
      const input = new Proxy(q, {
        getOwnPropertyDescriptor(target, key) {
          traps++;
          expect(r.current()).toBe(state);
          expect(r.currentDisplay()).toBe(view);
          expect(r.attachTerminal(g)).toEqual({
            ok: false,
            reason: "busy",
            terminalStored: false,
          });
          expect(r.controlTerminal(t)).toEqual({
            ok: false,
            reason: "busy",
            terminalStored: false,
          });
          expect(r.dispose()).toMatchObject({ ok: false, reason: "busy" });
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const result =
        outer === "beginAttach"
          ? r.beginAttach(input)
          : outer === "acceptAttach"
            ? r.acceptAttach(g, input)
            : outer === "acceptState"
              ? r.acceptState(g, input)
              : outer === "acceptControlFrame"
                ? r.acceptControlFrame(g, input)
                : outer === "beginControl"
                  ? r.beginControl(g, input)
                  : r.acceptControlReply(t, input);
      expect(result.ok).toBe(true);
      expect(traps).toBeGreaterThan(0);
      expect(r.attachTerminal(g).ok).toBe(true);
      expect(r.currentDisplay().scope).toBe(r.current().scope);
      expect(r.currentDisplay().usage).toBe(r.current().usage);
      expect(r.current().stoppedReason).toBeNull();
    },
  );
it("throwing descriptor traps release the guard for pending terminal read and late recovery", () => {
  const { r, g } = setup(false),
    old = r.currentDisplay();
  expect(
    r.acceptAttach(
      g,
      new Proxy(ar(aq()), {
        getOwnPropertyDescriptor() {
          expect(r.currentDisplay()).toBe(old);
          throw Error("private failure");
        },
      }),
    ),
  ).toMatchObject({ ok: false, reason: "invalidDocument" });
  expect(take(r.attachTerminal(g)).kind).toBe("pending");
  expect(r.currentDisplay()).toMatchObject({
    receiverStoppedReason: "invalidDocument",
    snapshotRelation: "none",
  });
  take(r.acceptAttach(g, ar(aq())));
  expect(take(r.attachTerminal(g)).kind).toBe("terminal");
  expect(r.currentDisplay().snapshot).toBeNull();
});
