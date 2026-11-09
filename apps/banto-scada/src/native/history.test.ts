import { beforeEach, expect, it, vi } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, type Project } from "../lib/project";
import { HistorySourceError } from "../lib/history/presentation";
import type { HistoryQuery } from "../lib/history-contract";
import type { HistoryService } from "../lib/history/workspace-model";
import {
  createNativeHistory,
  nativeHistorySource,
  type NativeInvoke,
} from "./history";

const invoke = vi.fn();
beforeEach(() => invoke.mockReset().mockResolvedValue(null));

const query: HistoryQuery = {
  version: 1,
  kind: "query",
  requestId: "history-preview",
  seriesIds: ["series-0"],
  fromMs: 0,
  toMs: 4000,
  mode: "raw",
  maxPointsPerSeries: 100,
};

function project(revision = 1, planId?: string): Project {
  const value = structuredClone(sample) as any;
  value.manifest.projectRevision = revision;
  if (planId)
    value.recordingPlan = {
      version: 1,
      kind: "recordingPlan",
      planId,
      revision: 1,
      enabled: true,
      group: {
        groupId: "group",
        hubRef: "hub",
        periodMs: 1000,
        members: [
          {
            memberId: "member-0",
            externalName: "Line1.Temperature",
            valueType: "number",
          },
        ],
      },
    };
  return parseProject(JSON.stringify(value));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("runs one host query per call and cancels it by its own call ID", async () => {
  const reply = deferred<unknown>();
  invoke.mockImplementation((command: string) =>
    command === "history_query" ? reply.promise : Promise.resolve(null),
  );
  const abort = new AbortController();
  const result = nativeHistorySource(invoke).query(query, {
    signal: abort.signal,
  });
  const callId = invoke.mock.calls[0][1].callId;
  expect(invoke).toHaveBeenCalledWith("history_query", { callId, query });
  abort.abort();
  expect(invoke).toHaveBeenCalledWith("history_cancel", { callId });
  // The Promise settles only when the host has joined the query.
  reply.resolve({ kind: "result" });
  await expect(result).resolves.toEqual({ kind: "result" });
  abort.abort();
  expect(
    invoke.mock.calls.filter(([command]) => command === "history_cancel"),
  ).toHaveLength(1);
});

it("sends nothing for a signal aborted before the query", async () => {
  const abort = new AbortController();
  abort.abort();
  const failure = await nativeHistorySource(invoke)
    .query(query, { signal: abort.signal })
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(HistorySourceError);
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  ["deadline", "deadline"],
  ["tooManyPoints", "tooManyPoints"],
  ["busy", "busy"],
  ["cancelled", "failed"],
  ["unavailable", "failed"],
  ["invalidRequest", "failed"],
  [Error("deadline"), "failed"],
])("maps the host error %s to %s", async (error, code) => {
  const failing = (() => Promise.reject(error)) as NativeInvoke;
  const failure = await nativeHistorySource(failing)
    .query(query, { signal: new AbortController().signal })
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(HistorySourceError);
  expect((failure as HistorySourceError).code).toBe(code);
});

it("asks the host for a context only when the Project's key changes", async () => {
  const context = { version: 2, kind: "historyContext" };
  invoke.mockResolvedValue(context);
  const published: (HistoryService | undefined)[] = [];
  const history = createNativeHistory(invoke, (s) => published.push(s));
  const first = project(1, "plan-a");
  history.update(first);
  await vi.waitFor(() => expect(published).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("history_context", {
    projectJson: JSON.stringify(first),
  });
  expect(published[0]).toBeUndefined();
  expect(published[1]?.context).toBe(context);
  // Another object with the same ID, revision and plan keeps the service.
  history.update(project(1, "plan-a"));
  expect(invoke).toHaveBeenCalledOnce();
  history.update(project(2, "plan-a"));
  history.update(project(2, "plan-b"));
  history.update(project(2));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(published).toHaveLength(6));
  // One source for every service.
  expect(published[5]?.source).toBe(published[1]?.source);
});

it("publishes no service for a null context, a host error, an earlier Project or after dispose", async () => {
  const replies: ReturnType<typeof deferred<unknown>>[] = [];
  const host = (() => {
    const reply = deferred<unknown>();
    replies.push(reply);
    return reply.promise;
  }) as NativeInvoke;
  const settle = async () => {
    for (let n = 0; n < 4; n++) await Promise.resolve();
  };
  const published: (HistoryService | undefined)[] = [];
  const history = createNativeHistory(host, (s) => published.push(s));
  history.update(project(1, "plan-a"));
  history.update(project(2, "plan-a"));
  replies[0].resolve({ version: 2 });
  replies[1].resolve(null);
  await settle();
  expect(published).toEqual([undefined, undefined]);

  history.update(project(3, "plan-a"));
  replies[2].reject("store_locked");
  await settle();
  expect(published).toEqual([undefined, undefined, undefined]);

  history.update(project(4, "plan-a"));
  history.dispose();
  replies[3].resolve({ version: 2 });
  await settle();
  expect(published).toHaveLength(4);
  history.update(project(5, "plan-a"));
  expect(published).toHaveLength(4);
  expect(replies).toHaveLength(4);
});

it("refreshes only the current Project's context", async () => {
  const context = { version: 2, kind: "historyContext" };
  invoke.mockResolvedValue(context);
  const published: (HistoryService | undefined)[] = [];
  const history = createNativeHistory(invoke, (s) => published.push(s));
  const first = project(1, "plan-a");
  history.update(first);
  history.update(project(2, "plan-a"));
  await vi.waitFor(() => expect(published).toHaveLength(3));
  // A refresh for the earlier Project (a late setup reply) is ignored.
  history.refresh(first);
  expect(invoke).toHaveBeenCalledTimes(2);
  history.refresh(project(2, "plan-a"));
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("history_context", {
    projectJson: JSON.stringify(project(2, "plan-a")),
  });
  await vi.waitFor(() => expect(published).toHaveLength(5));
});
