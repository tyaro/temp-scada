import type { Project } from "../lib/project";
import type {
  InitialSetupResult,
  OwnerRebindResult,
  ReconfigureResult,
  RecordingSlotView,
  RecordingControlResult,
  RecordingManagementService,
  ResumeResult,
  StopResult,
} from "../lib/recording-management/service";
import type { NativeInvoke } from "./history";

/** The error kinds of the host's recording control commands. */
function errorKind(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const kind = Object.getOwnPropertyDescriptor(error, "kind")?.value;
    if (typeof kind === "string") return kind;
  }
  return "failed";
}

/** Calls one recording control command and maps its answer; a rejection
 * becomes the host's error kind, and `done` runs only after a success. */
async function control<T extends object>(
  call: () => Promise<unknown>,
  answer: (value: Record<string, unknown>) => T,
  done?: () => void,
): Promise<RecordingControlResult<T>> {
  let value: unknown;
  try {
    value = await call();
  } catch (error) {
    return { ok: false, error: errorKind(error) };
  }
  done?.();
  return {
    ok: true,
    ...answer(value !== null && typeof value === "object" ? { ...value } : {}),
  };
}

/**
 * The recording management service of the desktop (product-owner design
 * §5): `inspect` is one `recording_status`, and, for an administrator,
 * `initialSetup`, `resume` and `reconfigure` are `recording_initial_setup`,
 * `recording_resume` and `recording_reconfigure` of the Project it was made
 * for, `stop` is `recording_stop`, `slot` is `recording_slot` and
 * `ownerRebind` is `recording_owner_rebind` of the Project. `done` runs after a successful first
 * setup, resume or reconfiguration, which may change History's series. The
 * host answers an inspection only after its read has finished, so an
 * aborted inspection still settles on the host's reply.
 */
export function nativeRecordingManagementService(
  invoke: NativeInvoke,
  context: unknown,
  admin?: { project: Project; done: () => void; changed?: () => void },
): RecordingManagementService {
  const service: RecordingManagementService = {
    context,
    inspect: (request) => invoke<unknown>("recording_status", { request }),
  };
  if (!admin) return Object.freeze(service);
  const projectArgs = () => ({ projectJson: JSON.stringify(admin.project) });
  // Every successful operation may install or take out the recording root:
  // the asynchronous operations read `recording_slot` again (design §7.2).
  const changed = () => admin.changed?.();
  const done = () => {
    admin.done();
    changed();
  };
  const phase = (value: Record<string, unknown>) =>
    value.phase === "running" ? ("running" as const) : ("starting" as const);
  return Object.freeze({
    ...service,
    initialSetup: (): Promise<InitialSetupResult> =>
      control(
        () => invoke<unknown>("recording_initial_setup", projectArgs()),
        (value) => ({ phase: phase(value) }),
        done,
      ),
    resume: (): Promise<ResumeResult> =>
      control(
        () => invoke<unknown>("recording_resume", projectArgs()),
        (value) => ({
          phase: phase(value),
          owner:
            value.owner === "installed"
              ? ("installed" as const)
              : ("owner_unavailable" as const),
        }),
        done,
      ),
    reconfigure: (): Promise<ReconfigureResult> =>
      control(
        () => invoke<unknown>("recording_reconfigure", projectArgs()),
        (value) => ({
          applied:
            value.applied === "unchanged"
              ? ("unchanged" as const)
              : ("applied" as const),
          enabled: value.enabled === true,
        }),
        done,
      ),
    stop: (): Promise<StopResult> =>
      control(
        () => invoke<unknown>("recording_stop"),
        () => ({ phase: "joined" as const }),
        changed,
      ),
    slot: async (): Promise<RecordingSlotView> => {
      let value: unknown;
      try {
        value = await invoke<unknown>("recording_slot");
      } catch (error) {
        return Object.freeze({ state: "unknown", error: errorKind(error) });
      }
      return slotView(value);
    },
    ownerRebind: (): Promise<OwnerRebindResult> =>
      control(
        () => invoke<unknown>("recording_owner_rebind", projectArgs()),
        (value) => ({
          owner:
            value.owner === "installed"
              ? ("installed" as const)
              : ("owner_unavailable" as const),
        }),
        changed,
      ),
  });
}

/** `recording_slot`'s answer as the workspace shows it: the Project of the
 * installed owner's operations context (its target). */
function slotView(value: unknown): RecordingSlotView {
  const field = (v: unknown, key: string): unknown =>
    v !== null && typeof v === "object"
      ? Object.getOwnPropertyDescriptor(v, key)?.value
      : undefined;
  const state = field(value, "state");
  if (state === "empty") {
    const reason = field(value, "reason");
    return Object.freeze({
      state: "empty",
      reason: typeof reason === "string" ? reason : "unknown",
    });
  }
  const target = field(field(field(value, "scope"), "context"), "target");
  const projectId = field(target, "projectId");
  const projectRevision = field(target, "projectRevision");
  if (
    state === "installed" &&
    typeof projectId === "string" &&
    typeof projectRevision === "number"
  )
    return Object.freeze({ state: "installed", projectId, projectRevision });
  return Object.freeze({ state: "unknown", error: "failed" });
}

/** Who may do what: the part of the auth session the service depends on. */
export interface ManagementAccess {
  /** Any signed-in session (the synthetic one included). */
  readonly signedIn: boolean;
  readonly admin: boolean;
  /** Changes whenever the session changes, so a new context is read. */
  readonly sessionKey: string;
}

/**
 * Keeps the recording management service of the current Project and
 * session: on each change of the Project's ID or revision, or of the
 * session, it asks the host for the management context (`recording_context`,
 * Viewer or above) and publishes a new service, or none while the reply is
 * pending, while no one is signed in, or when the host cannot answer.
 * Replies to an earlier Project or session are dropped. `setupDone` runs
 * after a successful first setup, resume or reconfiguration (the History
 * context changes with them).
 */
export function createNativeRecordingManagement(
  invoke: NativeInvoke,
  publish: (service: RecordingManagementService | undefined) => void,
  setupDone: (project: Project) => void,
  ownerChanged?: () => void,
) {
  let key: string | undefined;
  let generation = 0;
  let disposed = false;
  return {
    update(project: Project, access: ManagementAccess) {
      const next = JSON.stringify([
        project.manifest.projectId,
        project.manifest.projectRevision,
        project.recordingPlan ?? null,
        access.signedIn,
        access.admin,
        access.sessionKey,
      ]);
      if (disposed || next === key) return;
      key = next;
      const issued = ++generation;
      publish(undefined);
      if (!access.signedIn) return;
      const current = () => !disposed && issued === generation;
      invoke<unknown>("recording_context", {
        projectJson: JSON.stringify(project),
      }).then(
        (context) => {
          if (!current()) return;
          publish(
            nativeRecordingManagementService(
              invoke,
              context,
              access.admin
                ? {
                    project,
                    done: () => setupDone(project),
                    changed: ownerChanged,
                  }
                : undefined,
            ),
          );
        },
        () => {
          /* the management workspace shows the service as offline */
        },
      );
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
