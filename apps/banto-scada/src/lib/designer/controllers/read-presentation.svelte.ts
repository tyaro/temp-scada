import { untrack } from "svelte";
import { parseProject, type Project } from "../../project";
import {
  createReadPresentationSession,
  readPresentationContext,
  type ReadPresentationFrame,
} from "../../read-presentation";

export interface ReadDelivery {
  receive(update: unknown): boolean;
  close(): void;
  fail(): void;
}
export interface ReadSource {
  /** Each Host session starts a new delivery. Retire the old one first. */
  subscribe(project: Project, begin: () => ReadDelivery): () => void;
}

export function createReadPresentationController(
  getProject: () => Project,
  getSource: () => ReadSource | undefined,
) {
  let frame = $state.raw<ReadPresentationFrame>();
  let boundSource: ReadSource | undefined;
  $effect(() => {
    const project = getProject(),
      source = getSource();
    return untrack(() => {
      boundSource = source;
      // The normal offline editor pays no full-Project validation cost here.
      if (!source) {
        frame = undefined;
        return;
      }
      const session = createReadPresentationSession(project);
      frame = session.frame;
      let active = true;
      const current = () =>
        active && getProject() === project && getSource() === source;
      let unsubscribe: (() => void) | undefined;
      const begin = (): ReadDelivery => {
        if (!current()) return { receive: () => false, close() {}, fail() {} };
        const token = session.reset(project).token;
        frame = session.frame;
        const end = (invalid: boolean) => {
          if (!current() || session.token !== token) return;
          const reset = session.reset(project);
          frame = invalid
            ? session.receive(reset.token, null).frame
            : reset.frame;
        };
        return {
          receive(update) {
            if (!current() || session.token !== token) return false;
            const result = session.receive(token, update);
            frame = result.frame;
            return result.accepted;
          },
          close: () => end(false),
          fail: () => end(true),
        };
      };
      try {
        unsubscribe = source.subscribe(
          parseProject(JSON.stringify(project)),
          begin,
        );
      } catch {
        begin().fail();
        active = false;
      }
      return () => {
        active = false;
        frame = session.reset(project).frame;
        try {
          unsubscribe?.();
        } catch {
          /* old source cannot break editing */
        }
      };
    });
  });
  return {
    get context() {
      return readPresentationContext(
        getProject(),
        getSource() === boundSource ? frame : undefined,
      );
    },
  };
}
