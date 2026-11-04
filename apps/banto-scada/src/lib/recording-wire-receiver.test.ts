import { describe, it, expect } from "vitest";
import {
  createRecordingWireReceiver,
  type ReceiverLimits,
  type ReceiverResult,
} from "./recording-wire-receiver";
import {
  receiverFixtures as f,
  runReceiverScenario,
  makeReceiver,
  receiverAttachRequest as aq,
  receiverAttachReply as ar,
  receiverSnapshot as snap,
  receiverStateFrame as sf,
  receiverControlRequest as cq,
  receiverControlReply as cr,
  receiverControlFrame as cf,
  cloneReceiverJson as clone,
  receiverMetrics as metrics,
  deeplyFrozen,
} from "./__fixtures__/recording-wire-receiver-cases";
import { parseRecordingWireControlFrame } from "./recording-wire-contract";
const take = <T>(r: ReceiverResult<T>): T => {
  if (!r.ok) throw Error(r.reason);
  return r.value;
};
function setup(limits?: Partial<ReceiverLimits>) {
  const r = makeReceiver(limits);
  take(r.setConnected(true));
  const g = take(r.beginAttach(aq()));
  return { r, g };
}
function attached(limits?: Partial<ReceiverLimits>) {
  const v = setup(limits);
  take(v.r.acceptAttach(v.g, ar(aq())));
  return v;
}
for (const scenario of f.scenarios)
  it(scenario.name, () => {
    runReceiverScenario(scenario);
  });
describe("factory bounded options and ownership", () => {
  for (const value of [
    null,
    [],
    1,
    "x",
    new Date(),
    { unknown: 1 },
    { attachIds: -1 },
    { attachIds: 4097 },
    { callBytes: 8388609 },
    { snapshotRevisions: 65 },
    { controlIds: Infinity },
    { snapshotBytes: NaN },
    { callBytes: 0.1 },
    { attachIds: undefined },
    Object.defineProperty({}, "attachIds", { value: 0 }),
    { [Symbol()]: 0 },
  ])
    it("rejects invalid options " + String(value), () =>
      expect(createRecordingWireReceiver(f.scope, value as any)).toEqual({
        ok: false,
        reason: "invalidOptions",
      }),
    );
  it("rejects accessors without invocation and validates options before scope", () => {
    let calls = 0;
    const value = {
      get attachIds() {
        calls++;
        return 0;
      },
    };
    expect(
      createRecordingWireReceiver(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              calls++;
              throw Error();
            },
          },
        ),
        value,
      ),
    ).toEqual({ ok: false, reason: "invalidOptions" });
    expect(calls).toBe(0);
  });
  for (const value of [
    null,
    {},
    { ...f.scope, extra: 1 },
    { ...f.scope, ownerEpoch: "" },
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error("secret");
        },
      },
    ),
  ])
    it("rejects invalid scope without external exceptions", () =>
      expect(createRecordingWireReceiver(value)).toEqual({
        ok: false,
        reason: "invalidScope",
      }));
  it("permits all zero and null-prototype options", () => {
    expect(
      createRecordingWireReceiver(f.scope, {
        attachIds: 0,
        controlIds: 0,
        snapshotRevisions: 0,
        snapshotBytes: 0,
        callBytes: 0,
      }).ok,
    ).toBe(true);
    expect(createRecordingWireReceiver(f.scope, Object.create(null)).ok).toBe(
      true,
    );
  });
  it("copies scope, requests, frames and freezes all old views", () => {
    const scope = clone(f.scope),
      made = createRecordingWireReceiver(scope);
    if (!made.ok) throw Error();
    const r = made.value;
    const initial = r.current();
    scope.ownerRef = "else";
    expect(initial.scope).toEqual(f.scope);
    take(r.setConnected(true));
    const q = aq(),
      g = take(r.beginAttach(q));
    q.attachId = "changed";
    const reply = ar(aq());
    take(r.acceptAttach(g, reply));
    reply.outcome.snapshot.closed = true;
    const frame = sf(snap(2));
    take(r.acceptState(g, frame));
    frame.snapshot.ownerBlocked = true;
    expect(r.current().latest?.ownerBlocked).toBe(false);
    expect(r.current().ownerClosed).toBe(false);
    expect(initial.highwater).toBeNull();
    expect(deeplyFrozen(initial)).toBe(true);
  });
});
describe("private generation and recovery qualification", () => {
  it("foreign tokens reject before payload inspection without changing state", () => {
    const a = attached(),
      b = attached();
    let reads = 0;
    const payload = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw Error();
        },
      },
    );
    const before = a.r.current();
    expect(a.r.acceptState(b.g, payload)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.r.acceptControlFrame({} as any, payload)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.r.acceptAttach(b.g, payload)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.r.beginControl(b.g, payload)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.r.acceptControlReply({} as any, payload)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.r.current()).toEqual(before);
    expect(reads).toBe(0);
  });
  it("retired and disconnected frames skip parsing", () => {
    const { r, g } = attached();
    take(r.setConnected(false));
    let reads = 0;
    const payload = new Proxy(
      {},
      {
        ownKeys() {
          reads++;
          throw Error();
        },
      },
    );
    expect(r.acceptState(g, payload)).toMatchObject({
      ok: true,
      value: { disposition: "ignoredRetired" },
    });
    expect(r.acceptControlFrame(g, payload)).toMatchObject({
      ok: true,
      value: { disposition: "ignoredRetired" },
    });
    take(r.setConnected(true));
    expect(r.acceptState(g, payload)).toMatchObject({
      ok: true,
      value: { disposition: "ignoredRetired" },
    });
    expect(reads).toBe(0);
  });
  it("same ID on another generation is protocol violation even for identical control body", () => {
    const { r, g } = attached();
    const t = take(r.beginControl(g, cq()));
    take(r.acceptControlReply(t, cr(cq())));
    const g2 = take(r.beginAttach(aq("b", 2)));
    take(r.acceptAttach(g2, ar(aq("b", 2), snap(2), "s2")));
    expect(r.beginControl(g2, cq())).toMatchObject({
      ok: false,
      reason: "protocolViolation",
    });
    expect(r.current().usage.controlIds).toBe(1);
  });
  it("rejected registration cannot retire existing attached generation", () => {
    const { r, g } = attached();
    expect(r.beginAttach({ ...aq("b", 1), extra: true })).toMatchObject({
      ok: false,
      reason: "invalidRequest",
    });
    expect(r.current().generation?.phase).toBe("attached");
    expect(r.acceptState(g, sf(snap(2))).ok).toBe(true);
  });
  it("retired terminal owns ref even without projection", () => {
    const { r, g } = setup();
    take(r.retire(g));
    take(r.acceptAttach(g, ar(aq())));
    const next = take(r.beginAttach(aq("b")));
    expect(r.acceptAttach(next, ar(aq("b")))).toMatchObject({
      ok: false,
      reason: "protocolViolation",
      terminalStored: true,
    });
    expect(r.current().usage.pendingAttach).toBe(0);
    expect(r.current().highwater).toBeNull();
  });
  it("runtime boolean, retire and dispose idempotence", () => {
    const { r, g } = attached();
    const before = r.current();
    expect(r.setConnected(1 as any)).toMatchObject({
      ok: false,
      reason: "invalidRequest",
    });
    expect(r.current()).toEqual(before);
    expect(r.retire(g).ok).toBe(true);
    expect(r.retire(g).ok).toBe(true);
    expect(r.dispose().ok).toBe(true);
    expect(r.dispose().ok).toBe(true);
    expect(r.setConnected(true)).toMatchObject({
      ok: false,
      reason: "disposed",
    });
  });
});
describe("finite reservation independent oracle", () => {
  const attachCost =
    metrics(aq()).bytes + 2097152 + metrics(f.scope).bytes + 65536 + 1024;
  const controlCost = metrics(cq()).bytes + 2097152 + 1024;
  it("exact attach reservation succeeds, one byte below has no effects", () => {
    const { r } = setup({ callBytes: attachCost });
    expect(r.current().usage.callBytes).toBe(attachCost);
    const low = makeReceiver({ callBytes: attachCost - 1 });
    take(low.setConnected(true));
    expect(low.beginAttach(aq())).toMatchObject({
      ok: false,
      reason: "capacity",
    });
    expect(low.current().usage.callBytes).toBe(0);
    expect(low.current().usage.attachIds).toBe(0);
  });
  it("exact control reservation succeeds, one byte below consumes no ID", () => {
    const a = attached({ callBytes: attachCost + controlCost });
    expect(a.r.beginControl(a.g, cq()).ok).toBe(true);
    expect(a.r.current().usage.callBytes).toBe(attachCost + controlCost);
    const b = attached({ callBytes: attachCost + controlCost - 1 });
    expect(b.r.beginControl(b.g, cq())).toMatchObject({
      ok: false,
      reason: "capacity",
    });
    expect(b.r.current().usage.controlIds).toBe(0);
  });
  it("snapshot exact measured size succeeds and one below preserves terminal only", () => {
    const n = metrics(snap()).bytes,
      a = setup({ snapshotBytes: n }),
      b = setup({ snapshotBytes: n - 1 });
    expect(a.r.acceptAttach(a.g, ar(aq())).ok).toBe(true);
    expect(a.r.current().usage.snapshotBytes).toBe(n);
    expect(b.r.acceptAttach(b.g, ar(aq()))).toMatchObject({
      ok: false,
      reason: "capacity",
      terminalStored: true,
    });
    expect(b.r.current().highwater).toBeNull();
    expect(b.r.current().usage.pendingAttach).toBe(0);
  });
  it("64 retained snapshots exact bound then 65th fails without losing latest", () => {
    const { r, g } = attached();
    for (let revision = 2; revision <= 64; revision++)
      expect(r.acceptState(g, sf(snap(revision))).ok).toBe(true);
    expect(r.current().usage.snapshotRevisions).toBe(64);
    expect(r.acceptState(g, sf(snap(65)))).toMatchObject({
      ok: false,
      reason: "capacity",
    });
    expect(r.current().highwater).toBe(64);
  });
  it("repeated full bodies intern without charging and reserves never refund", () => {
    const { r, g } = setup();
    take(r.acceptState(g, sf(snap())));
    const n = r.current().usage.snapshotBytes;
    take(r.acceptAttach(g, ar(aq())));
    const cost = r.current().usage.callBytes;
    take(r.acceptState(g, sf(snap())));
    take(r.acceptAttach(g, ar(aq())));
    take(r.retire(g));
    expect(r.current().usage.snapshotBytes).toBe(n);
    expect(r.current().usage.callBytes).toBe(cost);
  });
  it("default call pool stops fourth minimum attach while exact cache still works", () => {
    const { r, g } = setup();
    take(r.acceptAttach(g, ar(aq())));
    for (let i = 2; i <= 3; i++) {
      const q = aq(String(i), 1),
        n = take(r.beginAttach(q));
      take(r.acceptAttach(n, ar(q, snap(), "s" + i)));
    }
    expect(r.beginAttach(aq("4", 1))).toMatchObject({
      ok: false,
      reason: "capacity",
    });
    expect(r.current().usage.attachIds).toBe(3);
    expect(take(r.beginAttach(aq()))).toBe(g);
  });
  it.each(["ownerClosed", "authorizationLost", "resyncRequired"])(
    "closed control schema fits independent reserved bound %s",
    (reason) => {
      const frame = parseRecordingWireControlFrame(cf(reason, "s".repeat(64))),
        m = metrics(frame),
        scope = metrics(f.scope);
      expect(m.bytes).toBeLessThanOrEqual(scope.bytes + 65536);
      expect(m.nodes).toBeLessThanOrEqual(scope.nodes + 4096);
      expect(m.depth).toBeLessThanOrEqual(Math.max(scope.depth + 1, 3));
    },
  );
});
describe("reentry is guarded before even nested descriptor validation", () => {
  const mutations = [
    "beginAttach",
    "acceptAttach",
    "acceptState",
    "acceptControlFrame",
    "beginControl",
    "acceptControlReply",
    "setConnected",
    "retire",
    "dispose",
  ] as const;
  for (const outer of [
    "beginAttach",
    "acceptAttach",
    "acceptState",
    "acceptControlFrame",
    "beginControl",
    "acceptControlReply",
  ] as const)
    it(
      "all nested mutations busy and current committed during " + outer,
      () => {
        const { r, g } = setup();
        if (outer !== "acceptAttach") take(r.acceptAttach(g, ar(aq())));
        let t: any;
        if (outer === "acceptControlReply") t = take(r.beginControl(g, cq()));
        const before = r.current(),
          nested: any[] = [];
        let traps = 0;
        const dangerous = new Proxy(
          {},
          {
            getPrototypeOf() {
              throw Error("nested payload inspected");
            },
          },
        );
        const fire = () => {
          traps++;
          expect(r.current()).toBe(before);
          for (const m of mutations) {
            let result;
            if (m === "beginAttach") result = r.beginAttach(dangerous);
            else if (m === "acceptAttach")
              result = r.acceptAttach(g, dangerous);
            else if (m === "acceptState") result = r.acceptState(g, dangerous);
            else if (m === "acceptControlFrame")
              result = r.acceptControlFrame(g, dangerous);
            else if (m === "beginControl")
              result = r.beginControl(g, dangerous);
            else if (m === "acceptControlReply")
              result = r.acceptControlReply(t, dangerous);
            else if (m === "setConnected") result = r.setConnected(false);
            else if (m === "retire") result = r.retire(g);
            else result = r.dispose();
            nested.push(result);
            expect(result).toEqual({
              ok: false,
              reason: "busy",
              terminalStored: false,
            });
            expect(r.current()).toBe(before);
          }
        };
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
          getPrototypeOf(target) {
            fire();
            return Reflect.getPrototypeOf(target);
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
        expect(nested.length).toBe(traps * mutations.length);
        expect(r.current().stoppedReason).toBeNull();
        expect(r.current().connected).toBe(true);
        expect(r.setConnected(false).ok).toBe(true);
      },
    );
  it("throwing traps release busy and accessor bodies are not invoked", () => {
    const { r, g } = setup();
    let invoked = 0;
    const input = Object.defineProperty(ar(aq()), "outcome", {
      enumerable: true,
      get() {
        invoked++;
        throw Error("secret");
      },
    });
    expect(r.acceptAttach(g, input)).toMatchObject({
      ok: false,
      reason: "invalidDocument",
    });
    expect(invoked).toBe(0);
    expect(r.acceptAttach(g, ar(aq())).ok).toBe(true);
    expect(r.current().usage.pendingAttach).toBe(0);
    const b = makeReceiver();
    take(b.setConnected(true));
    expect(
      b.beginAttach(
        new Proxy(
          {},
          {
            ownKeys() {
              throw Error("secret");
            },
          },
        ),
      ),
    ).toMatchObject({ ok: false, reason: "invalidRequest" });
    expect(b.beginAttach(aq()).ok).toBe(true);
  });
});
it("object key order and JSON numeric spelling are equal without array normalization", () => {
  const { r, g } = attached();
  const v = JSON.parse(
    JSON.stringify(sf(snap())).replace('"revision":1', '"revision":1.0'),
  );
  const reordered = Object.fromEntries(Object.entries(v).reverse());
  expect(r.acceptState(g, reordered)).toMatchObject({
    ok: true,
    value: { disposition: "duplicate" },
  });
});
it("preACK sticky contradiction does not partially promote the sorted batch", () => {
  const { r, g } = setup();
  take(r.acceptState(g, sf(snap(3))));
  take(r.acceptState(g, sf(snap(2, { ownerBlocked: true }))));
  expect(r.acceptAttach(g, ar(aq()))).toEqual({
    ok: false,
    reason: "protocolViolation",
    terminalStored: true,
  });
  expect(r.current()).toMatchObject({
    highwater: null,
    latest: null,
    ownerBlocked: false,
    usage: { pendingAttach: 0, snapshotRevisions: 2 },
  });
});
it("control reply can recover a known older snapshot without lowering H", () => {
  const { r, g } = attached();
  take(r.acceptState(g, sf(snap(3))));
  const t = take(r.beginControl(g, cq()));
  expect(r.acceptControlReply(t, cr(cq(), snap()))).toMatchObject({
    ok: true,
    value: { disposition: "applied" },
  });
  expect(r.current().highwater).toBe(3);
});
it("unknown older control snapshot stores terminal and conservatively resyncs", () => {
  const { r, g } = attached();
  take(r.acceptState(g, sf(snap(3))));
  const t = take(r.beginControl(g, cq()));
  expect(r.acceptControlReply(t, cr(cq(), snap(2)))).toMatchObject({
    ok: true,
    value: { disposition: "resyncRequired" },
  });
  expect(r.current()).toMatchObject({
    highwater: 3,
    status: "resyncRequired",
    usage: { pendingControl: 0 },
  });
  expect(r.acceptControlReply(t, cr(cq(), snap(2)))).toMatchObject({
    ok: true,
    value: { disposition: "duplicate" },
  });
});
it("control ID exact capacity retains cached token after retire", () => {
  const { r, g } = attached({ controlIds: 1 });
  const t = take(r.beginControl(g, cq()));
  take(r.acceptControlReply(t, cr(cq())));
  expect(r.beginControl(g, cq("next"))).toMatchObject({
    ok: false,
    reason: "capacity",
  });
  take(r.retire(g));
  expect(take(r.beginControl(g, cq()))).toBe(t);
});
it("request afterRevision correlation fails before storing malformed terminal", () => {
  const r = makeReceiver();
  take(r.setConnected(true));
  const q = aq("a", 10),
    g = take(r.beginAttach(q));
  expect(r.acceptAttach(g, ar(q, snap(9)))).toMatchObject({
    ok: false,
    reason: "invalidDocument",
    terminalStored: false,
  });
  expect(r.current().usage.pendingAttach).toBe(1);
  expect(r.acceptAttach(g, ar(q, snap(10))).ok).toBe(true);
  expect(r.current().usage.pendingAttach).toBe(0);
});
it("context mismatch on begin is rejected before ID consumption", () => {
  const { r } = attached(),
    q = aq("b", 1);
  q.scope.context.sessionId = "other";
  const old = r.current();
  expect(r.beginAttach(q)).toMatchObject({
    ok: false,
    reason: "invalidRequest",
  });
  expect(r.current()).toEqual(old);
});
it("retained preACK and formal bodies share budget across generation", () => {
  const { r, g } = attached();
  const old = r.current().usage.snapshotBytes,
    q = aq("b", 1),
    g2 = take(r.beginAttach(q));
  take(r.acceptState(g2, sf(snap(), "s2")));
  expect(r.current().usage.snapshotBytes).toBe(old);
  take(r.acceptAttach(g2, ar(q, snap(), "s2")));
  expect(r.current().usage.snapshotBytes).toBe(old);
  expect(
    r.acceptState(
      g,
      new Proxy(
        {},
        {
          ownKeys() {
            throw Error("old generation parsed");
          },
        },
      ),
    ),
  ).toMatchObject({ ok: true, value: { disposition: "ignoredRetired" } });
});
