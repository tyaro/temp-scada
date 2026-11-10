import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncRecordingOperationsCoordinator } from "./coordinator";
import { createAsyncPortHarness } from "../__fixtures__/recording-async-port";
import { operationsProject } from "../__fixtures__/recording-operations-service";
import { parseRecordingChangeRequest } from "../recording-operations-contract";
import { parseRecordingAdmissionReply } from "../recording-admission-contract";
import { createIdPools, ID_ROLES } from "./ids";
import { parsePortState, parseTransportEnd } from "./local-validation";
import { defineAsyncRecordingPortV2, isAsyncRecordingPortV2 } from "./port";
import type { PortStateV2 } from "./port";
import { ownHistoryJson } from "../history/owned-json";
let now = 100;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const h = createAsyncPortHarness(),
    root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
    identity = {};
  return {
    h,
    root,
    client: root.client,
    view: root.client.bindView(identity),
    identity,
  };
}
/** A port state with a changed cached snapshot (same scope). */
function snap(f: PortStateV2, patch: Record<string, unknown>): PortStateV2 {
  return {
    ...f,
    display: { ...f.display, snapshot: { ...f.display.snapshot!, ...patch } },
  };
}
function control() {
  return {
    intentDeadlineMonotonicMs: now + 1000,
    requestedNativeBudgetMs: 500,
  };
}
function change(h: ReturnType<typeof createAsyncPortHarness>, n = 1) {
  return parseRecordingChangeRequest({
    version: 1,
    kind: "recordingChangeRequest",
    changeId: `change:${n}`,
    context: h.context,
    apply: {
      requestId: `apply:${n}`,
      desired: operationsProject.recordingPlan,
      expectedAppliedRevision: null,
      expectedMappingRevision: 1,
      expectedRetentionAppliedRevision: 1,
    },
  });
}
async function candidate(s: ReturnType<typeof setup>) {
  expect(s.view.preflight(change(s.h), control())).toBe(true);
  await flush();
  s.h.finish(0);
  await flush();
}
async function appliedUnknown(s: ReturnType<typeof setup>) {
  await candidate(s);
  expect(s.view.pause(control())).toBe(true);
  await flush();
  s.h.finish(1);
  await flush();
  expect(s.view.apply(control())).toBe(true);
  await flush();
  s.h.finish(2, "workerFailure");
  await flush();
}
beforeEach(() => {
  now = 100;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
describe("external root admission and physical call ownership", () => {
  it("shares one gate and rejects duplicate management roots even after close", async () => {
    const s = setup(),
      other = s.client.bindView(s.identity);
    s.h.configure({ autoLease: false });
    expect(s.view.preflight(change(s.h), control())).toBe(true);
    expect(other.preflight(change(s.h, 2), control())).toBe(false);
    expect(s.h.leases).toHaveLength(1);
    expect(s.h.admissions).toHaveLength(0);
    s.root.close();
    expect(() => createAsyncRecordingOperationsCoordinator(s.h.port)).toThrow();
    expect(() => s.client.bindView({})).toThrow();
    s.h.issueLease(0);
    await flush();
    expect(s.h.admissions).toHaveLength(0);
  });
  it.each(["retire", "close", "deadline", "disconnect", "ownerBlocked"])(
    "does not admit a late lease after %s",
    async (reason) => {
      const s = setup();
      s.h.configure({ autoLease: false });
      s.view.preflight(change(s.h), control());
      if (reason === "retire") s.view.retire();
      if (reason === "close") s.root.close();
      if (reason === "deadline") {
        now = 1101;
        vi.advanceTimersByTime(1001);
      }
      if (reason === "disconnect") s.h.emit({ connected: false });
      if (reason === "ownerBlocked") s.h.emit({ ownerBlocked: true });
      expect(s.client.current().call).toBe("lease");
      expect(s.h.leases).toHaveLength(1);
      s.h.issueLease(0);
      await flush();
      expect(s.h.admissions).toHaveLength(0);
      expect(s.client.current().call).toBe("idle");
      expect(s.client.current().pools.mutationAdmission.used).toBe(1);
      expect(s.client.current().pools.mutationAdmission.reserved).toBe(0);
    },
  );
  it("reserves gate before notification and rechecks retirement on listener reentry", async () => {
    const s = setup(),
      second = s.client.bindView(s.identity);
    let attempted: boolean | undefined;
    s.client.subscribe((v) => {
      if (v.admission === "preparingLease") {
        attempted = second.preflight(change(s.h, 2), control());
        s.view.retire();
      }
    });
    expect(s.view.preflight(change(s.h), control())).toBe(true);
    expect(attempted).toBe(false);
    expect(s.h.leases).toHaveLength(0);
    expect(s.h.admissions).toHaveLength(0);
  });
  it("rechecks disconnected/retired view after awaitingAck notification", async () => {
    const s = setup();
    s.client.subscribe((v) => {
      if (v.admission === "awaitingAck") s.view.retire();
    });
    s.view.preflight(change(s.h), control());
    await flush();
    expect(s.h.admissions).toHaveLength(0);
    expect(s.client.current().invalid).toBe(false);
  });
  it("preserves a pending call after accepted frame and native completion", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.emit({ admission: s.h.admissions[0].accepted! });
    s.h.finish(0);
    await flush();
    expect(s.client.current().admission).toBe("accepted");
    expect(s.client.current().call).toBe("admit");
    expect(s.view.pause(control())).toBe(false);
    s.h.ack(0);
    await flush();
    expect(s.client.current().canPause).toBe(true);
    expect(s.view.pause(control())).toBe(true);
    await flush();
    expect(s.h.stops).toBe(1);
  });
  it("normal unknown settles, inspection finds accepted, and completion allows the next explicit step", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.ack(0, "unknown");
    await flush();
    expect(s.client.current().call).toBe("idle");
    expect(s.client.current().admission).toBe("unknown");
    expect(s.view.pause(control())).toBe(false);
    expect(s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
      true,
    );
    await flush();
    s.h.finish(0);
    await flush();
    expect(s.client.current().canPause).toBe(true);
    expect(s.view.pause(control())).toBe(true);
    await flush();
    expect(s.h.stops).toBe(1);
  });
  it("inspection can discover accepted while original admit stays pending, without releasing it", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    now = 1101;
    vi.advanceTimersByTime(1001);
    expect(s.client.current().admission).toBe("unknown");
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    await flush();
    s.h.finish(0);
    await flush();
    expect(s.client.current().call).toBe("admit");
    expect(s.view.pause(control())).toBe(false);
    s.h.ack(0, "unknown");
    await flush();
    expect(s.client.current().canPause).toBe(true);
  });
  it.each(["notFound", "unavailable"])(
    "%s leaves unknown admission blocked even after a normal call settles",
    async (kind) => {
      const s = setup();
      s.h.configure({ autoAck: false, autoInspect: false });
      s.view.preflight(change(s.h), control());
      await flush();
      s.h.ack(0, "unknown");
      await flush();
      s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
      const r = s.h.inspections[0];
      r.resolve({
        version: 1,
        kind: "recordingAdmissionInspectionReply",
        request: r.request,
        outcome: kind === "notFound" ? { kind } : { kind, error: "internal" },
      });
      await flush();
      expect(s.client.current().admission).toBe("unknown");
      expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
      expect(s.h.admissions).toHaveLength(1);
    },
  );
  it.each(["malformed", "throw", "thenable"])(
    "admit %s is a permanent uncertain call, never a native result",
    async (kind) => {
      const h = createAsyncPortHarness();
      h.configure({ autoAck: false });
      if (kind === "throw")
        h.impl.admit = () => {
          throw Error("PRIVATE_URL_CREDENTIAL");
        };
      if (kind === "thenable") h.impl.admit = (() => ({ then() {} })) as any;
      const root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
        v = root.client.bindView({});
      v.preflight(change(h), control());
      await flush();
      if (kind === "malformed")
        h.admissions[0].resolve({ unexpected: "PRIVATE_URL_CREDENTIAL" });
      await flush();
      expect(root.client.current().invalid).toBe(true);
      expect(root.client.current().call).toBe("uncertain");
      expect(v.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
        false,
      );
      expect(JSON.stringify(root.client.current())).not.toContain(
        "PRIVATE_URL_CREDENTIAL",
      );
    },
  );
  it.each(["failed", "refused"])(
    "admit transport %s without a reply is unknown acceptance, recovered by CallInspection",
    async (kind) => {
      const s = setup();
      s.h.configure({ autoAck: false });
      s.view.preflight(change(s.h), control());
      await flush();
      if (kind === "failed") s.h.admissions[0].reject();
      else s.h.admissions[0].refuse({ kind: "busy" });
      await flush();
      const st = s.client.current();
      expect(st.invalid).toBe(false);
      expect(st.call).toBe("idle");
      expect(st.admission).toBe("unknown");
      if (kind === "refused") expect(st.hostRefusal).toEqual({ kind: "busy" });
      expect(st.canInspect).toBe(true);
      expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
      expect(s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
        true,
      );
      await flush();
      // The lost original is recovered from the ledger, never resent.
      expect(s.h.callInspections).toHaveLength(1);
      expect(s.h.inspections).toHaveLength(0);
      expect(s.h.admissions).toHaveLength(1);
      expect(s.client.current().callInspection?.outcome.kind).toBe("terminal");
      expect(s.client.current().admission).toBe("accepted");
      s.h.finish(0);
      await flush();
      expect(s.view.pause(control())).toBe(true);
    },
  );
  it("CallInspection notFound keeps the lost admit unknown and never resends it", async () => {
    const s = setup();
    s.h.configure({ autoAck: false, autoInspect: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.admissions[0].reject();
    await flush();
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    const c = s.h.callInspections[0];
    c.resolve({
      version: 1,
      kind: "recordingWireCallInspectionReply",
      request: c.request,
      outcome: { kind: "notFound" },
    });
    await flush();
    expect(s.client.current().admission).toBe("unknown");
    expect(s.client.current().inspectionCall).toBe("idle");
    expect(s.h.admissions).toHaveLength(1);
    expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
  });
  it("a received unknown admit uses AdmissionInspection, not CallInspection", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.ack(0, "unknown");
    await flush();
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    await flush();
    expect(s.h.inspections).toHaveLength(1);
    expect(s.h.callInspections).toHaveLength(0);
    expect(s.client.current().admission).toBe("accepted");
  });
  it("retains valid late inspection evidence after the original transport is lost", async () => {
    const s = setup();
    s.h.configure({ autoAck: false, autoInspect: false });
    s.view.preflight(change(s.h), control());
    await flush();
    now = 1101;
    vi.advanceTimersByTime(1001);
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    s.h.admissions[0].reject();
    await flush();
    const i = s.h.inspections[0];
    i.resolve({
      version: 1,
      kind: "recordingAdmissionInspectionReply",
      request: i.request,
      outcome: { kind: "found", reply: s.h.admissions[0].accepted },
    });
    await flush();
    s.h.finish(0);
    await flush();
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.client.current().invalid).toBe(false);
    expect(s.client.current().call).toBe("idle");
    expect(s.client.current().canPause).toBe(true);
  });
  it("a lost admit after an accepted frame keeps the verified result", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.emit({ admission: s.h.admissions[0].accepted });
    s.h.finish(0);
    await flush();
    s.h.admissions[0].reject();
    await flush();
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.client.current().admission).toBe("accepted");
    expect(s.client.current().invalid).toBe(false);
  });
  it("contradictory admission is blocked while identical replies are idempotent", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    const r = s.h.admissions[0].accepted!;
    s.h.emit({ admission: r });
    s.h.emit({ admission: r });
    expect(s.client.current().invalid).toBe(false);
    s.h.admissions[0].resolve(
      parseRecordingAdmissionReply({
        ...r,
        outcome: { kind: "rejected", error: "busy" },
      }),
    );
    await flush();
    expect(s.client.current().invalid).toBe(true);
    expect(s.client.current().reply?.outcome.kind).toBe("accepted");
  });
  it.each(["lease", "inspection", "cancel", "operation", "read"])(
    "%s transport loss retains the corresponding gate without a port fault",
    async (stage) => {
      const s = setup();
      if (stage === "lease") {
        s.h.configure({ autoLease: false });
        s.view.preflight(change(s.h), control());
        s.h.leases[0].reject();
      }
      if (stage === "inspection") {
        s.h.configure({ autoAck: false, autoInspect: false });
        s.view.preflight(change(s.h), control());
        await flush();
        s.h.ack(0, "unknown");
        await flush();
        s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
        s.h.inspections[0].reject();
      }
      if (stage === "cancel" || stage === "operation") {
        s.h.configure({ autoCancel: false });
        s.view.preflight(change(s.h), control());
        await flush();
        if (stage === "cancel") {
          s.view.cancelOperation();
          s.h.cancels[0].reject();
        } else s.h.operations[0].reject();
      }
      if (stage === "read") {
        await appliedUnknown(s);
        s.view.reconcile(control());
        await flush();
        s.h.reads[0].reject();
      }
      await flush();
      const st = s.client.current();
      expect(st.invalid).toBe(false);
      expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
      expect(st.safeToSwitch).toBe(false);
      if (stage === "lease") expect(st.call).toBe("uncertain");
      if (stage === "inspection") {
        expect(st.inspectionCall).toBe("idle");
        expect(st.admission).toBe("unknown");
        expect(st.canInspect).toBe(true);
      }
      if (stage === "cancel") expect(st.cancelCall).toBe("uncertain");
      if (stage === "operation" || stage === "read")
        expect(st.read).toBe("deliveryUnknown");
    },
  );
  it.each(["operation", "read"])(
    "%s observation unavailable is a terminal without a result",
    async (stage) => {
      const s = setup();
      if (stage === "operation") {
        s.view.preflight(change(s.h), control());
        await flush();
        s.h.operations[0].unavailable();
      } else {
        await appliedUnknown(s);
        s.view.reconcile(control());
        await flush();
        s.h.reads[0].unavailable();
      }
      await flush();
      const st = s.client.current();
      expect(st.invalid).toBe(false);
      expect(st.read).toBe("deliveryUnknown");
      expect(st.safeToSwitch).toBe(false);
      if (stage === "operation") expect(st.completion).toBeUndefined();
      expect(s.view.reconcile(control())).toBe(false);
    },
  );
});
describe("native result, frame and lifetime", () => {
  it("requires explicit candidate, pause completion and apply; never restarts", async () => {
    const s = setup();
    s.view.preflight(change(s.h), control());
    await flush();
    expect(s.h.stops).toBe(0);
    expect(s.view.pause(control())).toBe(false);
    s.h.finish(0);
    await flush();
    expect(s.view.pause(control())).toBe(true);
    await flush();
    expect(s.h.stops).toBe(1);
    expect(s.view.apply(control())).toBe(false);
    s.h.finish(1);
    await flush();
    s.view.apply(control());
    await flush();
    s.h.finish(2);
    await flush();
    expect(s.client.current().completion?.outcome.kind).toBe("applied");
    expect(s.client.current().lastApplied).toBeDefined();
    expect(s.h.writes).toBe(1);
    expect(s.client.current().pools.callerOperation.used).toBe(2);
    expect(s.client.current().pools.mutationAdmission.reserved).toBe(0);
  });
  it.each(["replay", "conflict"])(
    "preflight %s does not permit pause",
    async (kind) => {
      const s = setup();
      s.view.preflight(change(s.h), control());
      await flush();
      s.h.finish(0, kind);
      await flush();
      expect(s.view.pause(control())).toBe(false);
      expect(s.h.stops).toBe(0);
      expect(s.client.current().safeToSwitch).toBe(true);
    },
  );
  it("discard preserves the candidate until completedDiscard, and rejected discard preserves it", async () => {
    const s = setup();
    await candidate(s);
    s.h.configure({ autoAck: false });
    s.view.discard(control());
    await flush();
    expect(s.client.current().change).toBeDefined();
    s.h.ack(1, "rejected");
    await flush();
    expect(s.client.current().change).toBeDefined();
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.view.discard(control())).toBe(true);
    await flush();
    s.h.ack(2);
    await flush();
    expect(s.client.current().change).toBeUndefined();
    expect(s.client.current().admission).toBe("discarded");
  });
  it("retired view cannot send, and a new identity cannot apply an old candidate", async () => {
    const s = setup();
    await candidate(s);
    s.view.retire();
    const next = s.client.bindView({});
    expect(s.view.pause(control())).toBe(false);
    expect(next.pause(control())).toBe(false);
    expect(next.discard(control())).toBe(true);
    await flush();
    expect(s.client.current().canPreflight).toBe(true);
  });
  it("reopening the same target uses a fresh view while root retains the result", async () => {
    const s = setup();
    s.view.preflight(change(s.h), control());
    await flush();
    s.view.retire();
    s.h.finish(0);
    await flush();
    const next = s.client.bindView(s.identity);
    expect(next.pause(control())).toBe(true);
    await flush();
    expect(s.h.stops).toBe(1);
    expect(s.view.pause(control())).toBe(false);
  });
  it("root close retains completion and frame evidence without cancelling native work", async () => {
    const s = setup();
    s.view.preflight(change(s.h), control());
    await flush();
    s.root.close();
    s.h.finish(0);
    await flush();
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.client.current().closed).toBe(true);
    expect(s.h.cancels).toHaveLength(0);
    expect(s.h.listenerCount).toBe(1);
  });
  it("frame-first result cannot release the completion slot; a lost query keeps evidence", async () => {
    const s = setup();
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.emit({
      operation: {
        operationRef: s.h.operations[0].handle.operationRef,
        result: s.h.result(0),
      },
    });
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.view.pause(control())).toBe(false);
    expect(s.client.current().pools.mutationAdmission.reserved).toBe(3);
    s.h.operations[0].reject();
    await flush();
    expect(s.client.current().read).toBe("deliveryUnknown");
    expect(s.client.current().completion).toBeUndefined();
    expect(s.client.current().latest).toBeDefined();
  });
  it("same revision must have the same body and foreign owners never rebind", () => {
    const s = setup();
    s.h.raw(s.h.frame);
    expect(s.client.current().invalid).toBe(false);
    s.h.raw(snap(s.h.frame, { ownerBlocked: true }));
    expect(s.client.current().invalid).toBe(true);
    const other = setup(),
      f = other.h.frame;
    other.h.raw({ ...f, scope: { ...f.scope, ownerRef: "foreign:owner" } });
    expect(other.client.current().ownerRef).toBe(other.h.ownerRef);
    expect(other.client.current().invalid).toBe(true);
    const epoch = setup(),
      g = epoch.h.frame;
    epoch.h.raw({ ...g, scope: { ...g.scope, ownerEpoch: "epoch:2" } });
    expect(epoch.client.current().invalid).toBe(true);
  });
  it("old revision with new information is rejected", () => {
    const s = setup();
    s.h.emit();
    s.h.raw(snap(s.h.frame, { revision: 1 }));
    expect(s.client.current().invalid).toBe(false);
    s.h.raw(snap(s.h.frame, { revision: 1, ownerBlocked: true }));
    expect(s.client.current().invalid).toBe(true);
  });
  it("disconnect blocks all new sends and same-owner reconnect preserves sticky recovery", async () => {
    const s = setup();
    await candidate(s);
    s.h.emit({ connected: false });
    expect(s.view.pause(control())).toBe(false);
    expect(s.view.discard(control())).toBe(false);
    s.h.emit({ connected: true });
    expect(s.view.pause(control())).toBe(true);
    await flush();
    s.h.finish(1);
    await flush();
    s.h.emit({ ownerBlocked: true });
    s.h.emit({ ownerBlocked: false });
    expect(s.client.current().ownerBlocked).toBe(true);
    expect(s.view.apply(control())).toBe(false);
  });
  it("a port v2 is frozen; v1, structural and Proxy ports are refused", () => {
    const s = setup();
    expect(Object.isFrozen(s.h.port)).toBe(true);
    expect(() => {
      (s.h.port as any).prepareLease = () => Promise.resolve({});
    }).toThrow();
    expect(isAsyncRecordingPortV2(s.h.port)).toBe(true);
    const fresh = createAsyncPortHarness();
    const v1 = {
      context: fresh.context,
      ownerRef: fresh.ownerRef,
      prepareLease: () => Promise.resolve({}),
      admit: () => Promise.resolve({}),
      inspectAdmission: () => Promise.resolve({}),
      observeOperation: () => ({}),
      observeReconciliation: () => ({}),
      current: () => ({}),
      subscribe: () => () => {},
      requestCancel: () => Promise.resolve({}),
    };
    const structural = { ...fresh.port };
    const proxy = new Proxy(fresh.port, {});
    for (const p of [v1, structural, proxy, null, {}])
      expect(() => createAsyncRecordingOperationsCoordinator(p as any)).toThrow(
        "port v2 required",
      );
    expect(() => defineAsyncRecordingPortV2(v1 as any)).toThrow();
    expect(() =>
      defineAsyncRecordingPortV2({ ...fresh.impl, scope: fresh.scope } as any),
    ).toThrow();
    // The genuine port is still unused and accepted once.
    expect(() =>
      createAsyncRecordingOperationsCoordinator(fresh.port),
    ).not.toThrow();
    expect(() => createAsyncRecordingOperationsCoordinator(fresh.port)).toThrow(
      "duplicate",
    );
  });
  it("isolates listener exceptions, unsubscribe and reentrant actions", async () => {
    const s = setup();
    let called = 0;
    let off = () => {};
    s.client.subscribe(() => {
      throw Error("private");
    });
    off = s.client.subscribe((v) => {
      called++;
      if (v.admission === "preparingLease") off();
    });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.finish(0);
    await flush();
    expect(called).toBe(2);
    expect(s.client.current().canPause).toBe(true);
  });
});
describe("read and cancellation have independent completion evidence", () => {
  it("reconciles only an original unconfirmed apply, retaining original completion and recovery", async () => {
    const s = setup();
    await candidate(s);
    expect(s.view.reconcile(control())).toBe(false);
    s.view.pause(control());
    await flush();
    s.h.finish(1);
    await flush();
    s.view.apply(control());
    await flush();
    s.h.finish(2, "workerFailure");
    await flush();
    const original = s.client.current().completion;
    expect(s.view.reconcile(control())).toBe(true);
    await flush();
    expect(s.h.reads).toHaveLength(1);
    s.h.finishRead(0);
    await flush();
    expect(s.client.current().completion).toBe(original);
    expect(original?.outcome.kind).toBe("failed");
    expect(s.client.current().latest?.outcome.kind).toBe("applied");
    expect(s.client.current().lastApplied).toBeDefined();
    expect(s.client.current().ownerBlocked).toBe(true);
    expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
  });
  it("readUncertain is a native finite stop, while pending completion cannot be released by its frame", async () => {
    const s = setup();
    await appliedUnknown(s);
    s.view.reconcile(control());
    await flush();
    s.h.finishRead(0, "readUncertain");
    await flush();
    expect(s.client.current().read).toBe("readUncertain");
    expect(s.client.current().invalid).toBe(false);
    expect(s.view.reconcile(control())).toBe(false);
  });
  it("notFound never erases a known receipt", async () => {
    const s = setup();
    await appliedUnknown(s);
    s.view.reconcile(control());
    await flush();
    s.h.finishRead(0);
    await flush();
    const applied = s.client.current().lastApplied;
    s.view.reconcile(control());
    await flush();
    s.h.finishRead(1, "notFound");
    await flush();
    expect(s.client.current().lastApplied).toEqual(applied);
    expect(s.client.current().latest?.outcome.kind).toBe("applied");
  });
  it("pending read stays gated after a frame-first result", async () => {
    const s = setup();
    await appliedUnknown(s);
    s.view.reconcile(control());
    await flush();
    const r = s.h.reads[0],
      original = s.client.current().completion;
    s.h.emit({
      reconciliation: {
        version: 1,
        kind: "recordingReconciliationDelivery",
        ownerRef: s.h.ownerRef,
        readRef: r.handle.readRef,
        request: r.handle.request,
        outcome: {
          kind: "result",
          result: {
            version: 1,
            kind: "recordingReconciliationResult",
            request: r.handle.request,
            outcome: {
              kind: "receiptFound",
              receipt: s.h.receipt(r.handle.request.operation),
            },
            quiescence: "confirmed",
            recoveryRequired: true,
          },
        },
      },
    });
    expect(s.client.current().read).toBe("completed");
    expect(s.client.current().lastApplied).toBeDefined();
    expect(s.client.current().completion).toBe(original);
    expect(s.view.reconcile(control())).toBe(false);
    expect(s.client.current().safeToSwitch).toBe(false);
    r.reject();
    await flush();
    expect(s.client.current().read).toBe("deliveryUnknown");
    expect(s.client.current().lastApplied).toBeDefined();
    expect(s.client.current().invalid).toBe(false);
  });
  it("cancel is one call for the target; requested is never completion", async () => {
    const s = setup();
    s.h.configure({ autoCancel: false });
    s.view.preflight(change(s.h), control());
    await flush();
    expect(s.view.cancelOperation()).toBe(true);
    expect(s.view.cancelOperation()).toBe(false);
    const c = s.h.cancels[0];
    expect(c.request.scope).toEqual(s.h.scope);
    expect(c.request.cancelId).toMatch(/^cn:/);
    expect(c.request.target).toEqual({
      kind: "operation",
      ref: s.h.operations[0].handle.operationRef,
    });
    c.resolve({
      version: 1,
      kind: "recordingWireCancelReply",
      request: c.request,
      outcome: { kind: "ack", disposition: "requested" },
    });
    await flush();
    expect(s.view.cancelOperation()).toBe(false);
    expect(s.client.current().completion).toBeUndefined();
    expect(s.client.current().cancel).toBe("requested");
    s.h.finish(0);
    await flush();
    expect(s.client.current().canPause).toBe(true);
  });
  it("pending inspection retains its slot through timeout", async () => {
    const s = setup();
    s.h.configure({ autoAck: false, autoInspect: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.ack(0, "unknown");
    await flush();
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    now += 501;
    vi.advanceTimersByTime(501);
    expect(s.client.current().inspectionCall).toBe("pending");
    expect(s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
      false,
    );
    expect(s.h.inspections).toHaveLength(1);
  });
});
describe("bounded local metadata and IDs", () => {
  it("atomically reserves five independent pools and never reuses used IDs", () => {
    const p = createIdPools("test"),
      ids = new Set<string>();
    expect(p.reserve({ mutationAdmission: 4096 })).toBe(true);
    for (let n = 0; n < 4096; n++) ids.add(p.take("mutationAdmission"));
    expect(p.reserve({ mutationAdmission: 1, callerOperation: 2 })).toBe(false);
    expect(p.current().callerOperation.reserved).toBe(0);
    expect(
      p.reserve({ readAdmission: 1, reconciliation: 1, inspection: 1 }),
    ).toBe(true);
    expect(ids.has(p.take("readAdmission"))).toBe(false);
    p.take("reconciliation");
    p.take("inspection");
    for (const role of ID_ROLES.filter((r) => r !== "mutationAdmission")) {
      const used = p.current()[role].used;
      expect(p.reserve({ [role]: 4096 - used })).toBe(true);
      for (let n = used; n < 4096; n++)
        expect(p.take(role).length).toBeLessThanOrEqual(64);
      expect(p.reserve({ [role]: 1 })).toBe(false);
    }
    expect(ids.size).toBe(4096);
  });
  it("reserves four admission/two caller credits, never predicts native preflight ID", async () => {
    const s = setup();
    s.h.configure({ autoLease: false });
    s.view.preflight(change(s.h), control());
    const p = s.client.current().pools;
    expect(p.mutationAdmission).toEqual({ used: 1, reserved: 3 });
    expect(p.callerOperation).toEqual({ used: 0, reserved: 2 });
    s.h.issueLease(0);
    await flush();
    expect(s.h.operations[0].handle.request.operationId).toBe("native:0");
  });
  it("localFrame gets depth64 without extending admission depth48 or compact depth32", () => {
    let v: unknown = null;
    for (let i = 0; i < 64; i++) v = { v };
    expect(() => ownHistoryJson(v, 1e6, 1000, "localFrame")).not.toThrow();
    expect(() => ownHistoryJson(v, 1e6, 1000, "admission")).toThrow();
    expect(() => ownHistoryJson(v, 1e6, 1000)).toThrow();
    expect(() => ownHistoryJson({ v }, 1e6, 1000, "localFrame")).toThrow();
  });
  it.each(["getter", "extra", "surrogate", "cycle", "symbol", "tooLarge"])(
    "rejects %s port state without evaluating provider payload",
    (kind) => {
      const s = setup(),
        input: any = { ...s.h.frame };
      let accessed = false;
      if (kind === "getter")
        Object.defineProperty(input, "resyncRequired", {
          get() {
            accessed = true;
            return false;
          },
          enumerable: true,
        });
      if (kind === "extra") input.extra = true;
      if (kind === "surrogate") input.ended = "\ud800";
      if (kind === "cycle") input.display = input;
      if (kind === "symbol") input[Symbol()] = 1;
      if (kind === "tooLarge") input.ended = "x".repeat(8 * 1024 * 1024 + 1);
      expect(() => parsePortState(s.h.frame, s.h.scope)).not.toThrow();
      expect(() => parsePortState(input, s.h.scope)).toThrow();
      expect(accessed).toBe(false);
    },
  );
  it.each([
    { attachId: "attach:1", phase: "attached" },
    { attachId: "attach:1", phase: "open", subscriptionRef: null },
    { attachId: "", phase: "attached", subscriptionRef: null },
    { attachId: "attach:1", phase: "attached", subscriptionRef: 1 },
    { attachId: "attach:1", phase: "attached", subscriptionRef: "a\n" },
    "attach:1",
  ])("rejects a malformed display generation %j", (generation) => {
    const s = setup(),
      f = s.h.frame;
    expect(() =>
      parsePortState(
        { ...f, display: { ...f.display, generation: null } },
        s.h.scope,
      ),
    ).not.toThrow();
    expect(() =>
      parsePortState(
        { ...f, display: { ...f.display, generation } },
        s.h.scope,
      ),
    ).toThrow();
    s.h.raw({ ...f, display: { ...f.display, generation } });
    expect(s.client.current().invalid).toBe(true);
  });
  it("transport ends and host refusals are closed kinds", () => {
    for (const v of [
      { kind: "returned" },
      { kind: "failed" },
      { kind: "staleSeq", seq: 3 },
      { kind: "refused", refusal: { kind: "busy" } },
      { kind: "refused", refusal: { kind: "phase", phase: "stopping" } },
      {
        kind: "refused",
        refusal: { kind: "recordingUnavailable", reason: "empty" },
      },
    ])
      expect(() => parseTransportEnd(v)).not.toThrow();
    for (const v of [
      { kind: "rejected" },
      { kind: "returned", reply: {} },
      { kind: "staleSeq", seq: -1 },
      { kind: "refused", refusal: { kind: "private" } },
      { kind: "refused", refusal: { kind: "busy", detail: "x" } },
      { kind: "refused", refusal: { kind: "phase" } },
    ])
      expect(() => parseTransportEnd(v)).toThrow();
  });
});
it.each(["rejected", "retired"])(
  "pause lease %s retry preserves later apply/discard reservations",
  async (kind) => {
    const s = setup();
    await candidate(s);
    s.h.configure({ autoLease: false });
    s.view.pause(control());
    if (kind === "rejected") s.h.rejectLease(1);
    else {
      s.view.retire();
      s.h.issueLease(1);
    }
    await flush();
    const v = kind === "retired" ? s.client.bindView(s.identity) : s.view;
    expect(s.client.current().pools.callerOperation).toEqual({
      used: 1,
      reserved: 1,
    });
    expect(v.pause(control())).toBe(true);
    expect(s.client.current().pools.callerOperation).toEqual({
      used: 2,
      reserved: 1,
    });
    s.h.issueLease(2);
    await flush();
    s.h.finish(1);
    await flush();
    expect(v.apply(control())).toBe(true);
    s.h.issueLease(3);
    await flush();
    expect(s.h.writes).toBe(1);
    s.h.finish(2);
    await flush();
    expect(s.client.current().safeToSwitch).toBe(true);
  },
);
it("retry exhaustion preserves the first reserved discard", async () => {
  const s = setup();
  await candidate(s);
  s.h.configure({ autoLease: false });
  // Fill the mutation pool with confirmed unsent pause attempts, while the
  // first apply and discard credits remain reserved. No physical stop is sent.
  for (let n = 0; n < 4093; n++) {
    expect(s.view.pause(control())).toBe(true);
    s.h.rejectLease(s.h.leases.length - 1);
    await flush();
  }
  const p = s.client.current().pools;
  expect(p.mutationAdmission).toEqual({ used: 4094, reserved: 2 });
  expect(s.view.pause(control())).toBe(false);
  expect(s.h.stops).toBe(0);
  expect(s.view.discard(control())).toBe(true);
  s.h.issueLease(s.h.leases.length - 1);
  await flush();
  expect(s.client.current().change).toBeUndefined();
  expect(s.client.current().pools.readAdmission.used).toBe(0);
}, 30000);
it.each(["\n", "\r", "\r\n"])(
  "local refs reject trailing %j in every metadata root",
  (suffix) => {
    const s = setup(),
      f = s.h.frame;
    expect(() =>
      parsePortState(
        { ...f, scope: { ...f.scope, ownerRef: s.h.ownerRef + suffix } },
        { ...s.h.scope, ownerRef: s.h.ownerRef + suffix },
      ),
    ).toThrow();
    expect(() =>
      parsePortState({ ...f, ended: "closed" + suffix }, s.h.scope),
    ).toThrow();
    expect(() =>
      parseTransportEnd({
        kind: "refused",
        refusal: { kind: "phase", phase: "stopping" + suffix },
      }),
    ).toThrow();
  },
);
it("mutation admission pool full still admits the original apply reconciliation", async () => {
  const s = setup();
  await candidate(s);
  s.h.configure({ autoLease: false });
  for (let n = 0; n < 4092; n++) {
    expect(s.view.pause(control())).toBe(true);
    s.h.rejectLease(s.h.leases.length - 1);
    await flush();
  }
  expect(s.view.pause(control())).toBe(true);
  s.h.issueLease(s.h.leases.length - 1);
  await flush();
  s.h.finish(1);
  await flush();
  expect(s.view.apply(control())).toBe(true);
  s.h.issueLease(s.h.leases.length - 1);
  await flush();
  s.h.finish(2, "workerFailure");
  await flush();
  expect(s.client.current().pools.mutationAdmission).toEqual({
    used: 4095,
    reserved: 1,
  });
  expect(s.view.reconcile(control())).toBe(true);
  s.h.issueLease(s.h.leases.length - 1);
  await flush();
  s.h.finishRead(0);
  await flush();
  expect(s.client.current().lastApplied).toBeDefined();
  expect(s.client.current().pools.readAdmission.used).toBe(1);
}, 30000);
it("native lease budget is measured from mock issuance, without JS clock conversion or extension", async () => {
  const h = createAsyncPortHarness(),
    admit = h.impl.admit;
  h.impl.admit = (r) => {
    h.advanceNative(500);
    return admit(r);
  };
  const root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
    v = root.client.bindView({});
  expect(v.preflight(change(h), control())).toBe(true);
  await flush();
  expect(root.client.current().admission).toBe("rejected");
  expect(h.operations).toHaveLength(0);
  expect(root.client.current().reply?.outcome).toEqual({
    kind: "rejected",
    error: "deadlineExceeded",
  });
});
it("observation accessors are never evaluated and cannot create native authority", async () => {
  const h = createAsyncPortHarness(),
    observe = h.impl.observe;
  let accessed = false;
  h.impl.observe = (target) => {
    const raw = observe(target);
    return Object.defineProperty({ target: raw.target }, "result", {
      get() {
        accessed = true;
        return raw.result;
      },
      enumerable: true,
    }) as typeof raw;
  };
  const root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
    v = root.client.bindView({});
  v.preflight(change(h), control());
  await flush();
  expect(accessed).toBe(false);
  expect(root.client.current().invalid).toBe(true);
  expect(v.pause(control())).toBe(false);
});
it("malformed admission completion is unknown rather than a pending ACK", async () => {
  const s = setup();
  s.h.configure({ autoAck: false });
  s.view.preflight(change(s.h), control());
  await flush();
  s.h.admissions[0].resolve({ malformed: true });
  await flush();
  expect(s.client.current().admission).toBe("unknown");
  expect(s.client.current().call).toBe("uncertain");
});
it("a new stage cannot reuse an earlier native operation ref", async () => {
  const h = createAsyncPortHarness(),
    admit = h.impl.admit;
  h.impl.admit = (r) => {
    const c = admit(r);
    if (r.action.kind !== "pauseJoin") return c;
    return {
      request: c.request,
      transport: c.transport,
      reply: c.reply.then((ack: any) => ({
        ...ack,
        outcome: {
          ...ack.outcome,
          handle: {
            ...ack.outcome.handle,
            operationRef: h.operations[0].handle.operationRef,
          },
        },
      })),
    } as typeof c;
  };
  const root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
    v = root.client.bindView({});
  v.preflight(change(h), control());
  await flush();
  h.finish(0);
  await flush();
  expect(v.pause(control())).toBe(true);
  await flush();
  expect(root.client.current().invalid).toBe(true);
  expect(root.client.current().canApply).toBe(false);
});
it.each([false, undefined, "true", "throw"])(
  "live qualification %j prevents all new dispatch and retires the view",
  async (value) => {
    const s = setup();
    let allowed = false;
    const view = s.client.bindView({}, (() => {
      if (allowed) return true;
      if (value === "throw") throw Error("private");
      return value;
    }) as any);
    expect(view.preflight(change(s.h), control())).toBe(false);
    allowed = true;
    expect(view.preflight(change(s.h), control())).toBe(false);
    expect(s.h.leases).toHaveLength(0);
    expect(s.client.current().invalid).toBe(false);
  },
);
it("qualifier reentry cannot dispatch through another client view", async () => {
  const s = setup(),
    other = s.client.bindView({}),
    attempts: boolean[] = [];
  const view = s.client.bindView({}, () => {
    attempts.push(other.preflight(change(s.h, 2), control()));
    return true;
  });
  expect(view.preflight(change(s.h), control())).toBe(true);
  await flush();
  expect(attempts.length).toBeGreaterThan(1);
  expect(attempts.every((v) => v === false)).toBe(true);
  expect(s.h.leases).toHaveLength(1);
  expect(s.h.admissions).toHaveLength(1);
});
it("live qualifier cannot reopen a gate it closes synchronously", () => {
  const s = setup(),
    view = s.client.bindView({}, () => {
      s.root.close();
      return true;
    });
  expect(view.preflight(change(s.h), control())).toBe(false);
  expect(s.h.leases).toHaveLength(0);
  expect(s.client.current().closed).toBe(true);
});
it("live prop qualification stops a settled lease before any reactive selection effect", async () => {
  const s = setup();
  s.h.configure({ autoLease: false });
  let current = true;
  const view = s.client.bindView({}, () => current);
  view.preflight(change(s.h), control());
  s.h.issueLease(0);
  current = false;
  await flush();
  expect(s.h.admissions).toHaveLength(0);
  current = true;
  expect(view.preflight(change(s.h, 2), control())).toBe(false);
});
it("readUncertain delivered during cancellation notification stops the unsent cancel", async () => {
  const s = setup();
  await appliedUnknown(s);
  s.view.reconcile(control());
  await flush();
  let delivered = false;
  s.client.subscribe((v) => {
    if (v.cancelCall === "pending" && !delivered) {
      delivered = true;
      s.h.finishRead(0, "readUncertain");
    }
  });
  expect(s.view.cancelReconciliation()).toBe(true);
  expect(s.h.cancels).toHaveLength(0);
  await flush();
  expect(s.client.current().read).toBe("readUncertain");
  expect(s.client.current().invalid).toBe(false);
  expect(s.client.current().cancelCall).toBe("idle");
});
it("readUncertain delivered during inspection notification stops the unsent inspection", async () => {
  const s = setup();
  await appliedUnknown(s);
  s.h.configure({ autoAck: false });
  s.view.reconcile(control());
  await flush();
  s.h.ack(3, "unknown");
  await flush();
  let delivered = false;
  s.client.subscribe((v) => {
    if (v.inspectionCall === "pending" && !delivered) {
      delivered = true;
      s.h.emit({ admission: s.h.admissions[3].accepted! });
      s.h.finishRead(0, "readUncertain");
    }
  });
  expect(s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
    true,
  );
  expect(s.h.inspections).toHaveLength(0);
  await flush();
  expect(s.client.current().read).toBe("readUncertain");
  expect(s.client.current().invalid).toBe(false);
  expect(s.client.current().inspectionCall).toBe("idle");
});
it.each([
  "operation:retire",
  "operation:disconnect",
  "read:retire",
  "read:disconnect",
])(
  "definitely unsent %s cancellation preserves eligibility for a current view",
  async (mode) => {
    const s = setup(),
      read = mode.startsWith("read:");
    if (read) {
      await appliedUnknown(s);
      s.view.reconcile(control());
      await flush();
    } else {
      s.view.preflight(change(s.h), control());
      await flush();
    }
    let interrupted = false;
    s.client.subscribe((v) => {
      if (v.cancelCall === "pending" && !interrupted) {
        interrupted = true;
        if (mode.endsWith("retire")) s.view.retire();
        else s.h.emit({ connected: false });
      }
    });
    expect(
      read ? s.view.cancelReconciliation() : s.view.cancelOperation(),
    ).toBe(true);
    expect(s.h.cancels).toHaveLength(0);
    expect(s.client.current().cancelCall).toBe("idle");
    s.h.emit({ connected: true });
    const next = s.client.bindView(s.identity);
    expect(
      read ? s.client.current().canCancelRead : s.client.current().canCancel,
    ).toBe(true);
    expect(read ? next.cancelReconciliation() : next.cancelOperation()).toBe(
      true,
    );
    await flush();
    expect(s.h.cancels).toHaveLength(1);
    expect(read ? next.cancelReconciliation() : next.cancelOperation()).toBe(
      false,
    );
  },
);
it.each(["notFound", "receiptFound"])(
  "cached %s with historical unknown quiescence is idempotent after native confirmation",
  async (kind) => {
    const s = setup();
    await appliedUnknown(s);
    s.view.reconcile(control());
    await flush();
    const d = s.h.finishRead(0, kind, { quiescence: "unknown" });
    await flush();
    expect(s.client.current().latest?.quiescence).toBe("unknown");
    const original = s.client.current().completion;
    s.h.emit({
      operation: {
        operationRef: s.h.operations[2].handle.operationRef,
        result: { ...s.h.result(2, "workerFailure"), quiescence: "confirmed" },
      },
    });
    await flush();
    expect(s.client.current().invalid).toBe(false);
    expect(s.client.current().latest?.quiescence).toBe("confirmed");
    expect(s.client.current().completion).toBe(original);
    expect(s.client.current().delivery).toEqual(d);
    expect(s.client.current().canReconcile).toBe(true);
  },
);
it("first late historical read delivery cannot erase confirmed original quiescence", async () => {
  const s = setup();
  await appliedUnknown(s);
  s.view.reconcile(control());
  await flush();
  const r = s.h.reads[0],
    request = r.handle.request;
  const delivery = {
    version: 1,
    kind: "recordingReconciliationDelivery",
    ownerRef: s.h.ownerRef,
    readRef: r.handle.readRef,
    request,
    outcome: {
      kind: "result",
      result: {
        version: 1,
        kind: "recordingReconciliationResult",
        request,
        outcome: {
          kind: "receiptFound",
          receipt: s.h.receipt(request.operation),
        },
        quiescence: "unknown",
        recoveryRequired: true,
      },
    },
  } as const;
  s.h.emit({
    operation: {
      operationRef: s.h.operations[2].handle.operationRef,
      result: { ...s.h.result(2, "workerFailure"), quiescence: "confirmed" },
    },
    reconciliation: delivery,
  });
  expect(s.client.current().invalid).toBe(false);
  expect(s.client.current().latest?.quiescence).toBe("confirmed");
  expect(s.client.current().lastApplied).toBeDefined();
  expect(s.client.current().canReconcile).toBe(false);
  r.resolve(delivery);
  await flush();
  expect(s.client.current().canReconcile).toBe(true);
  expect(s.client.current().latest?.quiescence).toBe("confirmed");
});
it("changed immutable reconciliation delivery stays invalid without losing receipt evidence", async () => {
  const s = setup();
  await appliedUnknown(s);
  s.view.reconcile(control());
  await flush();
  const d = s.h.finishRead(0);
  await flush();
  const known = s.client.current().delivery;
  s.h.emit({
    reconciliation: {
      ...d,
      outcome: { kind: "readUncertain", error: "workerFailure" },
    },
  });
  expect(s.client.current().invalid).toBe(true);
  expect(s.client.current().delivery).toBe(known);
  expect(s.client.current().lastApplied).toBeDefined();
});
describe("port v2 owner state, access and lease roles", () => {
  it.each([
    ["ownerClosed", { ownerClosed: "controlFrame" }],
    ["authorizationLost", { authorizationLost: "seqChanged" }],
    ["resyncRequired", { resyncRequired: true }],
  ] as const)(
    "%s is its own field and closes every action",
    async (field, patch) => {
      const s = setup();
      await candidate(s);
      expect(s.client.current().canPause).toBe(true);
      s.h.emit(patch);
      const st = s.client.current();
      expect(st.owner[field]).toBe(Object.values(patch)[0]);
      for (const other of [
        "ownerClosed",
        "authorizationLost",
        "resyncRequired",
      ] as const)
        if (other !== field)
          expect(st.owner[other]).toBe(
            other === "resyncRequired" ? false : null,
          );
      expect(st.closed).toBe(false);
      expect(st.invalid).toBe(false);
      expect(st.ownerBlocked).toBe(false);
      for (const k of [
        "canPreflight",
        "canPause",
        "canApply",
        "canDiscard",
        "canInspect",
        "canReconcile",
        "canCancel",
        "canCancelRead",
      ] as const)
        expect(st[k]).toBe(false);
      expect(s.view.pause(control())).toBe(false);
      expect(s.view.discard(control())).toBe(false);
      expect(s.h.leases).toHaveLength(1);
    },
  );
  it("nativeRecoveryRequired is sticky ownerBlocked, separate from the other owner fields", async () => {
    const s = setup();
    await candidate(s);
    s.h.emit({ ownerBlocked: true });
    s.h.emit({ ownerBlocked: false });
    const st = s.client.current();
    expect(st.ownerBlocked).toBe(true);
    expect(st.owner.nativeRecoveryRequired).toBe(false);
    expect(st.owner.ownerClosed).toBeNull();
    expect(st.canPause).toBe(false);
    expect(st.canDiscard).toBe(false);
  });
  it("connected needs an attached subscription as well as the transport", async () => {
    const s = setup();
    await candidate(s);
    s.h.emit({ subscription: "attaching" });
    expect(s.client.current().connected).toBe(false);
    expect(s.view.pause(control())).toBe(false);
    s.h.emit({ subscription: "attached" });
    expect(s.client.current().connected).toBe(true);
    expect(s.client.current().owner.seq).toBe(1);
    expect(s.view.pause(control())).toBe(true);
  });
  it("cached frames are used only when the display has a snapshot relation", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.emit({
      admission: s.h.admissions[0].accepted!,
      snapshotRelation: "none",
    });
    expect(s.client.current().admission).toBe("awaitingAck");
    s.h.emit({ snapshotRelation: "lastKnown" });
    expect(s.client.current().admission).toBe("accepted");
    expect(s.client.current().call).toBe("admit");
  });
  it("read access never sends a mutation, but may reconcile and inspect", async () => {
    const h = createAsyncPortHarness(undefined, { access: "read" }),
      root = createAsyncRecordingOperationsCoordinator(h.port, () => now),
      view = root.client.bindView({});
    const st = root.client.current();
    expect(st.owner.access).toBe("read");
    expect(st.canPreflight).toBe(false);
    expect(view.preflight(change(h), control())).toBe(false);
    await flush();
    expect(h.leases).toHaveLength(0);
    expect(h.admissions).toHaveLength(0);
  });
  it("lease requests carry role, stage, operationId and the wire scope", async () => {
    const s = setup();
    await appliedUnknown(s);
    s.view.reconcile(control());
    await flush();
    const [pre, pause, apply, read] = s.h.leases.map((l) => l.request);
    const ops = s.h.admissions.map((a) => a.request.action);
    expect(pre).toEqual({
      role: "mutation",
      stage: "preflight",
      change: change(s.h),
      lease: pre.lease,
    });
    for (const [l, a, stage] of [
      [pause, ops[1], "pauseJoin"],
      [apply, ops[2], "apply"],
    ] as const) {
      if (a.kind !== "pauseJoin" && a.kind !== "apply") throw Error("stage");
      expect(l).toEqual({
        role: "mutation",
        stage,
        operationId: a.operation.operationId,
        lease: l.lease,
      });
    }
    expect(read).toEqual({ role: "reconciliation", lease: read.lease });
    for (const [l, role] of [
      [pre, "mutation"],
      [pause, "mutation"],
      [apply, "mutation"],
      [read, "reconciliation"],
    ] as const) {
      expect(l.lease.role).toBe(role);
      expect(l.lease.scope).toEqual(s.h.scope);
      expect(l.lease.leaseRequestId).toMatch(/^ls:/);
      expect(l.lease.requestedBudgetMs).toBe(500);
    }
    expect(
      new Set(s.h.leases.map((l) => l.request.lease.leaseRequestId)).size,
    ).toBe(4);
    expect(s.h.admissions.map((a) => a.request.admissionId)).toEqual(
      s.h.leases.map((l) => l.request.lease.admissionId),
    );
    expect(s.client.current().pools.lease).toEqual({ used: 4, reserved: 0 });
  });
  it("discard lease has no operationId and a wire lease rejection is kept apart", async () => {
    const s = setup();
    await candidate(s);
    s.h.configure({ autoLease: false });
    s.view.discard(control());
    expect(s.h.leases[1].request).toEqual({
      role: "mutation",
      stage: "discard",
      lease: s.h.leases[1].request.lease,
    });
    s.h.rejectLease(1, "expired");
    await flush();
    const st = s.client.current();
    expect(st.wireRefusal).toBe("expired");
    expect(st.refusal).toBeUndefined();
    expect(st.call).toBe("idle");
    expect(st.canDiscard).toBe(true);
  });
});
