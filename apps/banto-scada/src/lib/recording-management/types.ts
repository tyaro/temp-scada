import type { DesiredRecordingPlan } from "../recording-plan";

export interface RecordingManagementContext {
  readonly version: 1;
  readonly kind: "recordingManagementContext";
  readonly contextId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly deploymentId: string;
  readonly storeId: string;
  readonly historianNamespace: string | null;
}
export interface RecordingInspectionRequest {
  readonly version: 1;
  readonly kind: "recordingInspectionRequest";
  readonly requestId: string;
  readonly context: RecordingManagementContext;
}
export type InspectionError =
  | "unavailable"
  | "busy"
  | "cancelled"
  | "deadlineExceeded"
  | "budgetExceeded"
  | "corruptData"
  | "needsReopen"
  | "readerUnusable"
  | "projectionFailed"
  | "internal";
export interface AppliedPlanView {
  readonly appliedRevision: number;
  readonly commitVersion: number;
  readonly desired: DesiredRecordingPlan;
  readonly mappingRevision: number | null;
  readonly retentionAppliedRevision: number | null;
}
export interface ActivationView {
  readonly activationId: string;
  readonly appliedRevision: number;
  readonly commitVersion: number;
  readonly sessionId: string;
  readonly state: "active" | "closed" | "interrupted";
  readonly committedThrough: number;
  readonly endCommitVersion: number | null;
}
export type DatabaseView =
  | Readonly<{ state: "unavailable"; error: InspectionError }>
  | Readonly<{
      state: "available";
      snapshotCommit: number;
      currentMappingRevision: number | null;
      currentRetentionAppliedRevision: number | null;
      applied: AppliedPlanView | null;
      latestActivation: ActivationView | null;
      activeSessionId: string | null;
      activeRetentionJobId: string | null;
      retentionFence: Readonly<{
        cutoffMs: number | null;
        commitVersion: number;
      }>;
    }>;
export type HostPhase =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "finishedUnjoined"
  | "joined"
  | "faulted"
  | "noStore"
  | "retaining"
  | "managingPlan";
export type HostIssue =
  | "none"
  | "clock"
  | "source"
  | "store"
  | "invalidObservation"
  | "arithmeticOverflow"
  | "unclassified";
export type HostView =
  | Readonly<{ state: "unknown" }>
  | Readonly<{
      state: "observed";
      observedAtMs: number | null;
      runRef: string | null;
      sessionId: string | null;
      phase: HostPhase;
      stopRequested: boolean;
      issue: HostIssue;
      cleanup: "unknown" | "closed" | "interrupted" | "failed";
      sourceShutdown: "unknown" | "succeeded" | "failed";
      planRecoveryRequired: boolean | null;
      retentionRearmRequired: boolean | null;
      retentionJobPending: boolean | null;
    }>;
export type SdkView =
  | Readonly<{ state: "unknown" }>
  | Readonly<{
      state: "observed";
      observedAtMs: number | null;
      connection: "connecting" | "live" | "backoff" | "stopped" | "failed";
    }>;
export interface RecordingInspectionResponse {
  readonly version: 1;
  readonly kind: "recordingInspectionResponse";
  readonly request: RecordingInspectionRequest;
  readonly database: DatabaseView;
  readonly host: HostView;
  readonly sdk: SdkView;
}
export type RecordingManagementDocument =
  | RecordingManagementContext
  | RecordingInspectionRequest
  | RecordingInspectionResponse;
export type DesiredAppliedComparison =
  | Readonly<{
      kind:
        | "unavailable"
        | "absent"
        | "localAbsent"
        | "notApplied"
        | "differentPlan"
        | "sameRevisionConflict"
        | "matches";
    }>
  | Readonly<{ kind: "localNewer" | "localOlder"; sameContent: boolean }>;
