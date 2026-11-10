/** Per-App selection/view lifetime only; never owns or closes a coordinator. */
import { isAsyncOperationsClient } from "./coordinator";
import type {
  AsyncOperationsClient,
  AsyncOperationsState,
  ViewLease,
  IntentControl,
} from "./state";
import type { Project } from "../project";
import { parseRecordingPlan } from "../recording-plan";
import { sameOwnedJson } from "../json-equality";
import type { DesiredRecordingPlan } from "../recording-plan";
import {
  parseRecordingChangeRequest,
  type RecordingChangeRequest,
} from "../recording-operations-contract";
interface Selection {
  client?: AsyncOperationsClient;
  project: Project;
  generation: number;
  openOwner: object | null;
  blocked: boolean;
  qualifies?: () => boolean;
}
export interface AsyncMonitorState {
  readonly state?: AsyncOperationsState;
  readonly connection:
    "offline" | "invalidContext" | "contextMismatch" | "ready";
  readonly oldOwner: boolean;
  readonly desired?: DesiredRecordingPlan;
  readonly canPreflight: boolean;
  readonly canPause: boolean;
  readonly canApply: boolean;
  readonly canDiscard: boolean;
  readonly canDiscardOriginal: boolean;
  readonly canInspect: boolean;
  readonly canReconcile: boolean;
  readonly canCancel: boolean;
  readonly canCancelRead: boolean;
  readonly canSwitch: boolean;
}
export function createAsyncOperationsMonitor() {
  let selection: Selection | undefined,
    client: AsyncOperationsClient | undefined,
    off: (() => void) | undefined;
  let target:
    | {
        project: Project;
        generation: number;
        client: AsyncOperationsClient;
        identity: object;
      }
    | undefined;
  let lease: ViewLease | undefined,
    leaseOpen: object | null = null,
    leaseIdentity: object | undefined,
    leaseSelectedClient: AsyncOperationsClient | undefined,
    disposed = false;
  const listeners = new Set<(s: AsyncMonitorState) => void>();
  let view: AsyncMonitorState = Object.freeze({
    connection: "offline",
    oldOwner: false,
    canPreflight: false,
    canPause: false,
    canApply: false,
    canDiscard: false,
    canDiscardOriginal: false,
    canInspect: false,
    canReconcile: false,
    canCancel: false,
    canCancelRead: false,
    canSwitch: false,
  });
  function selected() {
    const s = selection;
    if (!s?.client) return { connection: "offline" as const };
    if (!isAsyncOperationsClient(s.client))
      return { connection: "invalidContext" as const };
    const c = s.client.context;
    if (
      c.target.projectId !== s.project.manifest.projectId ||
      c.target.projectRevision !== s.project.manifest.projectRevision
    )
      return { connection: "contextMismatch" as const };
    try {
      return {
        connection: "ready" as const,
        client: s.client,
        desired: s.project.recordingPlan
          ? parseRecordingPlan(s.project.recordingPlan)
          : undefined,
      };
    } catch {
      return { connection: "invalidContext" as const };
    }
  }
  function retire() {
    lease?.retire();
    lease = undefined;
    leaseOpen = null;
    leaseIdentity = undefined;
    leaseSelectedClient = undefined;
  }
  function publish() {
    if (disposed) return;
    const selectedView = selected(),
      s = client?.current();
    const own =
      !!selection &&
      selectedView.client === client &&
      target?.project === selection.project &&
      target.generation === selection.generation;
    const sameWorkflow = !s?.change || s.identity === target?.identity;
    const current =
      own &&
      sameWorkflow &&
      (!s?.change ||
        (!!selectedView.desired &&
          sameOwnedJson(selectedView.desired, s.change.apply.desired)));
    const enabled = !!selection?.openOwner && !selection.blocked && !!lease;
    view = Object.freeze({
      state: s,
      connection: selectedView.connection,
      desired: selectedView.desired,
      oldOwner: !!s && (!own || !sameWorkflow),
      canPreflight:
        enabled && own && !!selectedView.desired && !!s?.canPreflight,
      canPause: enabled && current && !!s?.canPause,
      canApply: enabled && current && !!s?.canApply,
      canDiscard: enabled && current && !!s?.canDiscard,
      canDiscardOriginal: enabled && !current && !!s?.canDiscard,
      canInspect: enabled && !!s?.canInspect,
      canReconcile: enabled && !!s?.canReconcile,
      canCancel: enabled && !!s?.canCancel,
      canCancelRead: enabled && !!s?.canCancelRead,
      canSwitch:
        !!selection?.openOwner &&
        !selection.blocked &&
        !!selectedView.client &&
        selectedView.client !== client &&
        !!s?.safeToSwitch,
    });
    const issued = view;
    for (const listener of [...listeners]) {
      if (view !== issued) break;
      if (listeners.has(listener))
        try {
          listener(issued);
        } catch {
          /* isolate */
        }
    }
  }
  /**
   * With no client selected (the slot is empty), a closed owner that has
   * nothing left to watch is let go, so the view reads as offline and the next
   * owner attaches on its own. Replacing one owner by another stays explicit.
   */
  function releaseFinished() {
    if (selection?.client || !client) return;
    const s = client.current();
    if (!s.closed || !s.safeToSwitch) return;
    off?.();
    off = undefined;
    retire();
    client = undefined;
    target = undefined;
  }
  /**
   * After a login again, the closed client of the same page still holds the
   * Candidate that `c` took over from the host: nothing is left to watch there.
   */
  function continuesHeld(c: AsyncOperationsClient) {
    const old = client?.current();
    if (!old?.closed || !old.change) return false;
    const next = c.current();
    return (
      next.resumed &&
      (next.change ?? next.reservedChange)?.changeId === old.change.changeId
    );
  }
  function attach(c: AsyncOperationsClient) {
    off?.();
    retire();
    client = c;
    off = c.subscribe(() => {
      releaseFinished();
      publish();
    });
  }
  function bind() {
    const s = selection;
    if (!s || !client) return;
    if (
      !target ||
      target.project !== s.project ||
      target.generation !== s.generation ||
      target.client !== client
    ) {
      target = {
        project: s.project,
        generation: s.generation,
        client,
        identity: Object.freeze({}),
      };
      retire();
    }
    if (!s.openOwner || s.blocked) {
      retire();
      return;
    }
    if (
      leaseOpen !== s.openOwner ||
      leaseIdentity !== target.identity ||
      leaseSelectedClient !== s.client
    ) {
      retire();
      try {
        lease = client.bindView(
          target.identity,
          () =>
            !!selection &&
            selection.project === s.project &&
            selection.generation === s.generation &&
            selection.openOwner === s.openOwner &&
            selection.client === s.client &&
            !selection.blocked &&
            (s.qualifies === undefined || s.qualifies() === true),
        );
        leaseOpen = s.openOwner;
        leaseIdentity = target.identity;
        leaseSelectedClient = s.client;
      } catch {
        /* closed root */
      }
    }
  }
  function allowed(
    key: keyof AsyncMonitorState,
    run: (l: ViewLease) => boolean,
  ): boolean {
    // Recompute immediately; event callbacks cannot use stale render authority.
    publish();
    if (disposed || !lease || !view[key] || selection?.blocked) return false;
    return run(lease);
  }
  return {
    current: () => view,
    subscribe(listener: (s: AsyncMonitorState) => void) {
      listeners.add(listener);
      listener(view);
      return () => {
        listeners.delete(listener);
      };
    },
    select(s: Selection) {
      if (disposed) return;
      selection = s;
      releaseFinished();
      const c = selected().client;
      if (c && s.openOwner && (!client || (c !== client && continuesHeld(c))))
        attach(c);
      bind();
      publish();
    },
    switchToSelected() {
      publish();
      const c = selected().client;
      if (!view.canSwitch || !c) return false;
      attach(c);
      bind();
      publish();
      return true;
    },
    preflight(change: RecordingChangeRequest, control: IntentControl) {
      try {
        const owned = parseRecordingChangeRequest(change);
        const desired = selected().desired;
        if (!desired || !sameOwnedJson(desired, owned.apply.desired))
          return false;
        return allowed("canPreflight", (l) => l.preflight(owned, control));
      } catch {
        return false;
      }
    },
    pause: (c: IntentControl) => allowed("canPause", (l) => l.pause(c)),
    apply: (c: IntentControl) => allowed("canApply", (l) => l.apply(c)),
    discard: (c: IntentControl, old = false) =>
      allowed(old ? "canDiscardOriginal" : "canDiscard", (l) => l.discard(c)),
    inspect: (deadlineMonotonicMs: number) =>
      allowed("canInspect", (l) => l.inspectAdmission({ deadlineMonotonicMs })),
    reconcile: (c: IntentControl) =>
      allowed("canReconcile", (l) => l.reconcile(c)),
    cancel: (read = false) =>
      allowed(read ? "canCancelRead" : "canCancel", (l) =>
        read ? l.cancelReconciliation() : l.cancelOperation(),
      ),
    dispose() {
      disposed = true;
      retire();
      off?.();
      listeners.clear();
    },
  };
}
