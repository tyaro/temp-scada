import { it, expect } from "vitest";
import {
  deliveryFixtures,
  runDeliveryScenario,
} from "./__fixtures__/recording-wire-delivery-ledger-cases";
import {
  createRecordingWireDeliveryLedger,
  type DeliveryLimits,
} from "./recording-wire-delivery-ledger";
import {
  makeDelivery,
  deliveryRequest as q,
  deliveryReply as reply,
  deliveryQuery as query,
  deliveryInspection as inspection,
  deliveryTake as take,
  deliveryCosts as costs,
  cloneDelivery as clone,
  patchDelivery as patch,
  frozenDelivery,
} from "./__fixtures__/recording-wire-delivery-ledger-cases";
import * as oracle from "./__fixtures__/recording-wire-receiver-cases";
for (const scenario of deliveryFixtures.scenarios)
  it(scenario.name, () =>
    expect(() => runDeliveryScenario(scenario)).not.toThrow(),
  );

function start(base = "lease", limits?: Partial<DeliveryLimits>) {
  const l = makeDelivery(limits),
    request = q(base),
    token = take(l.beginOriginal(request));
  return { l, request, token };
}
for (const [base, pool] of [
  ["lease", "mutation"],
  ["admit", "mutation"],
  ["inspect", "read"],
  ["cancel", "read"],
  ["readAdmit", "read"],
] as const) {
  it("independent exact Q/R/I reservation and initial credit " + base, () => {
    const request = q(base),
      b = costs(request),
      read = b.probe + (pool === "read" ? b.original : 0),
      mutation = pool === "mutation" ? b.original : 0;
    const { l, token } = start(base, {
      mutationBytes: mutation,
      readBytes: read,
      inspectionIds: 1,
      inspectionAttempts: 1,
    });
    expect(l.current().usage).toMatchObject({
      mutationBytes: mutation,
      readBytes: read,
      inspectionIdsReserved: 1,
      inspectionAttemptsReserved: 1,
    });
    const pair = take(l.beginInspection(token, query(request, "r".repeat(64))));
    expect(l.current().usage).toMatchObject({
      mutationBytes: mutation,
      readBytes: read,
      inspectionIdsUsed: 1,
      inspectionIdsReserved: 0,
      inspectionAttemptsUsed: 1,
      inspectionAttemptsReserved: 0,
    });
    expect(
      l.acceptInspection(
        pair.attempt,
        inspection(query(request, "r".repeat(64)), "terminal", reply(request)),
      ),
    ).toMatchObject({
      ok: true,
      value: { terminalStored: true, attemptStored: true },
    });
    expect(take(l.original(token)).terminal).toEqual(reply(request));
  });
  it(
    "one byte below original or initial recovery reservation is atomic " + base,
    () => {
      const request = q(base),
        b = costs(request),
        read = b.probe + (pool === "read" ? b.original : 0),
        mutation = pool === "mutation" ? b.original : 0;
      for (const limits of [
        { mutationBytes: mutation, readBytes: read - 1 },
        ...(pool === "mutation"
          ? [{ mutationBytes: mutation - 1, readBytes: read }]
          : []),
      ]) {
        const l = makeDelivery(limits),
          before = l.current();
        expect(l.beginOriginal(request)).toEqual({
          ok: false,
          reason: "capacity",
        });
        expect(l.current()).toBe(before);
      }
    },
  );
}
it("read pool full and read original pending do not consume another original's first probe", () => {
  const mutation = q(),
    read = q("cancel"),
    m = costs(mutation),
    r = costs(read);
  const l = makeDelivery({
      mutationBytes: m.original,
      readBytes: m.probe + r.original + r.probe,
    }),
    o = take(l.beginOriginal(mutation)),
    c = take(l.beginOriginal(read));
  const full = l.current().usage.readBytes,
    p = take(l.beginInspection(o, query(mutation)));
  expect(l.current().usage.readBytes).toBe(full);
  take(l.acceptInspection(p.attempt, inspection(query(mutation))));
  const before = l.current();
  expect(l.repeatInspection(p.query)).toEqual({
    ok: false,
    reason: "capacity",
  });
  expect(l.current()).toBe(before);
  const other = take(l.beginInspection(c, query(read, "read-probe")));
  expect(l.current().usage.readBytes).toBe(full);
  take(
    l.acceptInspection(
      other.attempt,
      inspection(query(read, "read-probe"), "terminal", reply(read)),
    ),
  );
  expect(l.current().usage.awaitingMutationTerminal).toBe(1);
  expect(l.current().usage.awaitingReadTerminal).toBe(0);
  expect(l.current().usage.readBytes).toBe(full);
});
it("repeat exact bytes and one below preserve query latest and charges", () => {
  const request = q(),
    b = costs(request);
  for (const delta of [0, -1]) {
    const { l, token } = start("lease", {
      readBytes: b.probe + b.repeat + delta,
    });
    const p = take(l.beginInspection(token, query(request)));
    take(l.acceptInspection(p.attempt, inspection(query(request))));
    const before = l.current(),
      old = take(l.inspection(p.query));
    const next = l.repeatInspection(p.query);
    if (delta === 0) {
      expect(next.ok).toBe(true);
      expect(l.current().usage.readBytes).toBe(b.probe + b.repeat);
      if (next.ok)
        expect(take(l.inspection(p.query)).latestAttempt).toBe(next.value);
    } else {
      expect(next).toEqual({ ok: false, reason: "capacity" });
      expect(l.current()).toBe(before);
      expect(take(l.inspection(p.query)).latestAttempt).toBe(old.latestAttempt);
    }
  }
});
it("second query exact bytes and one below never reuse the initial credit", () => {
  const request = q(),
    b = costs(request),
    second = query(request, "second"),
    extra = costs(request).R + 2048;
  // I for the new query is its actual body, not the max-ID initial credit.
  const { receiverMetrics } = oracle;
  const secondCost = receiverMetrics(second).bytes + extra;
  for (const delta of [0, -1]) {
    const { l, token } = start("lease", {
      readBytes: b.probe + secondCost + delta,
    });
    const p = take(l.beginInspection(token, query(request)));
    take(l.acceptInspection(p.attempt, inspection(query(request))));
    const before = l.current(),
      next = l.beginInspection(token, second);
    if (delta === 0) {
      expect(next.ok).toBe(true);
      expect(l.current().usage.readBytes).toBe(b.probe + secondCost);
      expect(l.current().usage.inspectionIdsUsed).toBe(2);
    } else {
      expect(next).toEqual({ ok: false, reason: "capacity" });
      expect(l.current()).toBe(before);
    }
  }
});
it("default read lifetime is finite even when every probe reply arrives normally", () => {
  const { l, request, token } = start(),
    p = take(l.beginInspection(token, query(request)));
  let a = p.attempt,
    n = 0;
  for (;;) {
    take(l.acceptInspection(a, inspection(query(request))));
    n++;
    const next = l.repeatInspection(p.query);
    if (!next.ok) {
      expect(next.reason).toBe("capacity");
      break;
    }
    a = next.value;
    if (n > 50) throw Error("unbounded probe retention");
  }
  expect(n).toBeGreaterThan(1);
  expect(l.current().usage.awaitingMutationTerminal).toBe(1);
  expect(l.current().stoppedReason).toBeNull();
  expect(l.current().usage.readBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
});
it("factory validates strict shrink options before evaluating scope", () => {
  let reads = 0;
  const scope = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        reads++;
        throw Error();
      },
    },
  );
  const invalid = [
    null,
    [],
    new Date(),
    1,
    { extra: 1 },
    { mutationBytes: -1 },
    { readBytes: 2097153 },
    { mutationIds: 4097 },
    { inspectionAttempts: 0.1 },
    { inspectionIds: NaN },
    { readIds: undefined },
    { [Symbol()]: 0 },
    Object.defineProperty({}, "readIds", { value: 0 }),
    {
      get readIds() {
        reads++;
        return 0;
      },
    },
  ];
  for (const value of invalid)
    expect(createRecordingWireDeliveryLedger(scope, value as any)).toEqual({
      ok: false,
      reason: "invalidOptions",
    });
  expect(reads).toBe(0);
  expect(
    createRecordingWireDeliveryLedger(deliveryFixtures.scope, {
      mutationBytes: 0,
      readBytes: 0,
      mutationIds: 0,
      readIds: 0,
      inspectionIds: 0,
      inspectionAttempts: 0,
    }).ok,
  ).toBe(true);
  expect(
    createRecordingWireDeliveryLedger(
      deliveryFixtures.scope,
      Object.create(null),
    ).ok,
  ).toBe(true);
  for (const value of [
    null,
    {},
    { ...deliveryFixtures.scope, ownerEpoch: "" },
    { ...deliveryFixtures.scope, extra: 1 },
  ])
    expect(createRecordingWireDeliveryLedger(value)).toEqual({
      ok: false,
      reason: "invalidScope",
    });
});
it("foreign, wrong-kind and hostile tokens reject without input descriptor access or republishing", () => {
  const a = start(),
    b = start(),
    p = take(a.l.beginInspection(a.token, query(a.request)));
  let reads = 0;
  const hostile = new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error();
        },
        ownKeys() {
          reads++;
          throw Error();
        },
        getPrototypeOf() {
          reads++;
          throw Error();
        },
        getOwnPropertyDescriptor() {
          reads++;
          throw Error();
        },
      },
    ),
    before = a.l.current();
  for (const token of [
    b.token,
    {},
    clone(a.token),
    Object.create(a.token),
    hostile,
    null,
    "id",
    undefined,
  ]) {
    expect(a.l.original(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.inspection(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.attempt(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.acceptOriginal(token as any, hostile)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.acceptInspection(token as any, hostile)).toMatchObject({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.beginInspection(token as any, hostile)).toEqual({
      ok: false,
      reason: "foreignToken",
    });
    expect(a.l.repeatInspection(token as any)).toEqual({
      ok: false,
      reason: "foreignToken",
    });
  }
  expect(a.l.original(p.query as any)).toEqual({
    ok: false,
    reason: "foreignToken",
  });
  expect(a.l.attempt(p.query as any)).toEqual({
    ok: false,
    reason: "foreignToken",
  });
  expect(a.l.inspection(p.attempt as any)).toEqual({
    ok: false,
    reason: "foreignToken",
  });
  expect(a.l.current()).toBe(before);
  expect(reads).toBe(0);
});
it("all input and public metadata is frozen and copied, while getters share retained bodies", () => {
  const scope = clone(deliveryFixtures.scope),
    made = createRecordingWireDeliveryLedger(scope);
  if (!made.ok) throw Error();
  const l = made.value;
  scope.ownerEpoch = "changed";
  const request = q(),
    t = take(l.beginOriginal(request)),
    pending = take(l.original(t));
  request.scope.ownerEpoch = "changed";
  const iq = query(q()),
    p = take(l.beginInspection(t, iq));
  iq.scope.ownerEpoch = "changed";
  const r = inspection(query(q()), "terminal", reply(q()));
  take(l.acceptInspection(p.attempt, r));
  r.outcome.reply.outcome.deadlineLeaseRef = "changed";
  const original = take(l.original(t)),
    again = take(l.original(t)),
    attempt = take(l.attempt(p.attempt)),
    queryState = take(l.inspection(p.query));
  expect(original.request).toBe(pending.request);
  expect(original.terminal).toBe(again.terminal);
  expect(queryState.request.original).toBe(original.request);
  expect(queryState.request.scope).toBe(l.current().scope);
  expect(attempt.request).toBe(queryState.request);
  expect(attempt.reply?.outcome).toMatchObject({
    kind: "terminal",
    reply: { outcome: { deadlineLeaseRef: "lease-ref" } },
  });
  if (attempt.reply?.outcome.kind !== "terminal") throw Error();
  expect(attempt.reply.outcome.reply).toBe(original.terminal);
  expect(
    frozenDelivery(original) &&
      frozenDelivery(attempt) &&
      frozenDelivery(queryState) &&
      frozenDelivery(made) &&
      frozenDelivery(l.current()),
  ).toBe(true);
  const before = l.current();
  for (let n = 0; n < 1000; n++) {
    expect(take(l.original(t)).terminal).toBe(original.terminal);
    expect(take(l.attempt(p.attempt)).reply?.request).toBe(attempt.request);
    take(l.inspection(p.query));
  }
  expect(l.current()).toBe(before);
  expect(pending.terminal).toBeNull();
});
it("a conflicting attempt retains its own body while the original and cached flags remain unchanged", () => {
  const { l, request, token } = start("admit"),
    p = take(l.beginInspection(token, query(request)));
  take(l.acceptOriginal(token, reply(request, "unknown")));
  const old = take(l.original(token));
  const incoming = inspection(
    query(request),
    "terminal",
    reply(request, "accepted"),
  );
  expect(l.acceptInspection(p.attempt, incoming)).toEqual({
    ok: false,
    reason: "protocolViolation",
    terminalStored: false,
    attemptStored: true,
  });
  const stored = take(l.attempt(p.attempt));
  expect(stored.reply).toEqual(incoming);
  expect(take(l.original(token)).terminal).toBe(old.terminal);
  const before = l.current();
  expect(l.acceptInspection(p.attempt, incoming)).toEqual({
    ok: true,
    value: {
      disposition: "duplicate",
      terminalStored: false,
      attemptStored: true,
    },
  });
  expect(l.current()).toBe(before);
  expect(l.current().stoppedReason).toBe("protocolViolation");
});
it("member order is significant while object order and integer spellings are equivalent", () => {
  const { l, request, token } = start("admit"),
    reordered = Object.fromEntries(Object.entries(request).reverse());
  expect(
    take(
      l.beginOriginal(
        JSON.parse(
          JSON.stringify(reordered).replace('"version":1', '"version":1.0'),
        ),
      ),
    ),
  ).toBe(token);
  const changed = clone(request);
  changed.action.change.apply.desired.group.members.reverse();
  expect(l.beginOriginal(changed)).toEqual({
    ok: false,
    reason: "protocolViolation",
  });
  expect(take(l.original(token)).request).toEqual(request);
});
