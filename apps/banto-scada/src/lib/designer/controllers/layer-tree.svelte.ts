import { tick, untrack } from "svelte";
import { layerTree, folderAncestors, folderPath } from "../layer-tree";
import {
  LAYER_MIME,
  layerDragSource,
  folderDragSource,
  layerDropError,
  layerDragError,
  type LayerDrag,
} from "../layer-drag";
import type { FolderRequest, FolderOperation } from "../FolderDialog.svelte";
import type {
  Screen,
  SymbolDefinition,
  ScreenObject,
  Point,
} from "../../project";
import type { EditCommand } from "../../editor";
import { placementLabel } from "../../placement-label";

interface LayerOwner {
  generation: number;
  mode: "edit" | "preview";
  editBlocked: boolean;
  menuBlocked: boolean;
  mutationBlocked: boolean;
}
export interface LayerTreeHost {
  readonly owner: LayerOwner;
  readonly dragContext: {
    mode: "edit" | "preview";
    activePanel: string;
    showSidebar: boolean;
  };
  readonly screen: Screen | SymbolDefinition;
  readonly symbols: SymbolDefinition[];
  readonly selectedIds: string[];
  readonly hiddenSelectionCount: number;
  objectLabel(object: ScreenObject): string;
  selectObjects(id: string, additive: boolean): void;
  transition(run: () => void): void;
  edit(command: EditCommand, onerror?: (message: string) => void): boolean;
  report(kind: "error" | "success", text: string): void;
  layerContext(id: string, origin: HTMLElement): void;
  layerContextKey(event: KeyboardEvent, id: string): void;
  toggleObjectVisibility(id: string): void;
  toggleObjectLock(id: string): void;
}

/** Own layer browsing and folder interaction state; selection/history stay in App. */
export function createLayerTreeController(host: LayerTreeHost) {
  let layerQuery = $state("");
  let layersExpanded = $state(true);
  const folderScope = $derived(`${host.owner.generation}:${host.screen.id}`);
  let closedLayerFolders = $state<Record<string, string[]>>({});
  const closedFolders = $derived(
    new Set(closedLayerFolders[folderScope] ?? []),
  );
  const layerTreeView = $derived(
    layerTree(host.screen, layerQuery, closedFolders, layerSearchText),
  );
  const visibleLayers = $derived(layerTreeView.matchingObjects);
  function layerSearchText(object: ScreenObject) {
    return [
      host.objectLabel(object),
      placementLabel({ ...object, name: undefined }, host.symbols),
      object.shape.type,
      object.id,
      ...(object.shape.type === "text"
        ? [object.shape.text, object.shape.binding?.externalName ?? ""]
        : []),
    ].join(" ");
  }
  function revealLayerObject(id: string) {
    if (!visibleLayers.some((object) => object.id === id)) return;
    layersExpanded = true;
    if (host.screen.folders.length)
      revealFolder(
        host.screen.objects.find((object) => object.id === id)?.folderId,
      );
  }
  function toggleFolder(id: string) {
    if (layerQuery.trim()) return;
    const next = new Set(closedFolders);
    if (!next.delete(id)) next.add(id);
    closedLayerFolders = { ...closedLayerFolders, [folderScope]: [...next] };
  }
  function revealFolder(id?: string) {
    const ancestors = new Set(
      folderAncestors(host.screen.folders, id).map((folder) => folder.id),
    );
    closedLayerFolders = {
      ...closedLayerFolders,
      [folderScope]: [...closedFolders].filter((id) => !ancestors.has(id)),
    };
  }
  let lastFolderReveal = "";
  $effect(() => {
    const ancestors = host.selectedIds.flatMap((id) =>
      folderAncestors(
        host.screen.folders,
        host.screen.objects.find((object) => object.id === id)?.folderId,
      ).map((folder) => folder.id),
    );
    const key = `${folderScope}:${host.selectedIds.join(",")}:${ancestors.join(",")}`;
    if (key === lastFolderReveal) return;
    lastFolderReveal = key;
    untrack(() => {
      if (
        !ancestors.length ||
        !host.selectedIds.some((id) =>
          visibleLayers.some((object) => object.id === id),
        )
      )
        return;
      closedLayerFolders = {
        ...closedLayerFolders,
        [folderScope]: [...closedFolders].filter(
          (id) => !ancestors.includes(id),
        ),
      };
    });
  });
  let layerDrag = $state<LayerDrag | null>(null);
  let layerDragGuide = $state<LayerDrag | null>(null);
  let layerDropTarget = $state<string | null>(null);
  const layerDropTargetError = $derived(
    layerDragGuide && layerDropTarget !== null
      ? layerDropError(
          host.screen,
          folderScope,
          layerDragGuide,
          layerDropTarget,
        )
      : null,
  );
  const layerDragDescription = $derived.by(() => {
    const drag = layerDragGuide;
    if (!drag) return "";
    const source =
      drag.kind === "objects"
        ? `${drag.ids.length} 件を移動（非表示 ${drag.hidden} 件）`
        : `フォルダー「${drag.name}」と配下を移動（配置 ${drag.count} 件・非表示 ${drag.hidden} 件）`;
    const destination =
      layerDropTargetError ??
      (layerDropTarget === null
        ? "フォルダーへドロップ"
        : layerDropTarget
          ? `${folderPath(host.screen.folders, layerDropTarget)} 直下へ`
          : drag.kind === "folder"
            ? "ルートへ移動"
            : "フォルダーから外す");
    return `${source} · ${destination}`;
  });
  let layerDragClickUntil = 0;
  function endLayerDrag() {
    if (layerDrag) layerDragClickUntil = performance.now() + 300;
    layerDrag = null;
    layerDragGuide = null;
    layerDropTarget = null;
  }
  $effect(() => {
    folderScope;
    host.dragContext.mode;
    host.dragContext.activePanel;
    host.dragContext.showSidebar;
    untrack(endLayerDrag);
  });
  function beginLayerDrag(event: DragEvent, id: string) {
    const ids = layerDragSource(host.screen, id, host.selectedIds);
    if (host.owner.editBlocked || !ids || !event.dataTransfer) {
      event.preventDefault();
      if (!ids)
        host.report(
          "error",
          "ロックを含む配置はドラッグで所属を変更できません。",
        );
      return;
    }
    layerDrag = {
      kind: "objects",
      token: crypto.randomUUID(),
      scope: folderScope,
      ids,
      hidden: ids.filter(
        (id) =>
          host.screen.objects.find((object) => object.id === id)?.visible ===
          false,
      ).length,
    };
    layerDragClickUntil = performance.now() + 300;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(LAYER_MIME, layerDrag.token);
  }
  function beginFolderDrag(event: DragEvent, id: string) {
    const source = folderDragSource(host.screen, id);
    if (host.owner.editBlocked || !source || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    layerDrag = { ...source, token: crypto.randomUUID(), scope: folderScope };
    layerDragClickUntil = performance.now() + 300;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(LAYER_MIME, layerDrag.token);
  }
  function acceptsLayerDrag(event: DragEvent) {
    return !!(
      layerDrag &&
      !host.owner.editBlocked &&
      layerDrag.scope === folderScope &&
      event.dataTransfer?.types.includes(LAYER_MIME) &&
      !layerDragError(host.screen, folderScope, layerDrag)
    );
  }
  function dropLayer(event: DragEvent, destination: string) {
    const drag = layerDrag;
    if (!drag || event.dataTransfer?.getData(LAYER_MIME) !== drag.token) return;
    endLayerDrag();
    // Snapshot survives native dragend and the draft prompt; never retarget it.
    host.transition(() => {
      const error = layerDropError(host.screen, folderScope, drag, destination);
      if (host.owner.mode !== "edit" || error) {
        host.report("error", error ?? "編集モードでやり直してください。");
        return;
      }
      if (
        !host.edit(
          drag.kind === "objects"
            ? {
                type: "set-folder",
                screenId: host.screen.id,
                objectIds: drag.ids,
                folderId: destination || null,
              }
            : {
                type: "move-folder",
                screenId: host.screen.id,
                folderId: drag.folderId,
                parentId: destination || null,
              },
        )
      )
        return;
      layersExpanded = true;
      if (!layerQuery.trim()) revealFolder(destination || undefined);
      void tick().then(() => {
        if (drag.scope !== folderScope) return;
        const visible = document.querySelector<HTMLElement>(
          drag.kind === "objects"
            ? `button[data-layer-id="${drag.ids[0]}"]`
            : `button[data-layer-folder="${drag.folderId}"][aria-expanded]`,
        );
        if (visible?.getClientRects().length)
          visible.scrollIntoView({ block: "nearest" });
        else
          host.report(
            "success",
            drag.kind === "objects"
              ? "所属を変更しました。検索条件外の配置は検索を解除すると確認できます。"
              : "親フォルダーを変更しました。検索条件外のフォルダーは検索を解除すると確認できます。",
          );
      });
    });
  }
  function layerClick(event: MouseEvent, id: string) {
    if (event.detail && performance.now() < layerDragClickUntil) return;
    host.selectObjects(id, event.shiftKey || event.ctrlKey || event.metaKey);
  }
  let folderRequest = $state<
    (FolderRequest & { scope: string; origin: HTMLElement | null }) | null
  >(null);
  let folderMenu = $state<{
    show: (origin: HTMLElement, point?: Point) => Promise<void>;
  }>();
  let contextFolderId = $state("");
  let folderOrigin: HTMLElement | null = null;
  let folderMenuRequest = 0;
  function openFolderRequest(
    kind: FolderOperation,
    folderId?: string,
    origin?: HTMLElement,
  ) {
    if (
      host.owner.editBlocked ||
      (kind === "assign" && host.owner.mutationBlocked)
    )
      return;
    const scope = folderScope,
      ids = [...host.selectedIds];
    const source =
      origin ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    host.transition(() => {
      if (
        scope !== folderScope ||
        host.owner.mode !== "edit" ||
        (folderId &&
          !host.screen.folders.some((folder) => folder.id === folderId)) ||
        (kind === "assign" &&
          (!ids.length ||
            ids.some(
              (id) => !host.screen.objects.some((object) => object.id === id),
            )))
      )
        return;
      folderRequest = {
        kind,
        folderId,
        objectIds: kind === "assign" ? ids : [],
        scope,
        origin: source,
      };
    });
  }
  function closeFolderRequest() {
    const previous = folderRequest;
    folderRequest = null;
    void tick().then(() => {
      if (previous?.scope !== folderScope) return;
      if (
        previous.origin?.isConnected &&
        previous.origin.getClientRects().length
      )
        previous.origin.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLButtonElement>("[data-create-layer-folder]")
          ?.focus({ preventScroll: true });
    });
  }
  $effect(() => {
    if (
      folderRequest &&
      (folderRequest.scope !== folderScope || host.owner.mode !== "edit")
    )
      folderRequest = null;
  });
  function applyFolderCommand(command: EditCommand): string | null {
    const request = folderRequest;
    if (!request || request.scope !== folderScope || host.owner.mode !== "edit")
      return "編集対象が変わりました。閉じてやり直してください。";
    const before = new Set(host.screen.folders.map((folder) => folder.id));
    let error = "";
    if (!host.edit(command, (message) => (error = message)))
      return error || "変更できませんでした。対象と入力を確認してください。";
    const destination =
      command.type === "create-folder"
        ? host.screen.folders.find((folder) => !before.has(folder.id))?.id
        : command.type === "set-folder"
          ? (command.folderId ?? undefined)
          : request.folderId;
    if (!layerQuery.trim()) revealFolder(destination);
    closeFolderRequest();
    return null;
  }
  function showFolderMenu(id: string, origin: HTMLElement) {
    if (host.owner.menuBlocked) return;
    contextFolderId = id;
    folderOrigin = origin;
    const request = ++folderMenuRequest,
      scope = folderScope;
    void tick().then(() => {
      if (
        request === folderMenuRequest &&
        scope === folderScope &&
        host.owner.mode === "edit" &&
        !host.owner.menuBlocked &&
        host.screen.folders.some((folder) => folder.id === id)
      )
        void folderMenu?.show(origin);
    });
  }
  function folderKey(event: KeyboardEvent, id: string) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      showFolderMenu(id, event.currentTarget as HTMLElement);
    }
  }

  return {
    get screen() {
      return host.screen;
    },
    get symbols() {
      return host.symbols;
    },
    get selectedIds() {
      return host.selectedIds;
    },
    get hiddenSelectionCount() {
      return host.hiddenSelectionCount;
    },
    get editBlocked() {
      return host.owner.editBlocked;
    },
    get menuBlocked() {
      return host.owner.menuBlocked;
    },
    get folderScope() {
      return folderScope;
    },
    get layerQuery() {
      return layerQuery;
    },
    set layerQuery(value) {
      layerQuery = value;
    },
    get layersExpanded() {
      return layersExpanded;
    },
    set layersExpanded(value) {
      layersExpanded = value;
    },
    get layerDrag() {
      return layerDrag;
    },
    get layerDragGuide() {
      return layerDragGuide;
    },
    get layerDropTarget() {
      return layerDropTarget;
    },
    get layerDropTargetError() {
      return layerDropTargetError;
    },
    get layerDragDescription() {
      return layerDragDescription;
    },
    get layerTreeView() {
      return layerTreeView;
    },
    get visibleLayers() {
      return visibleLayers;
    },
    get layerDragClickUntil() {
      return layerDragClickUntil;
    },
    get folderRequest() {
      return folderRequest;
    },
    get contextFolderId() {
      return contextFolderId;
    },
    get folderOrigin() {
      return folderOrigin;
    },
    get folderMenu() {
      return folderMenu;
    },
    set folderMenu(value: typeof folderMenu) {
      folderMenu = value;
    },
    hoverLayerDrop(target: string | null) {
      layerDropTarget = target;
      layerDragGuide = layerDrag;
    },
    acceptsLayerDrag,
    dropLayer,
    endLayerDrag,
    openFolderRequest,
    toggleFolder,
    showFolderMenu,
    folderKey,
    beginFolderDrag,
    beginLayerDrag,
    layerClick,
    closeFolderRequest,
    applyFolderCommand,
    revealLayerObject,
    objectLabel: host.objectLabel,
    layerContext: host.layerContext,
    layerContextKey: host.layerContextKey,
    toggleObjectVisibility: host.toggleObjectVisibility,
    toggleObjectLock: host.toggleObjectLock,
    resetPresentation() {
      layerQuery = "";
      layersExpanded = true;
    },
  };
}
