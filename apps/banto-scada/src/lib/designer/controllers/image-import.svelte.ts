import { tick, untrack } from "svelte";
import { AssetStore } from "../../image-assets";
import { initialImageFrame } from "../../image-frame";
import { newId, type EditCommand } from "../../editor";
import type { BackgroundImage, ImageAsset, ScreenObject } from "../../project";
import type { Geometry } from "../../resize";
import type { Size } from "../../viewport";

interface ImageOwner {
  generation: number;
  screenId: string;
  mode: "edit" | "preview";
  definition: boolean;
  busy: boolean;
  replacing: boolean;
}
export interface ImageImportHost {
  readonly owner: ImageOwner;
  readonly selected: ScreenObject | undefined;
  readonly selectedIds: readonly string[];
  readonly viewport: { bounds: Geometry; size: Size };
  readonly store: AssetStore;
  assetByHash(hash: string): ImageAsset | undefined;
  background(screenId: string): BackgroundImage | undefined;
  chooseReplacement(): void;
  choosePlacement(): void;
  transition(run: () => void): void;
  allow(run: () => void): boolean;
  edit(command: EditCommand): boolean;
  stopPlacement(): void;
  collectAssets(): void;
  revealObject(id: string): void;
  report(kind: "error", text: string): void;
}

/** Own image requests and their temporary stores; Project/history stay in App. */
export function createImageImportController(host: ImageImportHost) {
  let imageReadRequest = 0;
  let imageBusy = $state(false);

  let replacementImageEpoch = 0;
  let replacementCropEpoch = 0;
  let replacementImageIntent: {
    generation: number;
    owner: string;
    objectId: string;
    assetId: string;
    epoch: number;
    cropEpoch: number;
  } | null = null;
  function openImageReplacement(objectId: string) {
    if (
      host.owner.mode !== "edit" ||
      host.owner.definition ||
      host.owner.busy ||
      imageBusy ||
      host.owner.replacing ||
      host.selected?.id !== objectId ||
      host.selected.shape.type !== "image" ||
      host.selected.locked
    )
      return;
    replacementImageIntent = {
      generation: host.owner.generation,
      owner: host.owner.screenId,
      objectId,
      assetId: host.selected.shape.assetId,
      epoch: replacementImageEpoch,
      cropEpoch: replacementCropEpoch,
    };
    host.chooseReplacement();
  }
  function replaceImageFile(file: File | undefined) {
    const intent = replacementImageIntent;
    replacementImageIntent = null;
    if (!file || !intent) return;
    const current = () =>
      intent.generation === host.owner.generation &&
      intent.owner === host.owner.screenId &&
      intent.epoch === replacementImageEpoch &&
      host.owner.mode === "edit" &&
      !host.owner.definition &&
      !host.owner.busy &&
      !host.owner.replacing &&
      host.selected?.id === intent.objectId &&
      host.selected.shape.type === "image" &&
      host.selected.shape.assetId === intent.assetId &&
      !host.selected.locked;
    if (!current() || intent.cropEpoch !== replacementCropEpoch) return;
    host.transition(() => {
      if (current())
        void prepareImage(file, intent.generation, intent.owner, undefined, {
          ...intent,
          cropEpoch: replacementCropEpoch,
        });
    });
  }
  let placementIntent: {
    generation: number;
    owner: string;
    bounds: Geometry;
    size: { width: number; height: number };
  } | null = null;
  function openImageFile() {
    if (
      host.owner.mode !== "edit" ||
      host.owner.definition ||
      host.owner.busy ||
      imageBusy ||
      host.owner.replacing
    )
      return;
    placementIntent = {
      generation: host.owner.generation,
      owner: host.owner.screenId,
      bounds: { ...host.viewport.bounds },
      size: {
        width: host.viewport.size.width,
        height: host.viewport.size.height,
      },
    };
    host.choosePlacement();
  }
  function placeImageFile(file: File | undefined) {
    const intent = placementIntent;
    placementIntent = null;
    if (
      !file ||
      !intent ||
      intent.generation !== host.owner.generation ||
      intent.owner !== host.owner.screenId ||
      host.owner.definition ||
      host.owner.mode !== "edit" ||
      host.owner.busy ||
      host.owner.replacing
    )
      return;
    host.transition(() => {
      if (
        intent.generation !== host.owner.generation ||
        intent.owner !== host.owner.screenId ||
        host.owner.definition ||
        host.owner.mode !== "edit" ||
        host.owner.busy ||
        host.owner.replacing
      )
        return;
      void prepareImage(file, intent.generation, intent.owner, intent);
    });
  }
  function importBackground(file: File) {
    const generation = host.owner.generation,
      owner = host.owner.screenId;
    host.transition(() => {
      if (
        generation !== host.owner.generation ||
        owner !== host.owner.screenId ||
        host.owner.definition ||
        host.owner.busy ||
        host.owner.replacing ||
        host.owner.mode !== "edit"
      )
        return;
      void prepareImage(file, generation, owner);
    });
  }
  async function prepareImage(
    file: File,
    generation: number,
    owner: string,
    placement?: {
      bounds: Geometry;
      size: { width: number; height: number };
    },
    replacing?: {
      objectId: string;
      assetId: string;
      epoch: number;
      cropEpoch: number;
    },
  ) {
    const request = ++imageReadRequest,
      candidate = new AssetStore();
    const current = () =>
      request === imageReadRequest &&
      generation === host.owner.generation &&
      owner === host.owner.screenId &&
      !host.owner.definition &&
      !host.owner.busy &&
      !host.owner.replacing &&
      host.owner.mode === "edit" &&
      (!replacing ||
        (replacing.epoch === replacementImageEpoch &&
          replacing.cropEpoch === replacementCropEpoch &&
          host.selected?.id === replacing.objectId &&
          host.selected.shape.type === "image" &&
          host.selected.shape.assetId === replacing.assetId &&
          !host.selected.locked));
    imageBusy = true;
    try {
      const metadata = await candidate.put(file, file.name);
      if (!current()) {
        candidate.dispose();
        return;
      }
      const apply = () => {
        if (!current()) {
          candidate.dispose();
          return;
        }
        try {
          host.store.importFrom(candidate, metadata.sha256);
          const existing = host.assetByHash(metadata.sha256);
          const asset = existing ?? { ...metadata, id: newId() };
          if (replacing) {
            host.edit({
              type: "replace-image",
              screenId: owner,
              objectId: replacing.objectId,
              asset,
            });
            return;
          }
          if (placement) {
            const frame = initialImageFrame(
              metadata,
              placement.size,
              placement.bounds,
            );
            if (
              host.edit({ type: "add-image", screenId: owner, asset, frame })
            ) {
              host.stopPlacement();
              const placedId = host.selectedIds[0];
              void tick().then(() => {
                if (
                  current() &&
                  placedId &&
                  host.selectedIds.includes(placedId)
                )
                  host.revealObject(placedId);
              });
            }
            return;
          }
          const previous = host.background(owner);
          host.edit({
            type: "set-background-image",
            screenId: owner,
            asset,
            image: {
              assetId: asset.id,
              fit: previous?.fit ?? "contain",
              opacity: previous?.opacity ?? 1,
            },
          });
        } catch (error) {
          host.report(
            "error",
            `画像取込エラー: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          candidate.dispose();
          host.collectAssets();
        }
      };
      // A pending draft decision retains this candidate until apply runs.
      // Do not dispose it in the outer finally.
      host.allow(apply) && apply();
    } catch (error) {
      candidate.dispose();
      if (current())
        host.report(
          "error",
          `画像取込エラー: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (request === imageReadRequest) imageBusy = false;
    }
  }
  function removeBackground() {
    const owner = host.owner.screenId,
      generation = host.owner.generation;
    host.transition(() => {
      if (
        generation === host.owner.generation &&
        owner === host.owner.screenId &&
        !host.owner.definition
      )
        host.edit({
          type: "set-background-image",
          screenId: owner,
          image: null,
        });
    });
  }

  // Keep owner, selection and crop epochs separate; geometry alone is not a cancellation.
  const imageScope = $derived(
    `${host.owner.generation}:${host.owner.screenId}:${host.owner.mode}:${!!host.owner.definition}:${host.owner.busy}:${!!host.owner.replacing}`,
  );
  $effect(() => {
    imageScope;
    untrack(() => {
      placementIntent = null;
      imageReadRequest++;
      imageBusy = false;
    });
  });

  const replacementImageScope = $derived(
    `${host.owner.generation}:${host.owner.screenId}:${host.owner.mode}:${!!host.owner.definition}:${host.selectedIds.join(",")}:${host.selected?.shape.type}:${host.selected?.shape.type === "image" ? host.selected.shape.assetId : ""}:${!!host.selected?.locked}:${host.selected?.visible}`,
  );
  $effect(() => {
    replacementImageScope;
    untrack(() => {
      replacementImageEpoch++;
      replacementImageIntent = null;
    });
  });

  const replacementCropScope = $derived(
    host.selected?.shape.type === "image"
      ? JSON.stringify(host.selected.shape.crop ?? null)
      : "",
  );
  $effect(() => {
    replacementCropScope;
    untrack(() => {
      replacementCropEpoch++;
    });
  });

  return {
    get busy() {
      return imageBusy;
    },
    openReplacement: openImageReplacement,
    replaceFile: replaceImageFile,
    cancelReplacementChoice() {
      replacementImageIntent = null;
    },
    openPlacement: openImageFile,
    placeFile: placeImageFile,
    importBackground,
    removeBackground,
    prepare: prepareImage,
  };
}
