import { untrack } from "svelte";
import {
  encodeAssetClipboard,
  decodeAssetClipboard,
  validateAssetClipboardSnapshot,
} from "../../asset-clipboard";
import {
  selectPastePayload,
  readSystemPaste,
  type PastePayload,
} from "../../image-clipboard";
import {
  serializeObjectClipboard,
  copyObjectSnapshot,
  parseClipboard,
} from "../../clipboard";
import { applyCommand, type EditCommand } from "../../editor";
import type { Project, Point, ScreenObject } from "../../project";
import type { AssetStore } from "../../image-assets";
import type { Geometry } from "../../resize";
import type { Size } from "../../viewport";

interface ClipboardOwner {
  generation: number;
  screenId: string;
  definitionId: string | undefined;
  mode: "edit" | "preview";
  busy: boolean;
  replacing: boolean;
}
export interface ClipboardHost {
  readonly owner: ClipboardOwner;
  /** Read only for model validation and copy snapshots. App owns Project/history. */
  readonly project: Project;
  readonly objects: readonly ScreenObject[];
  readonly selectedIds: readonly string[];
  readonly draft: { pending: boolean; dirty: boolean };
  readonly viewport: { bounds: Geometry; size: Size; scale: number };
  readonly store: AssetStore;
  visibleCenter(): Point | undefined;
  hiddenCanvasMutation(target: EventTarget | null): boolean;
  allow(run: () => void): boolean;
  edit(command: EditCommand): boolean;
  stopPlacement(): void;
  collectAssets(): void;
  prepareImage(
    file: File,
    generation: number,
    owner: string,
    placement: { bounds: Geometry; size: Size },
  ): Promise<void>;
  report(kind: "info" | "error", text: string): void;
}

/** Preserve browser gesture timing while owning clipboard requests and cancellation. */
export function createClipboardController(host: ClipboardHost) {
  const clipboardSession = crypto.randomUUID();
  let clipboardBusy = $state(false);
  let clipboardEpoch = 0;
  let lastPaste: { key: string; count: number } | undefined;
  function clipboardAction(
    kind: "copy" | "cut" | "paste",
    event?: ClipboardEvent,
  ) {
    if (
      host.owner.busy ||
      clipboardBusy ||
      host.owner.mode !== "edit" ||
      host.draft.pending ||
      host.owner.replacing
    )
      return;
    const target = host.owner.screenId,
      generation = host.owner.generation,
      epoch = clipboardEpoch;
    const pasteIntent = {
      bounds: { ...host.viewport.bounds },
      size: {
        width: host.viewport.size.width,
        height: host.viewport.size.height,
      },
    };
    const pasteCenter = host.visibleCenter() ?? {
      x: host.viewport.size.width / 2,
      y: host.viewport.size.height / 2,
    };
    const ids = [...host.selectedIds];
    if (kind !== "paste" && !ids.length) return;
    event?.preventDefault();
    if (kind === "cut" && event && host.hiddenCanvasMutation(event.target))
      return;
    let native = event?.clipboardData;
    let input: PastePayload | undefined;
    try {
      if (kind === "paste" && native)
        input = selectPastePayload(
          native.getData("text/plain"),
          Array.from(native.files),
        );
    } catch (error) {
      host.report(
        "error",
        `クリップボード操作に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const validTarget = () =>
      epoch === clipboardEpoch &&
      host.owner.mode === "edit" &&
      host.owner.screenId === target &&
      host.owner.generation === generation &&
      !host.owner.busy &&
      !host.owner.replacing;
    const run = async () => {
      if (!validTarget() || clipboardBusy) return;
      clipboardBusy = true;
      try {
        const revision = host.project.manifest.projectRevision;
        const origin = `${clipboardSession}:${generation}`;
        const command: EditCommand = {
          type: "remove-many",
          screenId: target,
          objectIds: ids,
          ...(host.owner.definitionId
            ? { definitionId: host.owner.definitionId }
            : {}),
        };
        if (kind === "paste") {
          const payload = input ?? (await readSystemPaste(navigator.clipboard));
          if (
            !validTarget() ||
            revision !== host.project.manifest.projectRevision ||
            host.draft.dirty ||
            host.draft.pending
          )
            return;
          if (payload.kind === "image") {
            if (host.owner.definitionId)
              throw new Error(
                "Symbol定義には画像を貼り付けできません。画面を開いてください。",
              );
            await host.prepareImage(
              payload.file,
              generation,
              target,
              pasteIntent,
            );
            return;
          }
          const text = payload.text;
          const fragment = parseClipboard(text);
          if (fragment.project.assets.length && host.owner.definitionId)
            throw new Error(
              "Symbol定義には画像を貼り付けできません。画面を開いてください。",
            );
          const candidate = await decodeAssetClipboard(fragment);
          try {
            if (
              !validTarget() ||
              revision !== host.project.manifest.projectRevision ||
              host.draft.dirty ||
              host.draft.pending
            )
              return;
            for (const asset of fragment.project.assets)
              host.store.importFrom(candidate, asset.sha256);
            const center = pasteCenter;
            const key = JSON.stringify([
              fragment.version !== 1
                ? JSON.stringify([fragment.origin, fragment.project])
                : text,
              origin,
              target,
              host.viewport.scale,
              center,
            ]);
            const count = lastPaste?.key === key ? lastPaste.count + 1 : 0;
            if (
              host.edit({
                type: "paste",
                screenId: target,
                text,
                origin,
                center,
                offset: count * 20,
              })
            ) {
              lastPaste = { key, count };
              host.stopPlacement();
            }
          } finally {
            candidate.dispose();
            host.collectAssets();
          }
        } else {
          if (kind === "cut")
            applyCommand(host.project, command, host.owner.mode);
          const snapshot = copyObjectSnapshot(
            host.project,
            target,
            ids,
            origin,
          );
          const hasImages = snapshot.project.assets.length > 0;
          if (hasImages) {
            if (
              typeof ClipboardItem === "undefined" ||
              typeof navigator.clipboard?.write !== "function"
            )
              throw new Error(
                "このブラウザは画像を含む図形コピーに対応していません。画像同梱Projectを使ってください。",
              );
            validateAssetClipboardSnapshot(snapshot);
            // Initiate the write in the user's gesture. Never await before writing event clipboardData.
            const content = encodeAssetClipboard(snapshot, host.store);
            void content.catch(() => {});
            await navigator.clipboard.write([
              new ClipboardItem({ "text/plain": content }),
            ]);
          } else {
            const text = serializeObjectClipboard(snapshot);
            if (native) native.setData("text/plain", text);
            else await navigator.clipboard.writeText(text);
          }
          if (kind === "cut") {
            if (
              !validTarget() ||
              revision !== host.project.manifest.projectRevision ||
              host.draft.dirty ||
              host.draft.pending ||
              ids.join() !== host.selectedIds.join()
            ) {
              host.report(
                "info",
                "コピーしました。編集中の状態が変わったため切り取りは中止しました。",
              );
              return;
            }
            if (host.edit(command)) host.stopPlacement();
          } else host.report("info", "選択した図形をコピーしました。");
        }
      } catch (error) {
        host.report(
          "error",
          `クリップボード操作に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clipboardBusy = false;
      }
    };
    if (host.allow(() => void run())) void run();
    else native = null;
  }
  const clipboardOwnerScope = $derived(
    `${host.owner.generation}:${host.owner.screenId}:${host.owner.mode}:${host.owner.definitionId ?? ""}:${host.owner.busy}:${!!host.owner.replacing}`,
  );
  $effect(() => {
    clipboardOwnerScope;
    untrack(() => {
      clipboardEpoch++;
    });
  });

  return {
    get busy() {
      return clipboardBusy;
    },
    action: clipboardAction,
  };
}
