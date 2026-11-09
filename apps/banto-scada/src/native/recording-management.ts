import type { Project } from "../lib/project";
import type {
  InitialSetupResult,
  RecordingManagementService,
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

/**
 * The recording management service of the desktop (product-owner design
 * §5): `inspect` is one `recording_status`, and, for an administrator,
 * `initialSetup` is `recording_initial_setup` of the Project it was made
 * for. The host answers an inspection only after its read has finished, so
 * an aborted inspection still settles on the host's reply.
 */
export function nativeRecordingManagementService(
  invoke: NativeInvoke,
  context: unknown,
  setup?: { project: Project; done: () => void },
): RecordingManagementService {
  const service: RecordingManagementService = {
    context,
    inspect: (request) => invoke<unknown>("recording_status", { request }),
  };
  if (!setup) return Object.freeze(service);
  return Object.freeze({
    ...service,
    async initialSetup(): Promise<InitialSetupResult> {
      try {
        const answer = await invoke<{ phase?: unknown }>(
          "recording_initial_setup",
          { projectJson: JSON.stringify(setup.project) },
        );
        setup.done();
        return {
          ok: true,
          phase: answer?.phase === "running" ? "running" : "starting",
        };
      } catch (error) {
        return { ok: false, error: errorKind(error) };
      }
    },
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
 * after a successful first setup (the History context changes with it).
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
