import { expect, it, vi } from "vitest";
import type { RecordingManagementService } from "../../lib/recording-management/service";
import {
  inspectRuntimeRecording,
  RECORDING_CHECK_IN_EDITOR_NOTE,
  RECORDING_IN_EDITOR_NOTE,
  recordingFailureView,
  runtimeRecordingBadge,
} from "./recording-status";

const context = {
  version: 1,
  kind: "recordingManagementContext",
  contextId: "host:test",
  projectId: "project-a",
  projectRevision: 1,
  deploymentId: "deployment:test",
  storeId: "store:test",
  historianNamespace: null,
};

const unconfigured = {
  state: "available",
  snapshotCommit: 0,
  currentMappingRevision: null,
  currentRetentionAppliedRevision: null,
  applied: null,
  latestActivation: null,
  activeSessionId: null,
  activeRetentionJobId: null,
  retentionFence: { cutoffMs: null, commitVersion: 0 },
};

function service(
  inspect: RecordingManagementService["inspect"],
): RecordingManagementService {
  return { context, inspect };
}

const answer = (database: unknown) =>
  vi.fn(async (request: unknown) => ({
    version: 1,
    kind: "recordingInspectionResponse",
    request,
    database,
    host: { state: "unknown" },
    sdk: { state: "unknown" },
  }));

it("shows an inspection's summary with the note that recording starts in Editor", async () => {
  const inspect = answer(unconfigured);
  const view = await inspectRuntimeRecording(service(inspect), "r:1", () => 0);
  expect(inspect).toHaveBeenCalledOnce();
  expect(inspect.mock.calls[0][0]).toMatchObject({ requestId: "r:1", context });
  expect(view).toMatchObject({
    state: "observed",
    summary: { state: "unconfigured" },
  });
  expect(runtimeRecordingBadge(view)).toMatchObject({
    label: "記録未設定",
    note: RECORDING_IN_EDITOR_NOTE,
  });
});

const plan = {
  version: 1,
  kind: "recordingPlan",
  planId: "plan-a",
  revision: 1,
  enabled: true,
  group: {
    groupId: "group",
    hubRef: "hub",
    periodMs: 1000,
    members: [
      {
        memberId: "member-0",
        externalName: "Plant.Number",
        valueType: "number",
      },
    ],
  },
};
const running = {
  ...unconfigured,
  snapshotCommit: 6,
  currentMappingRevision: 1,
  currentRetentionAppliedRevision: 1,
  applied: {
    appliedRevision: 1,
    commitVersion: 4,
    desired: plan,
    mappingRevision: 1,
    retentionAppliedRevision: 1,
  },
  latestActivation: {
    activationId: "activation:1",
    appliedRevision: 1,
    commitVersion: 5,
    sessionId: "session:1",
    state: "active",
    committedThrough: 0,
    endCommitVersion: null,
  },
  activeSessionId: "session:1",
};

it("has no note while recording and asks Editor to check an unknown state", async () => {
  const recording = await inspectRuntimeRecording(
    service(answer(running)),
    "r:2",
  );
  expect(runtimeRecordingBadge(recording)).toMatchObject({
    label: "記録中",
    variant: "success",
  });
  expect(runtimeRecordingBadge(recording).note).toBeUndefined();
  const unknown = await inspectRuntimeRecording(
    service(answer({ state: "unavailable", error: "busy" })),
    "r:3",
  );
  expect(runtimeRecordingBadge(unknown)).toMatchObject({
    label: "記録状態不明",
    note: RECORDING_CHECK_IN_EDITOR_NOTE,
  });
});

it("reads a refusal for want of a session as sign-in, others as unavailable", async () => {
  expect(recordingFailureView({ kind: "unauthorized" }).state).toBe(
    "signedOut",
  );
  expect(recordingFailureView({ kind: "forbidden" }).state).toBe("signedOut");
  expect(recordingFailureView({ kind: "failed" }).state).toBe("unavailable");
  const refused = await inspectRuntimeRecording(
    service(() => Promise.reject({ kind: "unauthorized" })),
    "r:4",
  );
  expect(runtimeRecordingBadge(refused).label).toBe("記録: ログインが必要");
  const invalid = await inspectRuntimeRecording(
    { context: {}, inspect: vi.fn() },
    "r:5",
  );
  expect(runtimeRecordingBadge(invalid).label).toBe("記録: 確認できません");
});
