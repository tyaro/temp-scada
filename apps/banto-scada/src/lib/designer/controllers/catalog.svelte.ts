import { createRequestOwner } from "@banto/admin-core";
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

const inert: CatalogDelivery = Object.freeze({
  receive: () => false,
  close() {},
  fail() {},
});

export function createCatalogController(
  getProject: () => Project,
  getSource: () => CatalogSource | undefined,
) {
  // Two keys of one owner (Banto #436):
  // - SCOPE: one subscription to one (project, source). Taken when the effect
  //   subscribes and finished at once (never busy). The next subscription
  //   supersedes it and the effect cleanup invalidates it, so a late begin()
  //   from an unsubscribed source cannot supersede the live DELIVERY.
  // - DELIVERY: one Host catalog request. Each begin() of the source starts a
  //   new one and supersedes the previous; close() / fail() finish it.
  // The project / source identity is still compared separately: it changes
  // before the effect reruns, and a reply arriving in that gap must not land.
  const requests = createRequestOwner();
  const SCOPE = "scope";
  const DELIVERY = "delivery";
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
      const scope = requests.begin(SCOPE);
      scope.finish();
      const session = createCatalogSession(project);
      const current = () =>
        scope.isCurrent() && getProject() === project && getSource() === source;
      const publish = () => {
        const next = session.selection(project);
        selection = { ...next, isCurrent: () => current() && next.isCurrent() };
      };
      publish();
      const begin = (): CatalogDelivery => {
        if (!current()) return inert;
        const request = requests.begin(DELIVERY);
        const token = session.begin();
        publish();
        const live = () => request.isCurrent() && current();
        const end = (invalid: boolean) => {
          if (request.finish() && current() && session.end(token, invalid))
            publish();
        };
        return {
          receive(payload) {
            if (!live()) return false;
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
        requests.invalidate(SCOPE);
      }
      return () => {
        requests.invalidate(SCOPE);
        requests.invalidate(DELIVERY);
        session.begin();
        try {
          unsubscribe?.();
        } catch {
          /* old source cannot break editing */
        }
      };
    });
  });
  $effect(() => () => requests.dispose());
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
