import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncRecordingOperationsCoordinator } from "./coordinator";
import { createAsyncPortHarness } from "../__fixtures__/recording-async-port";
import { operationsProject } from "../__fixtures__/recording-operations-service";
import { parseRecordingChangeRequest } from "../recording-operations-contract";
import { parseRecordingAdmissionReply } from "../recording-admission-contract";
import { createIdPools, ID_ROLES } from "./ids";
import {
  parseLeaseReply,
  parseOwnerFrame,
  parseCancelReply,
} from "./local-validation";
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
  it.each(["reject", "malformed", "throw", "thenable"])(
    "admit %s is a permanent uncertain call, never a native result",
    async (kind) => {
      const s = setup();
      s.h.configure({ autoAck: false });
      if (kind === "throw")
        s.h.port.admit = () => {
          throw Error("PRIVATE_URL_CREDENTIAL");
        };
      if (kind === "thenable") s.h.port.admit = (() => ({ then() {} })) as any;
      // Capture changes in a new root, not by mutating an existing port.
      const root =
        kind === "throw" || kind === "thenable"
          ? (() => {
              const h = createAsyncPortHarness();
              h.port.admit = s.h.port.admit;
              return {
                h,
                root: createAsyncRecordingOperationsCoordinator(
                  h.port,
                  () => now,
                ),
              };
            })()
          : { h: s.h, root: s.root };
      const v = root.root.client.bindView({});
      v.preflight(change(root.h), control());
      await flush();
      if (kind === "reject")
        root.h.admissions[0].reject(Error("PRIVATE_URL_CREDENTIAL"));
      if (kind === "malformed")
        root.h.admissions[0].resolve({ unexpected: "PRIVATE_URL_CREDENTIAL" });
      await flush();
      expect(root.root.client.current().invalid).toBe(true);
      expect(root.root.client.current().call).toBe("uncertain");
      expect(v.inspectAdmission({ deadlineMonotonicMs: now + 500 })).toBe(
        false,
      );
      expect(JSON.stringify(root.root.client.current())).not.toContain(
        "PRIVATE_URL_CREDENTIAL",
      );
    },
  );
  it("retains valid late inspection evidence after the original call rejects", async () => {
    const s = setup();
    s.h.configure({ autoAck: false, autoInspect: false });
    s.view.preflight(change(s.h), control());
    await flush();
    now = 1101;
    vi.advanceTimersByTime(1001);
    s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
    s.h.admissions[0].reject(Error("private"));
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
    expect(s.client.current().invalid).toBe(true);
    expect(s.client.current().call).toBe("uncertain");
    expect(s.view.pause(control())).toBe(false);
  });
  it("reject after accepted frame cannot discard verified result or open the gate", async () => {
    const s = setup();
    s.h.configure({ autoAck: false });
    s.view.preflight(change(s.h), control());
    await flush();
    s.h.emit({ admission: s.h.admissions[0].accepted });
    s.h.finish(0);
    await flush();
    s.h.admissions[0].reject(Error("private"));
    await flush();
    expect(s.client.current().latest?.outcome.kind).toBe("candidate");
    expect(s.client.current().canPause).toBe(false);
    expect(s.client.current().invalid).toBe(true);
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
    "%s reject retains the corresponding uncertain gate",
    async (stage) => {
      const s = setup();
      if (stage === "lease") {
        s.h.configure({ autoLease: false });
        s.view.preflight(change(s.h), control());
        s.h.leases[0].reject(Error("private"));
      }
      if (stage === "inspection") {
        s.h.configure({ autoAck: false, autoInspect: false });
        s.view.preflight(change(s.h), control());
        await flush();
        s.h.ack(0, "unknown");
        await flush();
        s.view.inspectAdmission({ deadlineMonotonicMs: now + 500 });
        s.h.inspections[0].reject(Error("private"));
      }
      if (stage === "cancel" || stage === "operation") {
        s.h.configure({ autoCancel: false });
        s.view.preflight(change(s.h), control());
        await flush();
        if (stage === "cancel") {
          s.view.cancelOperation();
          s.h.cancels[0].reject(Error("private"));
        } else s.h.operations[0].reject(Error("private"));
      }
      if (stage === "read") {
        await appliedUnknown(s);
        s.view.reconcile(control());
        await flush();
        s.h.reads[0].reject(Error("private"));
      }
      await flush();
      expect(s.client.current().invalid).toBe(true);
      expect(s.view.preflight(change(s.h, 2), control())).toBe(false);
      if (stage === "read")
        expect(s.client.current().read).toBe("deliveryUnknown");
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
  it("frame-first result cannot release the completion slot; reject keeps evidence", async () => {
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
    s.h.operations[0].reject(Error("private"));
    await flush();
    expect(s.client.current().invalid).toBe(true);
    expect(s.client.current().latest).toBeDefined();
  });
  it("same revision must have the same body and foreign owners never rebind", () => {
    const s = setup();
    s.h.raw(s.h.frame);
    expect(s.client.current().invalid).toBe(false);
    s.h.raw({ ...s.h.frame, connected: false });
    expect(s.client.current().invalid).toBe(true);
    const other = setup();
    other.h.raw({ ...other.h.frame, ownerRef: "foreign:owner", revision: 2 });
    expect(other.client.current().ownerRef).toBe(other.h.ownerRef);
    expect(other.client.current().invalid).toBe(true);
  });
  it("old revision with new information is rejected", () => {
    const s = setup();
    s.h.emit();
    s.h.raw({ ...s.h.frame, revision: 1 });
    expect(s.client.current().invalid).toBe(false);
    s.h.raw({ ...s.h.frame, revision: 1, ownerBlocked: true });
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
  it("changed method/context is stopped before any new lease", async () => {
    const s = setup();
    s.h.port.prepareLease = () => Promise.resolve({});
    expect(s.view.preflight(change(s.h), control())).toBe(false);
    expect(s.h.leases).toHaveLength(0);
    expect(s.client.current().invalid).toBe(true);
    s.h.emit();
    expect(s.client.current().invalid).toBe(true);
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
    r.reject(Error("private"));
    await flush();
    expect(s.client.current().read).toBe("deliveryUnknown");
    expect(s.client.current().lastApplied).toBeDefined();
    expect(s.client.current().invalid).toBe(true);
  });
  it("cancel is one call for the target; requested is never completion", async () => {
    const s = setup();
    s.h.configure({ autoCancel: false });
    s.view.preflight(change(s.h), control());
    await flush();
    expect(s.view.cancelOperation()).toBe(true);
    expect(s.view.cancelOperation()).toBe(false);
    const c = s.h.cancels[0];
    c.resolve({ request: c.request, disposition: "requested" });
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
    "rejects %s metadata without evaluating provider payload",
    (kind) => {
      const s = setup(),
        input: any = { ...s.h.frame };
      let accessed = false;
      if (kind === "getter")
        Object.defineProperty(input, "connected", {
          get() {
            accessed = true;
            return true;
          },
          enumerable: true,
        });
      if (kind === "extra") input.extra = true;
      if (kind === "surrogate") input.ownerRef = "\ud800";
      if (kind === "cycle") input.context = input;
      if (kind === "symbol") input[Symbol()] = 1;
      if (kind === "tooLarge") input.ownerRef = "x".repeat(1024 * 1024 + 1);
      expect(() => parseOwnerFrame(input)).toThrow();
      expect(accessed).toBe(false);
    },
  );
  it("lease and cancellation metadata use independent strict profiles and closed errors", () => {
    const s = setup();
    const r = {
      ownerRef: s.h.ownerRef,
      admissionId: "admission:1",
      context: s.h.context,
      requestedBudgetMs: 1,
    };
    expect(() =>
      parseLeaseReply({
        request: r,
        outcome: { kind: "issued", deadlineLeaseRef: "lease:1" },
      }),
    ).not.toThrow();
    expect(() =>
      parseLeaseReply({
        request: { ...r, requestedBudgetMs: 10001 },
        outcome: { kind: "rejected", error: "private" },
      }),
    ).toThrow();
    expect(() =>
      parseCancelReply({
        request: {
          ownerRef: s.h.ownerRef,
          target: { kind: "operation", ref: "operation:1" },
        },
        disposition: "stopped",
      }),
    ).toThrow();
  });
});
it.each(["rejected", "retired"])(
  "pause lease %s retry preserves later apply/discard reservations",
  async (kind) => {
    const s = setup();
    await candidate(s);
    s.h.configure({ autoLease: false });
    s.view.pause(control());
    if (kind === "rejected")
      s.h.leases[1].resolve({
        request: s.h.leases[1].request,
        outcome: { kind: "rejected", error: "busy" },
      });
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
    const l = s.h.leases.at(-1)!;
    l.resolve({
      request: l.request,
      outcome: { kind: "rejected", error: "busy" },
    });
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
      r = {
        ownerRef: s.h.ownerRef,
        admissionId: "admission:1",
        context: s.h.context,
        requestedBudgetMs: 1,
      };
    expect(() =>
      parseOwnerFrame({ ...s.h.frame, ownerRef: s.h.ownerRef + suffix }),
    ).toThrow();
    expect(() =>
      parseLeaseReply({
        request: r,
        outcome: { kind: "issued", deadlineLeaseRef: "lease:1" + suffix },
      }),
    ).toThrow();
    expect(() =>
      parseCancelReply({
        request: {
          ownerRef: s.h.ownerRef,
          target: { kind: "operation", ref: "op:1" + suffix },
        },
        disposition: "requested",
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
    const l = s.h.leases.at(-1)!;
    l.resolve({
      request: l.request,
      outcome: { kind: "rejected", error: "busy" },
    });
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
    admit = h.port.admit;
  h.port.admit = (r) => {
    h.advanceNative(500);
    return admit.call(h.port, r);
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
    observe = h.port.observeOperation;
  let accessed = false;
  h.port.observeOperation = (ref) => {
    const raw = observe.call(h.port, ref);
    return Object.defineProperty({ ...raw }, "completion", {
      get() {
        accessed = true;
        return raw.completion;
      },
      enumerable: true,
    });
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
    admit = h.port.admit;
  h.port.admit = async (r) => {
    const ack = await admit.call(h.port, r);
    if (r.action.kind !== "pauseJoin") return ack;
    const typed = ack as any;
    return {
      ...typed,
      outcome: {
        ...typed.outcome,
        handle: {
          ...typed.outcome.handle,
          operationRef: h.operations[0].handle.operationRef,
        },
      },
    };
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
