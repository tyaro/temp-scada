import { beforeEach, expect, it, vi } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, type Project } from "../lib/project";
import type { RecordingManagementService } from "../lib/recording-management/service";
import type { NativeInvoke } from "./history";
import {
  createNativeRecordingManagement,
  nativeRecordingManagementService,
  type ManagementAccess,
} from "./recording-management";

const invoke = vi.fn();
beforeEach(() => invoke.mockReset().mockResolvedValue(null));

function project(revision = 1): Project {
  const value = structuredClone(sample) as any;
  value.manifest.projectRevision = revision;
  return parseProject(JSON.stringify(value));
}

const viewer: ManagementAccess = {
  signedIn: true,
  admin: false,
  sessionKey: "viewer",
};
const admin: ManagementAccess = {
  signedIn: true,
  admin: true,
  sessionKey: "admin",
};
const nobody: ManagementAccess = {
  signedIn: false,
  admin: false,
  sessionKey: "null",
};

async function settle() {
  for (let n = 0; n < 4; n++) await Promise.resolve();
}

it("inspects with recording_status and sets up only for an administrator", async () => {
  const context = { kind: "recordingManagementContext" };
  const request = { kind: "recordingInspectionRequest" } as any;
  const done = vi.fn();
  const plain = nativeRecordingManagementService(invoke, context);
  expect(plain.context).toBe(context);
  expect(plain.initialSetup).toBeUndefined();
  invoke.mockResolvedValue({ kind: "recordingInspectionResponse" });
  await expect(
    plain.inspect(request, {
      signal: new AbortController().signal,
      deadlineMonotonicMs: 0,
    }),
  ).resolves.toEqual({ kind: "recordingInspectionResponse" });
  expect(invoke).toHaveBeenCalledWith("recording_status", { request });

  const target = project();
  const service = nativeRecordingManagementService(invoke, context, {
    project: target,
    done,
  });
  invoke.mockResolvedValue({ phase: "running" });
  await expect(service.initialSetup!()).resolves.toEqual({
    ok: true,
    phase: "running",
  });
  expect(invoke).toHaveBeenLastCalledWith("recording_initial_setup", {
    projectJson: JSON.stringify(target),
  });
  expect(done).toHaveBeenCalledOnce();
});

it.each([
  [{ kind: "tags_unresolved" }, "tags_unresolved"],
  [
    { kind: "recordingUnavailable", reason: "store_locked" },
    "recordingUnavailable",
  ],
  ["broken", "failed"],
])("reports the setup error %j as %s without throwing", async (error, kind) => {
  const done = vi.fn();
  const failing = (() => Promise.reject(error)) as NativeInvoke;
  const service = nativeRecordingManagementService(
    failing,
    {},
    {
      project: project(),
      done,
    },
  );
  await expect(service.initialSetup!()).resolves.toEqual({
    ok: false,
    error: kind,
  });
  expect(done).not.toHaveBeenCalled();
});

it("resumes, reconfigures and stops only for an administrator", async () => {
  const plain = nativeRecordingManagementService(invoke, {});
  expect(plain.resume).toBeUndefined();
  expect(plain.reconfigure).toBeUndefined();
  expect(plain.stop).toBeUndefined();

  const done = vi.fn();
  const target = project();
  const projectJson = JSON.stringify(target);
  const service = nativeRecordingManagementService(
    invoke,
    {},
    {
      project: target,
      done,
    },
  );
  invoke.mockResolvedValue({ phase: "joined" });
  await expect(service.stop!()).resolves.toEqual({ ok: true, phase: "joined" });
  expect(invoke).toHaveBeenLastCalledWith("recording_stop");
  // Stopping does not change History's series.
  expect(done).not.toHaveBeenCalled();

  invoke.mockResolvedValue({ applied: "applied", enabled: true });
  await expect(service.reconfigure!()).resolves.toEqual({
    ok: true,
    applied: "applied",
    enabled: true,
  });
  expect(invoke).toHaveBeenLastCalledWith("recording_reconfigure", {
    projectJson,
  });
  expect(done).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue({ applied: "unchanged", enabled: false });
  await expect(service.reconfigure!()).resolves.toEqual({
    ok: true,
    applied: "unchanged",
    enabled: false,
  });
  expect(done).toHaveBeenCalledTimes(2);

  invoke.mockResolvedValue({ phase: "running", owner: "installed" });
  await expect(service.resume!()).resolves.toEqual({
    ok: true,
    phase: "running",
    owner: "installed",
  });
  expect(invoke).toHaveBeenLastCalledWith("recording_resume", { projectJson });
  invoke.mockResolvedValue({ phase: "starting", owner: "owner_unavailable" });
  await expect(service.resume!()).resolves.toEqual({
    ok: true,
    phase: "starting",
    owner: "owner_unavailable",
  });
  expect(done).toHaveBeenCalledTimes(4);
});

it.each([
  ["resume", { kind: "plan_disabled" }, "plan_disabled"],
  ["reconfigure", { kind: "plan_conflict" }, "plan_conflict"],
  [
    "reconfigure",
    { kind: "recordingUnavailable", reason: "store_locked" },
    "recordingUnavailable",
  ],
  ["stop", { kind: "not_allowed" }, "not_allowed"],
  ["stop", "broken", "failed"],
] as const)(
  "reports the %s error %j as %s without throwing",
  async (action, error, kind) => {
    const done = vi.fn();
    const failing = (() => Promise.reject(error)) as NativeInvoke;
    const service = nativeRecordingManagementService(
      failing,
      {},
      { project: project(), done },
    );
    await expect(service[action]!()).resolves.toEqual({
      ok: false,
      error: kind,
    });
    expect(done).not.toHaveBeenCalled();
  },
);

it("reads a context per Project and session, and none without a session", async () => {
  const context = { kind: "recordingManagementContext" };
  invoke.mockResolvedValue(context);
  const published: (RecordingManagementService | undefined)[] = [];
  const setupDone = vi.fn();
  const management = createNativeRecordingManagement(
    invoke,
    (s) => published.push(s),
    setupDone,
  );
  management.update(project(1), nobody);
  expect(invoke).not.toHaveBeenCalled();
  expect(published).toEqual([undefined]);

  management.update(project(1), viewer);
  await vi.waitFor(() => expect(published).toHaveLength(3));
  expect(published[2]?.context).toBe(context);
  expect(published[2]?.initialSetup).toBeUndefined();
  expect(published[2]?.resume).toBeUndefined();
  expect(published[2]?.reconfigure).toBeUndefined();
  expect(published[2]?.stop).toBeUndefined();
  // The same key keeps the service.
  management.update(project(1), viewer);
  expect(invoke).toHaveBeenCalledOnce();

  management.update(project(1), admin);
  await vi.waitFor(() => expect(published).toHaveLength(5));
  const service = published[4]!;
  invoke.mockResolvedValue({ phase: "starting" });
  await expect(service.initialSetup!()).resolves.toEqual({
    ok: true,
    phase: "starting",
  });
  expect(setupDone).toHaveBeenCalledOnce();
  invoke.mockResolvedValue({ phase: "running", owner: "installed" });
  await expect(service.resume!()).resolves.toMatchObject({ ok: true });
  expect(invoke).toHaveBeenLastCalledWith("recording_resume", {
    projectJson: JSON.stringify(project(1)),
  });
  expect(setupDone).toHaveBeenCalledTimes(2);
  expect(setupDone).toHaveBeenLastCalledWith(project(1));
  invoke.mockResolvedValue({ phase: "joined" });
  await expect(service.stop!()).resolves.toEqual({ ok: true, phase: "joined" });
});

it("drops replies to an earlier Project or session and after dispose", async () => {
  const replies: ((value: unknown) => void)[] = [];
  const host = (() =>
    new Promise<unknown>((resolve) => replies.push(resolve))) as NativeInvoke;
  const published: (RecordingManagementService | undefined)[] = [];
  const management = createNativeRecordingManagement(
    host,
    (s) => published.push(s),
    () => {},
  );
  management.update(project(1), viewer);
  management.update(project(2), viewer);
  replies[0]({});
  await settle();
  expect(published).toEqual([undefined, undefined]);
  management.dispose();
  replies[1]({});
  await settle();
  expect(published).toEqual([undefined, undefined]);
});

it("reads the slot and rebinds the owner only for an administrator", async () => {
  const plain = nativeRecordingManagementService(invoke, {});
  expect(plain.slot).toBeUndefined();
  expect(plain.ownerRebind).toBeUndefined();

  const done = vi.fn();
  const target = project(3);
  const service = nativeRecordingManagementService(
    invoke,
    {},
    { project: target, done },
  );
  invoke.mockResolvedValue({
    state: "installed",
    generation: 2,
    scope: {
      ownerRef: "owner",
      ownerEpoch: "epoch",
      context: {
        target: {
          projectId: target.manifest.projectId,
          projectRevision: 2,
        },
      },
    },
  });
  await expect(service.slot!()).resolves.toEqual({
    state: "installed",
    projectId: target.manifest.projectId,
    projectRevision: 2,
  });
  expect(invoke).toHaveBeenLastCalledWith("recording_slot");
  invoke.mockResolvedValue({ state: "empty", reason: "no_recording_run" });
  await expect(service.slot!()).resolves.toEqual({
    state: "empty",
    reason: "no_recording_run",
  });
  invoke.mockResolvedValue({ state: "installed", scope: {} });
  await expect(service.slot!()).resolves.toEqual({
    state: "unknown",
    error: "failed",
  });
  const failing = (() =>
    Promise.reject({ kind: "unauthorized" })) as NativeInvoke;
  await expect(
    nativeRecordingManagementService(failing, {}, { project: target, done })
      .slot!(),
  ).resolves.toEqual({ state: "unknown", error: "unauthorized" });

  invoke.mockResolvedValue({ owner: "installed" });
  await expect(service.ownerRebind!()).resolves.toEqual({
    ok: true,
    owner: "installed",
  });
  expect(invoke).toHaveBeenLastCalledWith("recording_owner_rebind", {
    projectJson: JSON.stringify(target),
  });
  const busy = (() => Promise.reject({ kind: "busy" })) as NativeInvoke;
  await expect(
    nativeRecordingManagementService(busy, {}, { project: target, done })
      .ownerRebind!(),
  ).resolves.toEqual({ ok: false, error: "busy" });
  // The rebind does not change History's series.
  expect(done).not.toHaveBeenCalled();
});
