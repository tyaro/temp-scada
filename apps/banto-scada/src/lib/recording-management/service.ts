import type { Project } from "../project";
import {
  parseRecordingPlan,
  type DesiredRecordingPlan,
} from "../recording-plan";
import {
  parseRecordingManagementContext,
  type RecordingManagementContext,
  type RecordingInspectionRequest,
} from "../recording-management-contract";
export interface InspectionControl {
  readonly signal: AbortSignal;
  /** Absolute deadline in the same JS realm's performance.now() clock. */
  readonly deadlineMonotonicMs: number;
}
/** Replace the whole service for context changes. Settle only after read/cleanup
 * is quiescent, even on abort. Sync throw means nothing was dispatched. Native
 * adapters must also enforce a physical gate across different Apps/controllers. */
/** The outcome of a first setup: the recording phase reached, or the host's
 * error kind. Never throws. */
export type InitialSetupResult = RecordingControlResult<{
  phase: "running" | "starting";
}>;
/** The outcome of a recording control command: the host's answer, or its
 * error kind. Never throws. */
export type RecordingControlResult<T extends object> = Readonly<
  ({ ok: true } & T) | { ok: false; error: string }
>;
export type ResumeResult = RecordingControlResult<{
  phase: "running" | "starting";
  /** Whether the registry's owner was installed after the start (§5). */
  owner: "installed" | "owner_unavailable";
}>;
export type ReconfigureResult = RecordingControlResult<{
  applied: "applied" | "unchanged";
  /** Whether the plan now applied in the DB is enabled. */
  enabled: boolean;
}>;
export type StopResult = RecordingControlResult<{ phase: "joined" }>;
export type OwnerRebindResult = RecordingControlResult<{
  /** Whether the new owner was installed over the running recording. */
  owner: "installed" | "owner_unavailable";
}>;
/** The registry slot as the management workspace shows it (product-owner
 * design §4, §7.2): the Project the installed owner's operations context
 * names, or why no owner is installed. */
export type RecordingSlotView = Readonly<
  | { state: "installed"; projectId: string; projectRevision: number }
  | { state: "empty"; reason: string }
  | { state: "unknown"; error: string }
>;
export interface RecordingManagementService {
  readonly context: unknown;
  readonly inspect: (
    request: RecordingInspectionRequest,
    control: InspectionControl,
  ) => Promise<unknown>;
  /** The first setup and start of the Project's recording plan (product-owner
   * design §5). Present only when the host offers it to the current session
   * (an administrator); the host checks the role again. */
  readonly initialSetup?: () => Promise<InitialSetupResult>;
  /** Resumes the DB's applied plan with a fresh read of the Hub's tags, after
   * an apply in the registry and after a restart (product-owner design §5).
   * Administrator only, like `initialSetup`. */
  readonly resume?: () => Promise<ResumeResult>;
  /** Applies the Project's plan to the DB while recording is stopped, without
   * starting (product-owner design §5). Administrator only. */
  readonly reconfigure?: () => Promise<ReconfigureResult>;
  /** Stops recording without changing its settings (product-owner design §5).
   * Administrator only. */
  readonly stop?: () => Promise<StopResult>;
  /** Reads the registry slot. Administrator only, with `ownerRebind`. Never
   * throws. */
  readonly slot?: () => Promise<RecordingSlotView>;
  /** Points the running recording's owner at the current Project (its ID and
   * revision) after the Project was edited, without stopping the recording
   * (product-owner design §7.2). Administrator only. */
  readonly ownerRebind?: () => Promise<OwnerRebindResult>;
}
export interface RecordingManagementOwner {
  readonly project: Project;
  readonly generation: number;
  readonly openOwner: object;
  readonly service: RecordingManagementService;
  readonly inspect: RecordingManagementService["inspect"];
  readonly context: RecordingManagementContext;
  readonly desired: DesiredRecordingPlan | undefined;
}
export type RecordingManagementSelection = Readonly<
  | { phase: "idle"; owner: RecordingManagementOwner }
  | { phase: "offline" | "invalidContext" | "contextMismatch" }
>;
/** Capture a context, function and desired snapshot once per owner. Declarations
 * are compared with Project, not treated as proof of authorization/store identity. */
export function recordingManagementSelection(
  service: RecordingManagementService | undefined,
  project: Project,
  generation: number,
  openOwner: object,
): RecordingManagementSelection {
  if (!service) return Object.freeze({ phase: "offline" });
  try {
    const context = parseRecordingManagementContext(service.context),
      inspect = service.inspect;
    if (typeof inspect !== "function")
      return Object.freeze({ phase: "invalidContext" });
    if (
      context.projectId !== project.manifest.projectId ||
      context.projectRevision !== project.manifest.projectRevision
    )
      return Object.freeze({ phase: "contextMismatch" });
    const desired =
      project.recordingPlan === undefined
        ? undefined
        : parseRecordingPlan(project.recordingPlan);
    return Object.freeze({
      phase: "idle",
      owner: Object.freeze({
        project,
        generation,
        openOwner,
        service,
        inspect,
        context,
        desired,
      }),
    });
  } catch {
    return Object.freeze({ phase: "invalidContext" });
  }
}
