import type { LayerFolder, ScreenObject } from "../project";

export const LAYER_MIME = "application/x-banto-scada-layer-membership";
type Owner = { objects: ScreenObject[]; folders: LayerFolder[] };
export type LayerDrag = {
  token: string;
  scope: string;
  ids: string[];
  hidden: number;
};

// IDs are captured at drag start. The DataTransfer carries only a session token.
export function layerDragSource(
  owner: Owner,
  source: string,
  selected: string[],
): string[] | null {
  const ids = selected.includes(source) ? [...selected] : [source];
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

export function layerDropError(
  owner: Owner,
  scope: string,
  drag: LayerDrag,
  destination: string,
): string | null {
  if (drag.scope !== scope)
    return "編集対象が変わりました。もう一度ドラッグしてください。";
  if (!layerDragSource(owner, drag.ids[0], drag.ids))
    return "配置が見つからないか、ロックされています。";
  if (destination && !owner.folders.some((folder) => folder.id === destination))
    return "移動先のフォルダーが見つかりません。";
  return null;
}

type DropOptions = {
  active: () => boolean;
  accepts: (event: DragEvent) => boolean;
  hover: (destination: string | null) => void;
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
    if (destination !== null) {
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
    if (target && node.contains(target) && options.accepts(event)) {
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
