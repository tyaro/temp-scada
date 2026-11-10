import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAsyncRecordingOperationsCoordinator } from "./coordinator";
import { createAsyncOperationsMonitor } from "./monitor";
import { defineAsyncRecordingPortV2 } from "./port";
import type { AsyncRecordingPortV2Impl, PortStateV2 } from "./port";
import {
  parseRecordingWorkflowResumption,
  type RecordingWorkflowResumption,
} from "./resumption";
import { createAsyncPortHarness } from "../__fixtures__/recording-async-port";
import { operationsProject } from "../__fixtures__/recording-operations-service";
import { parseRecordingChangeRequest } from "../recording-operations-contract";

type Harness = ReturnType<typeof createAsyncPortHarness>;
const now = 100;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const control = () => ({
  intentDeadlineMonotonicMs: now + 1000,
  requestedNativeBudgetMs: 500,
});
function change(h: Harness) {
  return parseRecordingChangeRequest({
    version: 1,
    kind: "recordingChangeRequest",
    changeId: "change:resume",
    context: h.context,
    apply: {
      requestId: "apply:resume",
      desired: operationsProject.recordingPlan,
      expectedAppliedRevision: null,
      expectedMappingRevision: 1,
      expectedRetentionAppliedRevision: 1,
    },
  });
}
/** The first page: runs the workflow against the host (the harness). */
function firstPage() {
  const h = createAsyncPortHarness(),
    root = createAsyncRecordingOperationsCoordinator(h.port, () => now);
  return { h, root, view: root.client.bindView({}) };
}
/** What the gate holds for the harness's admissions so far. */
function held(h: Harness, last?: (reply: any) => any) {
  const admissions = h.admissions.map((a, i) => ({
    request: a.request,
    reply:
      last && i === h.admissions.length - 1 ? last(a.accepted) : a.accepted,
  }));
  const parsed = parseRecordingWorkflowResumption(
    { state: "held", change: change(h), admissions },
    h.scope,
  );
  expect(parsed).not.toBeNull();
  return parsed!;
}
/** A new page: another port over the same host. */
function nextPage(h: Harness, seed?: RecordingWorkflowResumption) {
  const port = defineAsyncRecordingPortV2({
    scope: h.scope,
    access: "mutation",
    prepareLease: (r) => h.impl.prepareLease(r),
    admit: (r) => h.impl.admit(r),
    inspectAdmission: (r) => h.impl.inspectAdmission(r),
    inspectCall: (r) => h.impl.inspectCall(r) as never,
    requestCancel: (r) => h.impl.requestCancel(r) as never,
    observe: (t) => h.impl.observe(t) as never,
    current: () => h.impl.current() as PortStateV2,
    subscribe: (l) => h.impl.subscribe(l as (v: unknown) => void),
  } as AsyncRecordingPortV2Impl);
  return createAsyncRecordingOperationsCoordinator(port, () => now, seed);
}
async function candidate(p: ReturnType<typeof firstPage>) {
  expect(p.view.preflight(change(p.h), control())).toBe(true);
  await flush();
  p.h.finish(0);
  await flush();
}
async function paused(p: ReturnType<typeof firstPage>) {
  await candidate(p);
  expect(p.view.pause(control())).toBe(true);
  await flush();
  p.h.finish(1);
  await flush();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("accepts only the caller's own consistent workflow", async () => {
  const p = firstPage();
  await candidate(p);
  const good = held(p.h);
  const raw = {
    state: "held",
    change: good.change,
    admissions: good.admissions,
  };
  const parse = (v: unknown) => parseRecordingWorkflowResumption(v, p.h.scope);
  expect(parse({ state: "none" })).toBeNull();
  expect(parse(null)).toBeNull();
  expect(parse(raw)).not.toBeNull();
  expect(
    parse({ ...raw, admissions: [good.admissions[0], good.admissions[0]] }),
  ).toBeNull();
  expect(
    parse({
      ...raw,
      change: { ...raw.change, changeId: "change:other" },
    }),
  ).toBeNull();
  expect(
    parse({
      ...raw,
      admissions: [
        {
          request: good.admissions[0].request,
          reply: {
            ...good.admissions[0].reply,
            outcome: { kind: "completedDiscard" },
          },
        },
      ],
    }),
  ).toBeNull();
  expect(
    parseRecordingWorkflowResumption(raw, {
      ...p.h.scope,
      ownerRef: "owner:other",
    }),
  ).toBeNull();
});

it("continues a Candidate from the stored reply without sending it again", async () => {
  const p = firstPage();
  await candidate(p);
  const admitted = p.h.admissions.length;
  const next = nextPage(p.h, held(p.h));
  const view = next.client.bindView({});
  await flush();
  const s = next.client.current();
  expect(s.resumed).toBe(true);
  expect(s.earlierWork).toBe(false);
  expect(s.admission).toBe("accepted");
  expect(s.latest?.outcome.kind).toBe("candidate");
  expect(s.canPause).toBe(true);
  expect(s.canDiscard).toBe(true);
  expect(p.h.admissions).toHaveLength(admitted);

  expect(view.pause(control())).toBe(true);
  await flush();
  const sent = p.h.admissions.at(-1)!.request;
  expect(sent.action.kind).toBe("pauseJoin");
  const first = p.h.admissions[0].accepted!.outcome as any;
  expect((sent.action as any).changeRef).toBe(first.handle.changeRef);
  expect(sent.admissionId).not.toBe(p.h.admissions[0].request.admissionId);
});

it("keeps watching an operation still running when the page changed", async () => {
  const p = firstPage();
  expect(p.view.preflight(change(p.h), control())).toBe(true);
  await flush();
  const next = nextPage(p.h, held(p.h));
  next.client.bindView({});
  await flush();
  expect(next.client.current().canPause).toBe(false);
  p.h.finish(0);
  await flush();
  expect(next.client.current().canPause).toBe(true);
});

it("observes only the last accepted operation", async () => {
  const p = firstPage();
  await paused(p);
  const before = p.h.operations[0].observed;
  const next = nextPage(p.h, held(p.h));
  next.client.bindView({});
  await flush();
  expect(p.h.operations[0].observed).toBe(before);
  const s = next.client.current();
  expect(s.latest?.outcome.kind).toBe("paused");
  expect(s.canApply).toBe(true);
  expect(s.canPause).toBe(false);
});

it("gives the workflow to the first view bound", async () => {
  const p = firstPage();
  await candidate(p);
  const next = nextPage(p.h, held(p.h));
  await flush();
  const first = {},
    second = {};
  expect(next.client.current().identity).not.toBe(first);
  next.client.bindView(first);
  expect(next.client.current().identity).toBe(first);
  const other = next.client.bindView(second);
  expect(next.client.current().identity).toBe(first);
  await flush();
  // Another view cannot run the later stages of the claimed workflow.
  expect(other.pause(control())).toBe(false);
});

it("restores an unknown admission so that it is inspected, not sent again", async () => {
  const p = firstPage();
  await candidate(p);
  // The owner's frames know no answer either: it stays unknown.
  p.h.emit({ admission: null });
  const next = nextPage(
    p.h,
    held(p.h, (r) => ({
      ...r,
      outcome: { kind: "unknown", error: "workerFailure" },
    })),
  );
  next.client.bindView({});
  await flush();
  const s = next.client.current();
  expect(s.admission).toBe("unknown");
  expect(s.canInspect).toBe(true);
  expect(s.canPause).toBe(false);
});

it("offers a reservation with no admission as the change to continue", async () => {
  const h = createAsyncPortHarness();
  const seed = parseRecordingWorkflowResumption(
    { state: "held", change: change(h), admissions: [] },
    h.scope,
  )!;
  const next = nextPage(h, seed);
  const view = next.client.bindView({});
  await flush();
  expect(next.client.current().reservedChange).toEqual(seed.change);
  expect(next.client.current().canPreflight).toBe(true);
  expect(view.preflight(seed.change, control())).toBe(true);
  await flush();
  expect(h.admissions).toHaveLength(1);
  expect(next.client.current().reservedChange).toBeUndefined();
  expect(next.client.current().admission).toBe("accepted");
});

it("still reports another client's work when nothing was taken over", async () => {
  const p = firstPage();
  await candidate(p);
  const next = nextPage(p.h);
  await flush();
  expect(next.client.current().resumed).toBe(false);
  expect(next.client.current().earlierWork).toBe(true);
  expect(next.client.current().canPause).toBe(false);
});

it("follows a reconcile only after its operation's terminal", async () => {
  const p = firstPage();
  await paused(p);
  expect(p.view.apply(control())).toBe(true);
  await flush();
  p.h.finish(2, "workerFailure");
  await flush();
  expect(p.view.reconcile(control())).toBe(true);
  await flush();
  const seed = held(p.h);
  expect(seed.admissions.map((a) => a.request.action.kind)).toEqual([
    "preflight",
    "pauseJoin",
    "apply",
    "reconcile",
  ]);
  const next = nextPage(p.h, seed);
  next.client.bindView({});
  await flush();
  expect(next.client.current().read).toBe("accepted");
  expect(p.h.reads[0].observed).toBe(2);
  p.h.finishRead(0);
  await flush();
  expect(next.client.current().read).toBe("completed");
});

it("moves a monitor from the closed client to the one that took its Candidate over", async () => {
  const p = firstPage();
  const m = createAsyncOperationsMonitor();
  const selected = {
    client: p.root.client,
    project: operationsProject,
    generation: 1,
    openOwner: {},
    blocked: false,
  };
  m.select(selected);
  expect(m.preflight(change(p.h), control())).toBe(true);
  await flush();
  p.h.finish(0);
  await flush();
  expect(m.current().canPause).toBe(true);

  // A login again: the slot is read and a new client published.
  p.root.close();
  m.select({ ...selected, client: undefined });
  expect(m.current().state?.closed).toBe(true);
  const next = nextPage(p.h, held(p.h));
  await flush();
  m.select({ ...selected, client: next.client });
  await flush();
  expect(m.current().state?.resumed).toBe(true);
  expect(m.current().canPause).toBe(true);
  expect(m.pause(control())).toBe(true);
  m.dispose();
});

it("leaves a monitor on the closed client when another change was taken over", async () => {
  const p = firstPage();
  const m = createAsyncOperationsMonitor();
  const selected = {
    client: p.root.client,
    project: operationsProject,
    generation: 1,
    openOwner: {},
    blocked: false,
  };
  m.select(selected);
  expect(m.preflight(change(p.h), control())).toBe(true);
  await flush();
  p.h.finish(0);
  await flush();
  p.root.close();
  const other = parseRecordingWorkflowResumption(
    {
      state: "held",
      change: { ...change(p.h), changeId: "change:other" },
      admissions: [],
    },
    p.h.scope,
  )!;
  m.select({ ...selected, client: nextPage(p.h, other).client });
  await flush();
  expect(m.current().state?.resumed).toBe(false);
  m.dispose();
});
