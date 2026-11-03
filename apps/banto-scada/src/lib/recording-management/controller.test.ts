import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../../../../../examples/minimal.project.json";
import fixtures from "../../../../../examples/recording-management-cases.json";
import { parseProject } from "../project";
import { createRecordingManagementController } from "./controller";
import {
  recordingManagementSelection,
  type RecordingManagementService,
} from "./service";
import type {
  RecordingInspectionRequest,
  RecordingInspectionResponse,
} from "../recording-management-contract";
const project = () => parseProject(JSON.stringify(sample));
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function harness() {
  let time = 0,
    active = 0,
    maxActive = 0;
  const calls: {
    request: RecordingInspectionRequest;
    signal: AbortSignal;
    deadline: number;
    resolve: (v?: unknown) => void;
    reject: () => void;
  }[] = [];
  const source: RecordingManagementService = {
    context: {
      ...fixtures.bases.context,
      projectId: sample.manifest.projectId,
      projectRevision: sample.manifest.projectRevision,
    },
    inspect(request, control) {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve, reject) =>
        calls.push({
          request,
          signal: control.signal,
          deadline: control.deadlineMonotonicMs,
          resolve(value = reply(request)) {
            active--;
            resolve(value);
          },
          reject() {
            active--;
            reject(Error("PRIVATE STACK"));
          },
        }),
      );
    },
  };
  const p = project(),
    selection = recordingManagementSelection(source, p, 1, {});
  const controller = createRecordingManagementController(() => time);
  controller.setOwner(selection);
  return {
    controller,
    calls,
    source,
    p,
    selection,
    setTime: (n: number) => (time = n),
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    rebind(service = source, p2 = p, generation = 1) {
      controller.setOwner(
        recordingManagementSelection(service, p2, generation, {}),
      );
    },
  };
}
function reply(
  request: RecordingInspectionRequest,
): RecordingInspectionResponse {
  return {
    ...structuredClone(fixtures.bases.response),
    request,
  } as RecordingInspectionResponse;
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());
it("opens idle, explicitly loads an owned frozen request, and owns the response", async () => {
  const h = harness();
  expect(h.calls).toHaveLength(0);
  expect(h.controller.state.phase).toBe("idle");
  const token = h.controller.load(10000);
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].deadline).toBe(10000);
  expect(Object.isFrozen(h.calls[0].request.context)).toBe(true);
  expect(h.calls[0].request.requestId).toMatch(/^inspection:/);
  const input = reply(h.calls[0].request);
  h.calls[0].resolve(input);
  await flush();
  expect(h.controller.state).toMatchObject({
    phase: "ready",
    token,
    comparison: { kind: "absent" },
  });
  expect(h.controller.state.response).not.toBe(input);
  expect(Object.isFrozen(h.controller.state.response?.database)).toBe(true);
  expect(h.controller.cancel(token)).toBe(false);
  expect(h.controller.state.phase).toBe("ready");
  h.controller.dispose();
});
it("active1 and latest pending1 survive abort-ignoring source, and pending is replaced", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  const first = h.calls[0];
  h.controller.load(10000);
  const latest = h.controller.load(10000);
  expect(first.signal.aborted).toBe(true);
  expect(h.controller.state.waiting).toBe(true);
  await flush();
  expect(h.calls).toHaveLength(1);
  first.resolve();
  await flush();
  expect(h.calls).toHaveLength(2);
  expect(h.maxActive).toBe(1);
  expect(h.controller.state.token).toBe(latest);
  h.calls[1].resolve();
  await flush();
  expect(h.controller.state.phase).toBe("ready");
  h.controller.dispose();
});
it("pending uses its original absolute deadline and times out without dispatch", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.setTime(20);
  h.controller.load(50);
  h.setTime(70);
  await vi.advanceTimersByTimeAsync(50);
  expect(h.controller.state.phase).toBe("timeout");
  expect(h.calls).toHaveLength(1);
  expect(h.active).toBe(1);
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.controller.state.phase).toBe("timeout");
  h.controller.dispose();
});
it("dispatch gives pending its unchanged load deadline", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.setTime(40);
  h.controller.load(100);
  h.setTime(90);
  h.calls[0].resolve();
  await flush();
  expect(h.calls[1].deadline).toBe(140);
  h.calls[1].resolve();
  await flush();
  h.controller.dispose();
});
it("active timeout aborts logically but holds the slot through cleanup", async () => {
  const h = harness();
  h.controller.load(50);
  await flush();
  h.setTime(50);
  await vi.advanceTimersByTimeAsync(50);
  expect(h.controller.state.phase).toBe("timeout");
  expect(h.calls[0].signal.aborted).toBe(true);
  expect(h.active).toBe(1);
  h.controller.load(100);
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.controller.state.waiting).toBe(true);
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(2);
  expect(h.maxActive).toBe(1);
  h.calls[1].resolve();
  await flush();
  h.controller.dispose();
});
it("late success cannot revive even when the timeout callback was delayed", async () => {
  const h = harness();
  h.controller.load(30);
  await flush();
  h.setTime(31);
  h.calls[0].resolve();
  await flush();
  expect(h.controller.state.phase).toBe("timeout");
  expect(h.controller.state.response).toBeUndefined();
  h.controller.dispose();
});
it("checks deadline after full response validation", async () => {
  const h = harness();
  h.controller.load(30);
  await flush();
  const response = reply(h.calls[0].request);
  const proxy = new Proxy(response, {
    ownKeys(target) {
      h.setTime(30);
      return Reflect.ownKeys(target);
    },
  });
  h.calls[0].resolve(proxy);
  await flush();
  expect(h.controller.state.phase).toBe("timeout");
  h.controller.dispose();
});
it("expired pending is checked before dispatch even without timers firing", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.controller.load(10);
  h.setTime(11);
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.controller.state.phase).toBe("timeout");
  h.controller.dispose();
});
for (const kind of [
  "service",
  "project",
  "generation",
  "open",
  "closed",
] as const)
  it(`retains old physical slot across ${kind} owner change`, async () => {
    const h = harness();
    h.controller.load(10000);
    await flush();
    if (kind === "closed") h.controller.setOwner({ phase: "offline" });
    else
      h.rebind(
        kind === "service" ? { ...h.source } : h.source,
        kind === "project" ? project() : h.p,
        kind === "generation" ? 2 : 1,
      );
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.controller.state.response).toBeUndefined();
    if (kind === "closed") h.rebind();
    h.controller.load(10000);
    await flush();
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].request.requestId).not.toBe(h.calls[0].request.requestId);
    expect(h.maxActive).toBe(1);
    h.calls[1].resolve();
    await flush();
    expect(h.controller.state.phase).toBe("ready");
    h.controller.dispose();
  });
it("cancel retires pending, rejects stale tokens and never cancels ready", async () => {
  const h = harness();
  const old = h.controller.load(10000);
  await flush();
  const token = h.controller.load(10000);
  expect(h.controller.cancel(old)).toBe(false);
  expect(h.controller.cancel(token)).toBe(true);
  expect(h.controller.state.phase).toBe("cancelled");
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.controller.state.phase).toBe("cancelled");
  h.controller.dispose();
});
it("dispose aborts active and drops pending while source still cleans up", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.controller.load(10000);
  const listener = vi.fn();
  h.controller.subscribe(listener);
  listener.mockClear();
  h.controller.dispose();
  expect(h.calls[0].signal.aborted).toBe(true);
  expect(h.active).toBe(1);
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(listener).not.toHaveBeenCalled();
  expect(h.controller.load(10000)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it("sync throw and non-Promise replies become finite serviceFailure", async () => {
  for (const inspect of [
    () => {
      throw Error("PRIVATE");
    },
    () => fixtures.bases.response,
    () => ({
      get then() {
        throw Error("SECRET");
      },
    }),
  ]) {
    const h = harness();
    h.rebind({ ...h.source, inspect: inspect as any });
    h.controller.load(10000);
    await flush();
    expect(h.controller.state.phase).toBe("serviceFailure");
    expect(JSON.stringify(h.controller.state)).not.toContain("PRIVATE");
    expect(h.controller.state.response).toBeUndefined();
    h.controller.dispose();
  }
});
it("rejection is classified without raw errors and releases only on settlement", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.calls[0].reject();
  await flush();
  expect(h.controller.state.phase).toBe("serviceFailure");
  expect(JSON.stringify(h.controller.state)).not.toContain("PRIVATE STACK");
  h.controller.load(10000);
  await flush();
  expect(h.calls).toHaveLength(2);
  h.calls[1].resolve();
  await flush();
  h.controller.dispose();
});
for (const path of [
  "requestId",
  "contextId",
  "projectId",
  "projectRevision",
  "deploymentId",
  "storeId",
  "historianNamespace",
])
  it(`rejects echoed ${path} mismatch`, async () => {
    const h = harness();
    h.controller.load(10000);
    await flush();
    const value = { ...structuredClone(reply(h.calls[0].request)) };
    if (path === "requestId")
      value.request = { ...value.request, requestId: "other" };
    else
      value.request = {
        ...value.request,
        context: {
          ...value.request.context,
          [path]:
            path === "projectRevision"
              ? value.request.context.projectRevision + 1
              : "other",
        },
      };
    h.calls[0].resolve(value);
    await flush();
    expect(h.controller.state.phase).toBe("invalidResponse");
    expect(h.controller.state.comparison).toBeUndefined();
    h.controller.dispose();
  });
it("schema and DB semantic errors are invalidResponse, never absent", async () => {
  for (const invalid of [
    {},
    { ...fixtures.bases.active.database, activeRetentionJobId: "job:1" },
  ]) {
    const h = harness();
    h.controller.load(10000);
    await flush();
    const value =
      "state" in invalid
        ? { ...reply(h.calls[0].request), database: invalid }
        : invalid;
    h.calls[0].resolve(value);
    await flush();
    expect(h.controller.state.phase).toBe("invalidResponse");
    h.controller.dispose();
  }
});
it("DB unavailable with observed Host stays ready with unavailable comparison", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  h.calls[0].resolve({
    ...structuredClone(fixtures.bases.unavailable),
    request: h.calls[0].request,
  });
  await flush();
  expect(h.controller.state).toMatchObject({
    phase: "ready",
    comparison: { kind: "unavailable" },
    response: { host: { state: "observed", planRecoveryRequired: null } },
  });
  h.controller.dispose();
});
it("captured inspect/context and desired are unaffected by in-place source mutation", async () => {
  const h = harness();
  (h.source.context as any).storeId = "mutated";
  (h.source as any).inspect = () => {
    throw Error("changed");
  };
  h.controller.load(10000);
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].request.context.storeId).toBe("store:1");
  h.calls[0].resolve();
  await flush();
  h.controller.dispose();
});
it("rejects invalid timeouts before retiring valid pending work", async () => {
  const h = harness();
  const token = h.controller.load(10000);
  for (const value of [0, -1, 10001, NaN, Infinity, 1.5])
    expect(() => h.controller.load(value)).toThrow(
      "Recording inspection timeout: invalid",
    );
  expect(h.controller.state.token).toBe(token);
  await flush();
  h.calls[0].resolve();
  await flush();
  h.controller.dispose();
});
it("subscriber load reentry replaces pending and never dispatches two reads", async () => {
  const h = harness();
  let reentered = false;
  h.controller.subscribe((state) => {
    if (state.phase === "loading" && !reentered) {
      reentered = true;
      h.controller.load(10000);
    }
  });
  const outer = h.controller.load(10000);
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.controller.state.token).not.toBe(outer);
  h.calls[0].resolve();
  await flush();
  expect(h.maxActive).toBe(1);
  h.controller.dispose();
});
it("subscriber reentry at physical dispatch retires before inspect", async () => {
  const h = harness();
  let loads = 0;
  const off = h.controller.subscribe((state) => {
    if (state.phase === "loading" && ++loads === 2) h.controller.load(10000);
  });
  h.controller.load(10000);
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.maxActive).toBe(1);
  off();
  h.calls[0].resolve();
  await flush();
  h.controller.dispose();
});
it("abort listener reentry wins over the outer load", async () => {
  const h = harness();
  h.controller.load(10000);
  await flush();
  let inner: object | undefined;
  h.calls[0].signal.addEventListener(
    "abort",
    () => {
      inner = h.controller.load(10000);
    },
    { once: true },
  );
  const outer = h.controller.load(10000);
  expect(h.controller.state.token).toBe(inner);
  expect(h.controller.state.token).not.toBe(outer);
  h.calls[0].resolve();
  await flush();
  expect(h.calls).toHaveLength(2);
  h.calls[1].resolve();
  await flush();
  expect(h.maxActive).toBe(1);
  h.controller.dispose();
});
it("unsubscribe during notification and throwing consumers do not receive stale states", async () => {
  const h = harness();
  let off = () => {},
    remove = false;
  h.controller.subscribe(() => {
    if (remove) off();
  });
  const listener = vi.fn();
  off = h.controller.subscribe(listener);
  listener.mockClear();
  remove = true;
  h.controller.subscribe(() => {
    throw Error("consumer");
  });
  h.controller.load(10000);
  await flush();
  expect(listener).not.toHaveBeenCalled();
  h.calls[0].resolve();
  await flush();
  expect(h.controller.state.phase).toBe("ready");
  h.controller.dispose();
});
it("subscriber disposal and owner replacement do not revive older loads", async () => {
  for (const dispose of [true, false]) {
    const h = harness();
    let once = false;
    h.controller.subscribe((s) => {
      if (s.phase === "loading" && !once) {
        once = true;
        if (dispose) h.controller.dispose();
        else h.controller.setOwner({ phase: "offline" });
      }
    });
    h.controller.load(10000);
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.controller.state.phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  }
});
describe("selection boundary", () => {
  it("distinguishes offline, invalid and Project mismatch without calling service", () => {
    const h = harness();
    expect(recordingManagementSelection(undefined, h.p, 1, {}).phase).toBe(
      "offline",
    );
    expect(
      recordingManagementSelection({ ...h.source, context: {} }, h.p, 1, {})
        .phase,
    ).toBe("invalidContext");
    expect(
      recordingManagementSelection(
        {
          ...h.source,
          context: { ...(h.source.context as any), projectRevision: 99 },
        },
        h.p,
        1,
        {},
      ).phase,
    ).toBe("contextMismatch");
    expect(
      recordingManagementSelection(
        { ...h.source, inspect: undefined } as any,
        h.p,
        1,
        {},
      ).phase,
    ).toBe("invalidContext");
    for (const phase of [
      "offline",
      "invalidContext",
      "contextMismatch",
    ] as const) {
      h.controller.setOwner({ phase });
      h.controller.load(10000);
      expect(h.controller.state.phase).toBe(phase);
    }
    expect(h.calls).toHaveLength(0);
    h.controller.dispose();
  });
});
