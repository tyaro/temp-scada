import type { HistoryQuery } from "../lib/history-contract";
import type { Project } from "../lib/project";
import {
  HistorySourceError,
  type HistoryFailureCode,
  type HistorySource,
} from "../lib/history/presentation";
import type { HistoryService } from "../lib/history/workspace-model";

/** `invoke` of `@tauri-apps/api/core`, passed in so tests can replace it. */
export type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const PASSED_THROUGH: readonly HistoryFailureCode[] = [
  "deadline",
  "tooManyPoints",
  "busy",
];

/**
 * The History host of the desktop (product-owner design §7.1): one H1 query
 * per `history_query`, and an abort asks `history_cancel` to stop it. The
 * Promise settles only when the host has joined the query, so the controller
 * never starts the next one over a running read.
 */
export function nativeHistorySource(invoke: NativeInvoke): HistorySource {
  return {
    async query(query: HistoryQuery, { signal }: { signal: AbortSignal }) {
      // Nothing runs for a request aborted before it starts. A later abort
      // may reach the host before its query; the host keeps that cancel.
      if (signal.aborted) throw new HistorySourceError("failed");
      const callId = crypto.randomUUID();
      const cancel = () => {
        void invoke("history_cancel", { callId }).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await invoke<unknown>("history_query", { callId, query });
      } catch (error) {
        throw new HistorySourceError(
          PASSED_THROUGH.find((code) => code === error) ?? "failed",
        );
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

/** The part of a Project the host's context depends on. */
function contextKey(project: Project): string {
  return JSON.stringify([
    project.manifest.projectId,
    project.manifest.projectRevision,
    project.recordingPlan?.planId ?? null,
  ]);
}

/**
 * Keeps the History service of the current Project: on each change of the
 * Project's ID, revision or recording plan, it asks the host for the
 * HistoryContext v2 (`history_context`) and publishes a new service, or none
 * while the reply is pending, when the recording DB has no applied plan for
 * this Project, or when the host cannot answer. Replies to an earlier Project
 * are dropped.
 */
export function createNativeHistory(
  invoke: NativeInvoke,
  publish: (service: HistoryService | undefined) => void,
) {
  const source = nativeHistorySource(invoke);
  let key: string | undefined;
  let generation = 0;
  let disposed = false;
  return {
    update(project: Project) {
      const next = contextKey(project);
      if (disposed || next === key) return;
      key = next;
      const issued = ++generation;
      publish(undefined);
      const current = () => !disposed && issued === generation;
      invoke<unknown>("history_context", {
        projectJson: JSON.stringify(project),
      }).then(
        (context) => {
          if (current() && context != null) publish({ source, context });
        },
        () => {
          /* the History workspace shows the service as offline */
        },
      );
    },
    /** Asks again for `project`, after the host's applied plan changed.
     * Ignored unless `project` is still the current one, so a late setup
     * reply never brings back an earlier Project's context. */
    refresh(project: Project) {
      if (disposed || contextKey(project) !== key) return;
      key = undefined;
      this.update(project);
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
