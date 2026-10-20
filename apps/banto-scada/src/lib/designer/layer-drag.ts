import { expandGroupSelection } from "../geometric-groups";
import type { LayerFolder, ScreenObject, GeometricGroup } from "../project";
import { folderAncestors, folderDestinations } from "./layer-tree";

export const LAYER_MIME = "application/x-banto-scada-layer-membership";
type Owner = {
  objects: ScreenObject[];
  folders: LayerFolder[];
  groups?: GeometricGroup[];
};
type DragSession = { token: string; scope: string; hidden: number };
export type LayerDrag = DragSession &
  (
    | { kind: "objects"; ids: string[] }
    | {
        kind: "folder";
        folderId: string;
        parentId: string;
        name: string;
        count: number;
      }
  );
export function folderDragSource(
  owner: Owner,
  id: string,
): Omit<Extract<LayerDrag, { kind: "folder" }>, "token" | "scope"> | null {
  const folder = owner.folders.find((folder) => folder.id === id);
  if (!folder) return null;
  const subtree = new Set(
    owner.folders
      .filter((item) =>
        folderAncestors(owner.folders, item.id).some(
          (ancestor) => ancestor.id === id,
        ),
      )
      .map((item) => item.id),
  );
  const objects = owner.objects.filter(
    (object) => object.folderId && subtree.has(object.folderId),
  );
  return {
    kind: "folder",
    folderId: id,
    parentId: folder.parentId ?? "",
    name: folder.name,
    count: objects.length,
    hidden: objects.filter((object) => object.visible === false).length,
  };
}

// IDs are captured at drag start. The DataTransfer carries only a session token.
export function layerDragSource(
  owner: Owner,
  source: string,
  selected: string[],
): string[] | null {
  const requested = selected.includes(source) ? [...selected] : [source];
  if (
    new Set(requested).size !== requested.length ||
    requested.some((id) => !owner.objects.some((object) => object.id === id))
  )
    return null;
  const ids = expandGroupSelection(owner, requested);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => {
      const object = owner.objects.find((object) => object.id === id);
      return !object || object.locked;
    })
  )
    return null;
  return ids;
}

/** Cheap source validation also runs on each autoscroll frame. */
export function layerDragError(
  owner: Owner,
  scope: string,
  drag: LayerDrag,
): string | null {
  if (drag.scope !== scope)
    return "編集対象が変わりました。もう一度ドラッグしてください。";
  if (drag.kind === "objects")
    return layerDragSource(owner, drag.ids[0], drag.ids)
      ? null
      : "配置が見つからないか、ロックされています。";
  const folder = owner.folders.find((folder) => folder.id === drag.folderId);
  if (!folder) return "移動するフォルダーが見つかりません。";
  return (folder.parentId ?? "") === drag.parentId
    ? null
    : "移動元の親が変わりました。もう一度ドラッグしてください。";
}
export function layerDropError(
  owner: Owner,
  scope: string,
  drag: LayerDrag,
  destination: string,
): string | null {
  const sourceError = layerDragError(owner, scope, drag);
  if (sourceError) return sourceError;
  if (destination && !owner.folders.some((folder) => folder.id === destination))
    return "移動先のフォルダーが見つかりません。";
  if (drag.kind === "folder" && destination) {
    const target = folderDestinations(owner.folders, drag.folderId).find(
      (item) => item.id === destination,
    );
    if (!target) return "自分自身または配下のフォルダーへは移動できません。";
    if (target.disabled) return "フォルダーの階層は16段までです。";
  }
  return null;
}

type DropOptions = {
  active: () => boolean;
  accepts: (event: DragEvent) => boolean;
  hover: (destination: string | null) => void;
  allowed: (destination: string) => boolean;
  drop: (event: DragEvent, destination: string) => void;
  end: () => void;
};

// Delegate only membership destinations; object rows never become insertion points.
export function layerDropSurface(node: HTMLElement, options: DropOptions) {
  const panel = node.closest<HTMLElement>('[role="tabpanel"]')!;
  let frame = 0,
    velocity = 0;
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    velocity = 0;
  }
  function scroll() {
    if (!options.active()) {
      stop();
      return;
    }
    panel.scrollTop += velocity;
    frame = requestAnimationFrame(scroll);
  }
  function over(event: DragEvent) {
    if (!options.accepts(event)) {
      options.hover(null);
      stop();
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-layer-drop-folder]")
        : null;
    const destination =
      target && node.contains(target) ? target.dataset.layerDropFolder! : null;
    options.hover(destination);
    if (destination !== null && options.allowed(destination)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    } else if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    const rect = panel.getBoundingClientRect();
    velocity =
      event.clientY < rect.top + 40
        ? -10
        : event.clientY > rect.bottom - 40
          ? 10
          : 0;
    if (velocity && !frame) frame = requestAnimationFrame(scroll);
    else if (!velocity) stop();
  }
  function leave(event: DragEvent) {
    if (
      !(event.relatedTarget instanceof Node) ||
      !node.contains(event.relatedTarget)
    ) {
      options.hover(null);
      stop();
    }
  }
  function drop(event: DragEvent) {
    stop();
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-layer-drop-folder]")
        : null;
    if (
      target &&
      node.contains(target) &&
      options.accepts(event) &&
      options.allowed(target.dataset.layerDropFolder!)
    ) {
      event.preventDefault();
      options.drop(event, target.dataset.layerDropFolder!);
    }
    options.hover(null);
  }
  function end() {
    stop();
    options.hover(null);
    options.end();
  }
  function escape(event: KeyboardEvent) {
    if (event.key === "Escape") end();
  }
  node.addEventListener("dragover", over);
  node.addEventListener("dragleave", leave);
  node.addEventListener("drop", drop);
  window.addEventListener("dragend", end);
  window.addEventListener("blur", end);
  window.addEventListener("keydown", escape, true);
  return {
    destroy() {
      stop();
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", escape, true);
    },
  };
}
