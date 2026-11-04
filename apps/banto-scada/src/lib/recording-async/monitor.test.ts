import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAsyncOperationsMonitor } from "./monitor";
import { createAsyncRecordingOperationsCoordinator } from "./coordinator";
import { createAsyncPortHarness } from "../__fixtures__/recording-async-port";
import { operationsProject } from "../__fixtures__/recording-operations-service";
import { parseRecordingChangeRequest } from "../recording-operations-contract";
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const ctl = () => ({
  intentDeadlineMonotonicMs: 1000,
  requestedNativeBudgetMs: 500,
});
function setup() {
  const h = createAsyncPortHarness(),
    root = createAsyncRecordingOperationsCoordinator(h.port, () => 100),
    m = createAsyncOperationsMonitor();
  const selected = {
    client: root.client,
    project: operationsProject,
    generation: 1,
    openOwner: {},
    blocked: false,
  };
  m.select(selected);
  return { h, root, m, selected };
}
function change(s: ReturnType<typeof setup>) {
  return parseRecordingChangeRequest({
    version: 1,
    kind: "recordingChangeRequest",
    changeId: "change:monitor",
    context: s.h.context,
    apply: {
      requestId: "apply:monitor",
      desired: operationsProject.recordingPlan,
      expectedAppliedRevision: null,
      expectedMappingRevision: 1,
      expectedRetentionAppliedRevision: 1,
    },
  });
}
async function candidate(s: ReturnType<typeof setup>) {
  expect(s.m.preflight(change(s), ctl())).toBe(true);
  await flush();
  s.h.finish(0);
  await flush();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("starts offline and rejects foreign clients without invoking their getters", () => {
  const m = createAsyncOperationsMonitor();
  expect(m.current().connection).toBe("offline");
  let read = false;
  const client = {
    get context() {
      read = true;
      throw Error("private");
    },
  } as any;
  m.select({
    client,
    project: operationsProject,
    generation: 1,
    openOwner: {},
    blocked: false,
  });
  expect(m.current().connection).toBe("invalidContext");
  expect(read).toBe(false);
  m.dispose();
});
it("same-target close/reopen retires old callbacks and preserves root candidate", async () => {
  const s = setup();
  s.m.preflight(change(s), ctl());
  await flush();
  s.m.select({ ...s.selected, openOwner: null });
  s.h.finish(0);
  await flush();
  expect(s.m.current().canPause).toBe(false);
  s.m.select({ ...s.selected, openOwner: {} });
  expect(s.m.current().canPause).toBe(true);
  expect(s.m.pause(ctl())).toBe(true);
  await flush();
  expect(s.h.stops).toBe(1);
});
it.each(["object", "generation"])(
  "same-ID reload with new %s cannot send an old candidate",
  async (key) => {
    const s = setup();
    await candidate(s);
    s.m.select({
      ...s.selected,
      project:
        key === "object"
          ? structuredClone(operationsProject)
          : operationsProject,
      generation: key === "generation" ? 2 : 1,
    });
    expect(s.m.current().oldOwner).toBe(true);
    expect(s.m.pause(ctl())).toBe(false);
    expect(s.m.current().canDiscardOriginal).toBe(true);
    expect(s.m.discard(ctl(), true)).toBe(true);
    await flush();
    expect(s.m.current().canPreflight).toBe(true);
  },
);
it("lease waiting during Project replacement never reaches admit", async () => {
  const s = setup();
  s.h.configure({ autoLease: false });
  s.m.preflight(change(s), ctl());
  s.m.select({ ...s.selected, project: structuredClone(operationsProject) });
  s.h.issueLease(0);
  await flush();
  expect(s.h.admissions).toHaveLength(0);
});
it("dispose/remount uses retained external root and treats old identity as old workflow", async () => {
  const s = setup();
  s.m.preflight(change(s), ctl());
  await flush();
  s.m.dispose();
  s.h.finish(0);
  await flush();
  const next = createAsyncOperationsMonitor();
  next.select(s.selected);
  expect(next.current().state?.latest?.outcome.kind).toBe("candidate");
  expect(next.current().canPause).toBe(false);
  expect(next.current().canDiscardOriginal).toBe(true);
  expect(s.root.client.current().closed).toBe(false);
  next.dispose();
});
it("service replacement keeps the old owner until safe terminal and explicit switching", async () => {
  const s = setup(),
    h2 = createAsyncPortHarness(),
    r2 = createAsyncRecordingOperationsCoordinator(h2.port, () => 100);
  await candidate(s);
  s.m.select({ ...s.selected, client: r2.client });
  expect(s.m.current().canPreflight).toBe(false);
  expect(s.m.current().canSwitch).toBe(false);
  expect(s.m.current().canDiscardOriginal).toBe(true);
  s.m.discard(ctl(), true);
  await flush();
  expect(s.m.current().canSwitch).toBe(true);
  expect(h2.leases).toHaveLength(0);
  expect(s.m.switchToSelected()).toBe(true);
  expect(s.m.current().canPreflight).toBe(true);
});
it("unknown owner cannot be replaced even after several selected services", async () => {
  const s = setup();
  s.h.configure({ autoAck: false });
  s.m.preflight(change(s), ctl());
  await flush();
  s.h.ack(0, "unknown");
  await flush();
  for (let n = 0; n < 3; n++) {
    const h = createAsyncPortHarness(),
      root = createAsyncRecordingOperationsCoordinator(h.port, () => 100);
    s.m.select({ ...s.selected, client: root.client });
    expect(s.m.current().canSwitch).toBe(false);
    expect(s.m.current().state).toBe(s.root.client.current());
    expect(h.admissions).toHaveLength(0);
  }
});
it("blocked configuration preserves monitoring but refuses every action", async () => {
  const s = setup();
  s.m.preflight(change(s), ctl());
  await flush();
  s.m.select({ ...s.selected, blocked: true });
  s.h.finish(0);
  await flush();
  expect(s.m.current().state?.latest?.outcome.kind).toBe("candidate");
  expect(s.m.pause(ctl())).toBe(false);
  expect(s.m.discard(ctl(), true)).toBe(false);
  expect(s.m.current().canPreflight).toBe(false);
});
it("context mismatch cannot dispatch, but old diagnostics remain visible", async () => {
  const s = setup();
  await candidate(s);
  const project = structuredClone(operationsProject);
  (project.manifest as any).projectId = "different-project";
  s.m.select({ ...s.selected, project });
  expect(s.m.current().connection).toBe("contextMismatch");
  expect(s.m.current().canPause).toBe(false);
  expect(s.m.current().state?.latest).toBeDefined();
});
it("submitted desired must equal the current Project, including member array order", () => {
  const s = setup(),
    c = structuredClone(change(s));
  (c.apply.desired as any).revision++;
  expect(s.m.preflight(c, ctl())).toBe(false);
  expect(s.h.leases).toHaveLength(0);
});
it("does not submit a reordered desired array in place of the current Project body", () => {
  const s = setup(),
    c = structuredClone(change(s));
  const reordered = {
    ...c,
    apply: {
      ...c.apply,
      desired: {
        ...c.apply.desired,
        group: {
          ...c.apply.desired.group,
          members: [...c.apply.desired.group.members].reverse(),
        },
      },
    },
  };
  expect(s.m.preflight(reordered, ctl())).toBe(false);
  expect(s.h.leases).toHaveLength(0);
});
it.each(["preflight", "pause", "apply"])(
  "client replacement retires a %s waiting issuance while retaining old observation",
  async (stage) => {
    const s = setup(),
      next = createAsyncPortHarness(),
      nextRoot = createAsyncRecordingOperationsCoordinator(
        next.port,
        () => 100,
      );
    if (stage !== "preflight") await candidate(s);
    if (stage === "apply") {
      expect(s.m.pause(ctl())).toBe(true);
      await flush();
      s.h.finish(1);
      await flush();
    }
    s.h.configure({ autoLease: false });
    const before = s.h.admissions.length;
    expect(
      stage === "preflight"
        ? s.m.preflight(change(s), ctl())
        : stage === "pause"
          ? s.m.pause(ctl())
          : s.m.apply(ctl()),
    ).toBe(true);
    s.m.select({ ...s.selected, client: nextRoot.client });
    expect(s.m.current().oldOwner).toBe(true);
    expect(s.m.current().canSwitch).toBe(false);
    s.h.issueLease(s.h.leases.length - 1);
    await flush();
    expect(s.h.admissions).toHaveLength(before);
    expect(next.leases).toHaveLength(0);
    expect(s.root.client.current().call).toBe("idle");
    if (stage !== "preflight") {
      expect(s.m.current().state?.latest).toBeDefined();
      expect(s.m.current().canDiscardOriginal).toBe(true);
    }
  },
);
it.each(["removed", "invalid", "return"])(
  "raw selected client %s permanently retires the old pending view",
  async (kind) => {
    const s = setup();
    s.h.configure({ autoLease: false });
    s.m.preflight(change(s), ctl());
    if (kind === "removed") s.m.select({ ...s.selected, client: undefined });
    else if (kind === "invalid")
      s.m.select({ ...s.selected, client: {} as any });
    else {
      const next = createAsyncPortHarness(),
        r = createAsyncRecordingOperationsCoordinator(next.port, () => 100);
      s.m.select({ ...s.selected, client: r.client });
      s.m.select(s.selected);
    }
    s.h.issueLease(0);
    await flush();
    expect(s.h.admissions).toHaveLength(0);
    expect(s.root.client.current().invalid).toBe(false);
  },
);
