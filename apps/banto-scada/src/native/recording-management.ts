import type { Project } from "../lib/project";
import type {
  InitialSetupResult,
  ReconfigureResult,
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
 * for, and `stop` is `recording_stop`. `done` runs after a successful first
 * setup, resume or reconfiguration, which may change History's series. The
 * host answers an inspection only after its read has finished, so an
 * aborted inspection still settles on the host's reply.
 */
export function nativeRecordingManagementService(
  invoke: NativeInvoke,
  context: unknown,
  admin?: { project: Project; done: () => void },
): RecordingManagementService {
  const service: RecordingManagementService = {
    context,
    inspect: (request) => invoke<unknown>("recording_status", { request }),
  };
  if (!admin) return Object.freeze(service);
  const projectArgs = () => ({ projectJson: JSON.stringify(admin.project) });
  const phase = (value: Record<string, unknown>) =>
    value.phase === "running" ? ("running" as const) : ("starting" as const);
  return Object.freeze({
    ...service,
    initialSetup: (): Promise<InitialSetupResult> =>
      control(
        () => invoke<unknown>("recording_initial_setup", projectArgs()),
        (value) => ({ phase: phase(value) }),
        admin.done,
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
        admin.done,
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
        admin.done,
      ),
    stop: (): Promise<StopResult> =>
      control(
        () => invoke<unknown>("recording_stop"),
        () => ({ phase: "joined" as const }),
      ),
  });
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
                ? { project, done: () => setupDone(project) }
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
