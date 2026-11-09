// The confirmation before the desktop window closes (product-owner design
// §6.1). The host holds the close and sends `scada:close`: a Candidate is
// asked ("candidate"), accepted work still running only shown while the
// exit waits ("waiting"). A confirmation is acknowledged with `shown` at
// once; a webview that does not acknowledge is taken as unresponsive and the
// exit proceeds without it.

export const CLOSE_EVENT = "scada:close";

export interface ClosePrompt {
  id: number;
  kind: "candidate" | "waiting";
}

/** What the window shows: a question, the exit's wait, or nothing. */
export type CloseView =
  | { kind: "candidate"; id: number }
  | { kind: "waiting" }
  | { kind: "discarding" }
  | undefined;

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
type Listen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

export interface CloseConfirmation {
  /** Answer the open question: discard the Candidate and exit, or stay. */
  answer(reply: "discard" | "cancel"): Promise<void>;
  dispose(): void;
}

export function createCloseConfirmation(
  invoke: Invoke,
  listen: Listen,
  onchange: (view: CloseView) => void,
): CloseConfirmation {
  let view: CloseView;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const show = (next: CloseView) => {
    view = next;
    onchange(next);
  };
  void listen<ClosePrompt>(CLOSE_EVENT, ({ payload }) => {
    if (payload?.kind === "candidate" && typeof payload.id === "number") {
      show({ kind: "candidate", id: payload.id });
      void invoke("app_close_reply", { id: payload.id, reply: "shown" }).catch(
        () => {},
      );
    } else if (payload?.kind === "waiting") show({ kind: "waiting" });
  }).then(
    (stop) => {
      if (disposed) stop();
      else unlisten = stop;
    },
    () => {},
  );
  return {
    async answer(reply) {
      const asked = view;
      if (asked?.kind !== "candidate") return;
      show(reply === "discard" ? { kind: "discarding" } : undefined);
      try {
        await invoke("app_close_reply", { id: asked.id, reply });
      } catch {
        // A newer question replaced it, or the exit already started: the
        // host's latest event decides what is shown.
        if (view?.kind === "discarding") show(undefined);
      }
    },
    dispose() {
      disposed = true;
      unlisten?.();
    },
  };
}
