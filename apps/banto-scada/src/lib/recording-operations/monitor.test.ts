import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationsHarness,
  operationsProject,
} from "../__fixtures__/recording-operations-service";
import { createRecordingOperationsMonitor } from "./monitor";
import {
  recordingOperationsSelection,
  RecordingOperationRejected,
  type RecordingOperationsService,
} from "./service";
import {
  parseRecordingChangeRequest,
  parseRecordingOperationResult,
} from "../recording-operations-contract";
import { mergeResult, ownerView } from "./view";
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
function setup(service?: RecordingOperationsService, now?: () => number) {
  const h = createOperationsHarness(),
    m = createRecordingOperationsMonitor(now);
  cleanups.push(() => m.dispose());
  function bind(
    source = service ?? h.service,
    project = operationsProject,
    generation = 1,
  ) {
    const s = recordingOperationsSelection(source, project, generation, {});
    if (s.phase !== "ready") throw Error("fixture binding");
    m.select(s);
    return s.binding;
  }
  const b = bind();
  const change = (id = "1") =>
    parseRecordingChangeRequest({
      version: 1,
      kind: "recordingChangeRequest",
      changeId: `change:${id}`,
      context: b.context,
      apply: {
        requestId: `apply:${id}`,
        desired: b.desired,
        expectedAppliedRevision: null,
        expectedMappingRevision: 1,
        expectedRetentionAppliedRevision: 1,
      },
    });
  const start = () => m.preflight(b, change(), 1000);
  const paused = async () => {
    start();
    h.finish(0);
    await flush();
    m.pauseJoin(b, 1000);
    h.finish(1);
    await flush();
  };
  const applying = async () => {
    await paused();
    m.apply(b, 1000);
  };
  return { h, m, b, bind, change, start, paused, applying };
}
it("keeps preflight, pauseJoin and apply explicit, immutable and ordered", async () => {
  const { h, m, b, start } = setup();
  expect(m.state.canPreflight).toBe(true);
  start();
  expect(h.stops).toBe(0);
  expect(m.apply(b, 1000)).toBe(false);
  const candidate = h.finish(0);
  await flush();
  expect(m.state.canPause).toBe(true);
  expect(h.calls).toHaveLength(1);
  m.pauseJoin(b, 1000);
  expect(h.stops).toBe(1);
  expect(m.requestCancel()).toBeUndefined();
  expect(m.apply(b, 1000)).toBe(false);
  h.finish(1);
  await flush();
  expect(m.state.canApply).toBe(true);
  m.apply(b, 1000);
  expect(h.writes).toBe(1);
  expect(m.apply(b, 1000)).toBe(false);
  h.finish(2);
  await flush();
  expect(m.state.phase).toBe("completed");
  expect(m.state.latest?.outcome.kind).toBe("applied");
  expect(h.maxPhysical).toBe(1);
  expect(candidate.request.change).toEqual(h.calls[2].handle.request.change);
  expect(h.cancels).toBe(0);
});
it.each(["replay", "conflict"])(
  "%s preflight never stops or creates candidate actions",
  async (kind) => {
    const { h, m, start } = setup();
    start();
    h.finish(0, kind);
    await flush();
    expect(m.state.canPause).toBe(false);
    expect(m.state.canApply).toBe(false);
    expect(h.stops).toBe(0);
    expect(h.writes).toBe(0);
    expect(m.state.lastApplied).toBeUndefined();
  },
);
it("discard is explicit and candidate does not continue automatically", async () => {
  const { h, m, b, start } = setup();
  start();
  h.finish(0);
  await flush();
  expect(m.discard(b)).toBe(true);
  expect(m.state.phase).toBe("idle");
  expect(h.stops).toBe(0);
  expect(h.cancels).toBe(0);
});
it("keeps the candidate after a typed undispatched refusal", async () => {
  const s = setup();
  s.start();
  s.h.finish(0);
  await flush();
  const service = {
    ...s.h.service,
    pauseJoin() {
      throw new RecordingOperationRejected("busy", s.h.view);
    },
  };
  const m = createRecordingOperationsMonitor();
  cleanups.push(() => m.dispose());
  const selection = recordingOperationsSelection(
    service,
    operationsProject,
    1,
    {},
  );
  if (selection.phase !== "ready") throw Error();
  m.select(selection);
  await flush();
  m.pauseJoin(selection.binding, 1000);
  expect(m.state.refusal).toBe("busy");
  expect(m.state.invalid).toBe(false);
  expect(m.state.canPause).toBe(true);
  expect(s.h.stops).toBe(0);
});
it("unknown synchronous dispatch failure blocks instead of becoming idle", () => {
  const s = setup({
    ...createOperationsHarness().service,
    preflight() {
      throw Error("PRIVATE");
    },
  });
  s.start();
  expect(s.m.state.invalid).toBe(true);
  expect(s.m.state.canPreflight).toBe(false);
});
it("synchronous service reentry and observer reentry cannot dispatch duplicates", async () => {
  const { h, m, b, change, start } = setup();
  let attempts = 0;
  h.setHook(() => {
    attempts++;
    expect(m.preflight(b, change("nested"), 1000)).toBe(false);
    expect(m.pauseJoin(b, 1000)).toBe(false);
  });
  start();
  h.setHook(undefined);
  h.finish(0);
  await flush();
  const off = m.subscribe((s) => {
    if (s.issuing) m.pauseJoin(b, 1000);
  });
  m.pauseJoin(b, 1000);
  off();
  expect(attempts).toBeGreaterThan(0);
  expect(h.calls).toHaveLength(2);
  expect(h.maxPhysical).toBe(1);
});
it("a listener can unsubscribe or throw without breaking later delivery", () => {
  const { m, start } = setup();
  const fail = m.subscribe(() => {
    throw Error("consumer");
  });
  let count = 0;
  const off = m.subscribe(() => count++);
  start();
  expect(count).toBeGreaterThan(1);
  off();
  fail();
});
it("reentrant dispose before dispatch suppresses a new mutation", () => {
  const { h, m, start } = setup();
  m.subscribe((s) => {
    if (s.issuing) m.dispose();
  });
  expect(start()).toBe(false);
  expect(h.calls).toHaveLength(0);
});
it("closing the screen does not cancel and a late receipt remains visible", async () => {
  const { h, m, b, applying, bind } = setup();
  await applying();
  m.select({ phase: "offline" });
  expect(h.cancels).toBe(0);
  h.finish(2);
  await flush();
  expect(m.state.latest?.outcome.kind).toBe("applied");
  bind();
  expect(m.state.oldOwner).toBe(false);
  expect(m.state.lastApplied?.request).toEqual(h.calls[2].handle.request);
  expect(h.writes).toBe(1);
});
it("a same-ID Project object replacement blocks old candidate actions", async () => {
  const { h, m, b, start, bind } = setup();
  start();
  h.finish(0);
  await flush();
  const replacement = structuredClone(operationsProject);
  bind(h.service, replacement, 2);
  expect(m.state.oldOwner).toBe(true);
  expect(m.state.canPause).toBe(false);
  expect(m.pauseJoin(b, 1000)).toBe(false);
  expect(h.stops).toBe(0);
});
it("service replacement waits for the original owner to become safe, then explicitly reattaches", async () => {
  const { h, m, applying, bind } = setup();
  await applying();
  const other = createOperationsHarness();
  bind(other.service);
  expect(m.state.canSwitch).toBe(false);
  expect(m.state.canPreflight).toBe(false);
  h.finish(2);
  await flush();
  expect(m.state.canSwitch).toBe(true);
  expect(other.calls).toHaveLength(0);
  m.switchToSelected();
  expect(m.state.canPreflight).toBe(true);
  expect(m.state.oldOwner).toBe(false);
});
it("same-service Project replacement can reattach after a clean completion", async () => {
  const { h, m, start, bind } = setup();
  start();
  h.finish(0, "conflict");
  await flush();
  bind(h.service, structuredClone(operationsProject), 2);
  expect(m.state.canSwitch).toBe(true);
  m.switchToSelected();
  await flush();
  expect(m.state.oldOwner).toBe(false);
  expect(m.state.canPreflight).toBe(true);
});
it("timeouts only mark waiting; cancellation is explicit and late success is retained", async () => {
  vi.useFakeTimers();
  const { h, m, start } = setup();
  start();
  await vi.advanceTimersByTimeAsync(1001);
  expect(m.state.timedOut).toBe(true);
  expect(h.cancels).toBe(0);
  expect(m.state.canPreflight).toBe(false);
  expect(m.requestCancel()).toBe("requested");
  expect(h.cancels).toBe(1);
  h.finish(0);
  await flush();
  expect(m.state.canPause).toBe(true);
});
it("App disposal leaves external owner and completion alive for remount", async () => {
  const { h, m, start } = setup();
  start();
  m.dispose();
  const next = createRecordingOperationsMonitor();
  cleanups.push(() => next.dispose());
  const selection = recordingOperationsSelection(
    h.service,
    operationsProject,
    1,
    {},
  );
  next.select(selection);
  expect(next.state.canPreflight).toBe(false);
  h.finish(0);
  await flush();
  expect(next.state.canPause).toBe(true);
  expect(h.cancels).toBe(0);
  expect(h.calls).toHaveLength(1);
});
it("unknown physical state blocks replacement even after the Promise settles", async () => {
  const { h, m, applying, bind } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  bind(createOperationsHarness().service);
  expect(m.state.canSwitch).toBe(false);
  expect(m.state.canPreflight).toBe(false);
  expect(m.state.canReconcile).toBe(true);
});
it("explicit reconciliation preserves immutable completion, receipt, and recovery latch", async () => {
  const { h, m, applying } = setup();
  await applying();
  const original = h.finish(2, "workerFailure");
  await flush();
  expect(m.reconcile(1000)).toBe(true);
  expect(m.reconcile(1000)).toBe(false);
  expect(h.reads[0].handle.request.operation).toEqual(
    h.calls[2].handle.request,
  );
  h.finishRead(0);
  await flush();
  expect(await h.calls[2].handle.completion).toEqual(original);
  expect(m.state.latest?.outcome.kind).toBe("applied");
  expect(m.state.latest?.recoveryRequired).toBe(true);
  expect(m.state.canPreflight).toBe(false);
  expect(m.state.invalid).toBe(false);
  m.reconcile(1000);
  h.finishRead(1, "notFound");
  await flush();
  expect(m.state.latest?.outcome.kind).toBe("applied");
  expect(h.writes).toBe(1);
});
it("receiptFound with unknown quiescence is commit evidence without send permission", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  m.reconcile(1000);
  h.finishRead(0, "receiptFound", { quiescence: "unknown" });
  await flush();
  expect(m.state.latest?.outcome.kind).toBe("applied");
  expect(m.state.latest?.quiescence).toBe("unknown");
  expect(m.state.canPreflight).toBe(false);
  expect(m.state.invalid).toBe(false);
});
it("read cancellation is separate and never enables another physical apply", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  m.reconcile(1000);
  expect(m.requestCancel(true)).toBe("requested");
  expect(h.readCancels).toBe(1);
  expect(h.cancels).toBe(0);
  expect(m.reconcile(1000)).toBe(false);
});
it("reentrant dispose before read dispatch suppresses reconciliation", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  m.subscribe((s) => {
    if (s.issuing) m.dispose();
  });
  expect(m.reconcile(1000)).toBe(false);
  expect(h.reads).toHaveLength(0);
});
it("a pending provider read is reattached across App disposal", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  m.reconcile(1000);
  m.dispose();
  const next = createRecordingOperationsMonitor();
  cleanups.push(() => next.dispose());
  next.select(
    recordingOperationsSelection(h.service, operationsProject, 1, {}),
  );
  expect(next.state.canReconcile).toBe(false);
  h.finishRead(0);
  await flush();
  expect(next.state.latest?.outcome.kind).toBe("applied");
  expect(next.state.invalid).toBe(false);
});
it("completion-first notifications do not replace a newer receipt with the previous success", async () => {
  const { h, m, b, change, applying } = setup();
  await applying();
  h.finish(2);
  await flush();
  const old = m.state.lastApplied;
  m.preflight(b, change("second"), 1000);
  h.finish(3);
  await flush();
  m.pauseJoin(b, 1000);
  h.finish(4);
  await flush();
  m.apply(b, 1000);
  const value = h.result(5);
  h.calls[5].settled = true;
  h.calls[5].resolve(value);
  await flush();
  expect(m.state.invalid).toBe(false);
  expect(m.state.lastApplied?.request).toEqual(value.request);
  expect(m.state.lastApplied).not.toEqual(old);
});
it("provider blocked notification after clean success is retained", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2);
  await flush();
  h.set({ phase: "blocked" });
  expect(m.state.phase).toBe("blocked");
  expect(m.state.canPreflight).toBe(false);
  h.set({ phase: "completed" });
  expect(m.state.canPreflight).toBe(false);
});
it("a malformed echo blocks and cannot erase known success", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2);
  await flush();
  const receipt = m.state.lastApplied;
  h.set({
    latest: {
      ...h.view.latest!,
      request: { ...h.view.latest!.request, operationId: "wrong" },
    },
  });
  expect(m.state.invalid).toBe(true);
  expect(m.state.lastApplied).toEqual(receipt);
  expect(m.state.canPreflight).toBe(false);
});
it("conflicting known receipt is invalid and original evidence is retained", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2);
  await flush();
  const old = m.state.lastApplied;
  const latest = h.view.latest!;
  if (latest.outcome.kind !== "applied") throw Error();
  h.set({
    latest: parseRecordingOperationResult({
      ...latest,
      outcome: {
        kind: "applied",
        receipt: { ...latest.outcome.receipt, desiredHash: "f".repeat(64) },
      },
    }),
  });
  expect(m.state.invalid).toBe(true);
  expect(m.state.lastApplied).toEqual(old);
});
it("a rejected completion is uncertain and has no automatic retry", async () => {
  const { h, m, start } = setup();
  start();
  h.reject(0);
  await flush();
  expect(m.state.invalid).toBe(true);
  expect(m.state.canPreflight).toBe(false);
  expect(h.calls).toHaveLength(1);
});
it("method receiver is retained and methods are captured at binding", () => {
  const h = createOperationsHarness();
  const service = {
    ...h.service,
    current() {
      expect(this).toBe(service);
      return h.view;
    },
  };
  const s = setup(service);
  service.current = () => {
    throw Error("replaced");
  };
  s.m.refresh();
  expect(s.m.state.invalid).toBe(false);
});
it("does not invoke an accessor in an owner view", () => {
  const { h, m } = setup();
  let calls = 0;
  const raw = { ...h.view };
  Object.defineProperty(raw, "latest", {
    get() {
      calls++;
      return null;
    },
  });
  h.publishRaw(raw);
  expect(m.state.invalid).toBe(true);
  expect(calls).toBe(0);
});
it("owned JSON is frozen but opaque handles stay usable", async () => {
  const { h, m, start } = setup();
  start();
  h.finish(0);
  await flush();
  expect(Object.isFrozen(m.state.view?.request)).toBe(true);
  expect(
    Object.isFrozen(m.state.view?.request?.apply.desired.group.members),
  ).toBe(true);
  expect(m.state.view?.active).toBe(h.calls[0].handle);
});
it.each([0, -1, 10001, 1.1, Infinity, NaN])(
  "rejects invalid timeout %s without dispatch",
  (value) => {
    const { h, m, b, change } = setup();
    expect(() => m.preflight(b, change(), value)).toThrow();
    expect(h.calls).toHaveLength(0);
  },
);
describe("selection", () => {
  it("does not call current or dispatch when context is mismatched", () => {
    const h = createOperationsHarness();
    const source = {
      ...h.service,
      context: {
        ...h.context,
        target: { ...h.context.target, projectRevision: 999 },
      },
      current: vi.fn(h.service.current),
    };
    expect(
      recordingOperationsSelection(source, operationsProject, 1, {}).phase,
    ).toBe("contextMismatch");
    expect(source.current).not.toHaveBeenCalled();
  });
  it("offline and malformed capabilities are finite statuses", () => {
    expect(
      recordingOperationsSelection(undefined, operationsProject, 1, {}).phase,
    ).toBe("offline");
    expect(
      recordingOperationsSelection(
        {} as RecordingOperationsService,
        operationsProject,
        1,
        {},
      ).phase,
    ).toBe("invalidContext");
  });
});
it("same non-apply outcome with different object key order is equal", async () => {
  const { h, m, start } = setup();
  start();
  const r = h.result(0);
  const reversed = Object.fromEntries(Object.entries(r.outcome).reverse());
  h.set({
    latest: parseRecordingOperationResult({ ...r, outcome: reversed }),
    phase: "candidate",
  });
  h.finish(0);
  await flush();
  expect(m.state.invalid).toBe(false);
  expect(m.state.canPause).toBe(true);
});
it("late unknown evidence cannot roll back confirmed quiescence or remove recovery latch", async () => {
  const { h, applying } = setup();
  await applying();
  const unknown = h.result(2, "workerFailure");
  const known = parseRecordingOperationResult({
    ...h.result(2),
    recoveryRequired: true,
  });
  const merged = mergeResult(known, unknown);
  expect(merged.outcome.kind).toBe("applied");
  expect(merged.quiescence).toBe("confirmed");
  expect(merged.recoveryRequired).toBe(true);
});
it("owner validation rejects non-Promise handles and extra fields", () => {
  const { h, start } = setup();
  start();
  expect(() =>
    ownerView(
      { ...h.view, active: { ...h.view.active, completion: { then() {} } } },
      h.context,
    ),
  ).toThrow();
  expect(() => ownerView({ ...h.view, extra: true }, h.context)).toThrow();
});
it.each(["candidate", "paused"])(
  "old %s can be explicitly discarded without stopping or resuming",
  async (phase) => {
    const { h, m, start, paused, bind } = setup();
    if (phase === "paused") await paused();
    else {
      start();
      h.finish(0);
      await flush();
    }
    const before = h.stops;
    bind(h.service, structuredClone(operationsProject), 2);
    expect(m.state.canDiscard).toBe(false);
    expect(m.state.canDiscardOriginal).toBe(true);
    expect(m.discardOriginal()).toBe(true);
    expect(h.stops).toBe(before);
    expect(h.writes).toBe(0);
    expect(m.state.canSwitch).toBe(true);
    m.switchToSelected();
    expect(m.state.canPreflight).toBe(true);
  },
);
it("old completion stays labeled until a new workflow is accepted", async () => {
  const { h, m, start, bind } = setup();
  start();
  h.finish(0, "conflict");
  await flush();
  bind(createOperationsHarness().service);
  m.switchToSelected();
  expect(m.state.previous?.latest?.outcome.kind).toBe("failed");
  expect(m.state.previous?.latest?.request.change.context).toEqual(h.context);
});
it("disabled desired sends null mapping and retention bindings and still requires pauseJoin", async () => {
  const project = {
    ...operationsProject,
    recordingPlan: { ...operationsProject.recordingPlan!, enabled: false },
  };
  const h = createOperationsHarness(project),
    m = createRecordingOperationsMonitor();
  cleanups.push(() => m.dispose());
  const selection = recordingOperationsSelection(h.service, project, 1, {});
  if (selection.phase !== "ready") throw Error();
  m.select(selection);
  const b = selection.binding;
  const request = parseRecordingChangeRequest({
    version: 1,
    kind: "recordingChangeRequest",
    changeId: "disabled",
    context: b.context,
    apply: {
      requestId: "disabled:apply",
      desired: b.desired,
      expectedAppliedRevision: null,
      expectedMappingRevision: null,
      expectedRetentionAppliedRevision: null,
    },
  });
  m.preflight(b, request, 1000);
  h.finish(0);
  await flush();
  expect(m.state.canApply).toBe(false);
  m.pauseJoin(b, 1000);
  h.finish(1);
  await flush();
  m.apply(b, 1000);
  h.finish(2);
  await flush();
  expect(m.state.latest?.outcome.kind).toBe("applied");
  expect(m.state.lastApplied?.receipt.enabled).toBe(false);
  expect(m.state.lastApplied?.receipt.mappingRevision).toBeNull();
  expect(h.stops).toBe(1);
});
it("an exception after acceptance retains uncertainty and blocks a different owner", () => {
  const h = createOperationsHarness();
  const service = {
    ...h.service,
    preflight(...args: Parameters<typeof h.service.preflight>) {
      h.service.preflight(...args);
      throw Error("lost response");
    },
  };
  const { m, start, bind } = setup(service);
  start();
  expect(h.calls).toHaveLength(1);
  expect(m.state.invalid).toBe(true);
  bind(createOperationsHarness().service);
  expect(m.state.canSwitch).toBe(false);
  expect(m.state.canPreflight).toBe(false);
});

it("reentrant notification cannot dispatch after the absolute deadline", () => {
  let now = 0;
  const { h, m, start } = setup(undefined, () => now);
  m.subscribe((s) => {
    if (s.issuing) now = 1001;
  });
  expect(start()).toBe(false);
  expect(h.calls).toHaveLength(0);
  expect(m.state.refusal).toBe("deadlineExceeded");
  expect(m.state.invalid).toBe(false);
});

it("malformed read completion retains its slot and cannot start a second read", async () => {
  const { h, m, applying } = setup();
  await applying();
  h.finish(2, "workerFailure");
  await flush();
  m.reconcile(1000);
  h.reads[0].reject(Error("unknown read cleanup"));
  await flush();
  expect(m.state.invalid).toBe(true);
  expect(m.state.canReconcile).toBe(false);
  expect(m.reconcile(1000)).toBe(false);
  expect(h.reads).toHaveLength(1);
});

it.each(["reject", "malformed"])(
  "subscribe-first valid read does not release its slot after Promise %s",
  async (mode) => {
    const { h, m, applying } = setup();
    await applying();
    h.finish(2, "workerFailure");
    await flush();
    m.reconcile(1000);
    h.set({ lastReconciliation: h.readResult(0) });
    if (mode === "reject") h.reads[0].reject(Error("cleanup unconfirmed"));
    else h.reads[0].resolve({} as never);
    await flush();
    expect(m.state.invalid).toBe(true);
    expect(m.state.canReconcile).toBe(false);
    expect(m.reconcile(1000)).toBe(false);
    expect(h.reads).toHaveLength(1);
  },
);
