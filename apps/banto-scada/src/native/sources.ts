import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Project } from "../lib/project";
import type {
  ReadDelivery,
  ReadSource,
} from "../lib/designer/controllers/read-presentation.svelte";
import type {
  CatalogDelivery,
  CatalogSource,
} from "../lib/designer/controllers/catalog.svelte";

let readCommands = Promise.resolve();

function enqueueRead(command: () => Promise<unknown>): Promise<void> {
  const result = readCommands.then(command);
  readCommands = result.then(
    () => {},
    () => {},
  );
  return result.then(() => {});
}

interface ReadPacket {
  subscriptionId: string;
  update: unknown;
}

/** How a read subscription starts: the command and its arguments. Editor
 * sends the Project it shows (`hub_read_start`); Runtime sends none and the
 * host uses its startup Project (`runtime_read_start`, Runtime mode design §5). */
export type ReadStart = (
  project: Project,
  subscriptionId: string,
) => [command: string, args: Record<string, unknown>];

export const editorReadStart: ReadStart = (project, subscriptionId) => [
  "hub_read_start",
  { projectJson: JSON.stringify(project), subscriptionId },
];

export const runtimeReadStart: ReadStart = (_project, subscriptionId) => [
  "runtime_read_start",
  { subscriptionId },
];

/** The read source over the host's `scada:read` events; `start` picks the
 * command that begins a subscription. */
export function nativeReadSource(
  start: ReadStart,
  onStream?: (phase: string) => void,
): ReadSource {
  return {
    subscribe(project: Project, begin: () => ReadDelivery) {
      const subscriptionId = crypto.randomUUID();
      const delivery = begin();
      onStream?.("購読準備");
      let active = true;
      let unlisten: (() => void) | undefined;
      void (async () => {
        try {
          const stop = await listen<ReadPacket>("scada:read", (event) => {
            if (active && event.payload.subscriptionId === subscriptionId) {
              const accepted = delivery.receive(event.payload.update);
              const update = event.payload.update as {
                text?: { connection?: string };
              };
              const phase = update?.text?.connection;
              onStream?.(
                accepted
                  ? ({
                      live: "受信中",
                      stopped: "停止",
                      unbound: "タグ待ち",
                      unauthorized: "認証が必要",
                    }[phase ?? ""] ?? "接続中")
                  : "表示データを検証できません",
              );
            }
          });
          if (!active) {
            stop();
            return;
          }
          unlisten = stop;
          const [command, args] = start(project, subscriptionId);
          await enqueueRead(() => invoke(command, args));
        } catch (error) {
          if (active) {
            delivery.fail();
            onStream?.(
              error === "unauthorized" ||
                (error instanceof Error && error.message === "unauthorized")
                ? "認証が必要"
                : "購読開始失敗",
            );
          }
        }
      })();
      return () => {
        active = false;
        unlisten?.();
        delivery.close();
        void enqueueRead(() =>
          invoke("hub_read_stop", { subscriptionId }),
        ).catch(() => {});
      };
    },
  };
}

/** Editor's sources: reads with the shown Project, and the tag catalog. */
export function nativeSources(onStream?: (phase: string) => void): {
  readSource: ReadSource;
  catalogSource: CatalogSource;
} {
  return {
    readSource: nativeReadSource(editorReadStart, onStream),
    catalogSource: {
      subscribe(project: Project, begin: () => CatalogDelivery) {
        const delivery = begin();
        let active = true;
        void invoke("hub_catalog", { projectJson: JSON.stringify(project) })
          .then((view) => {
            if (active) delivery.receive(view);
          })
          .catch(() => {
            if (active) delivery.fail();
          });
        return () => {
          active = false;
          delivery.close();
        };
      },
    },
  };
}
