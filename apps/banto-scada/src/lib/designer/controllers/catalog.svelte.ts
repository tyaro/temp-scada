import { untrack } from "svelte";
import { parseProject, type Project } from "../../project";
import {
  createCatalogSession,
  sampleSelection,
  type CatalogSelection,
} from "../../catalog-session";

export interface CatalogDelivery {
  receive(payload: unknown): boolean;
  close(): void;
  fail(): void;
}
export interface CatalogSource {
  /** Each explicit Host catalog request starts one new delivery. */
  subscribe(project: Project, begin: () => CatalogDelivery): () => void;
}

export function createCatalogController(
  getProject: () => Project,
  getSource: () => CatalogSource | undefined,
) {
  let selection = $state.raw<CatalogSelection>(sampleSelection);
  let boundSource: CatalogSource | undefined;
  $effect(() => {
    const project = getProject(),
      source = getSource();
    return untrack(() => {
      boundSource = source;
      if (!source) {
        selection = sampleSelection;
        return;
      }
      const session = createCatalogSession(project);
      let active = true;
      const current = () =>
        active && getProject() === project && getSource() === source;
      const publish = () => {
        const next = session.selection(project);
        selection = { ...next, isCurrent: () => current() && next.isCurrent() };
      };
      publish();
      const begin = (): CatalogDelivery => {
        if (!current()) return { receive: () => false, close() {}, fail() {} };
        const token = session.begin();
        publish();
        const end = (invalid: boolean) => {
          if (current() && session.end(token, invalid)) publish();
        };
        return {
          receive(payload) {
            if (!current()) return false;
            const accepted = session.receive(token, payload);
            publish();
            return accepted;
          },
          close: () => end(false),
          fail: () => end(true),
        };
      };
      let unsubscribe: (() => void) | undefined;
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
        session.begin();
        try {
          unsubscribe?.();
        } catch {
          /* old source cannot break editing */
        }
      };
    });
  });
  return {
    get selection() {
      const source = getSource();
      if (!source) return sampleSelection;
      if (source !== boundSource || !selection.isCurrent())
        return {
          ...selection,
          available: false,
          catalog: { revision: "unavailable", groups: [], tags: [] },
          isCurrent: () => false,
        };
      return selection;
    },
  };
}
