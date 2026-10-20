import { onMount, untrack } from "svelte";
import { hasVisibleLayerAbove } from "@banto/ui";
import {
  getSavedInspectorPlacement,
  saveInspectorPlacement,
} from "../../banto/setup";
import {
  initialInspectorPlacement,
  visibleInspectorRect,
  supportsFloatingInspector,
  adjustedInspectorRect,
  type InspectorPlacement,
  type FloatingPanelRect,
  type PanelViewport,
} from "../inspector-layout";
interface InspectorFrameHost {
  readonly viewport: PanelViewport;
  readonly element: HTMLElement | undefined;
  readonly visible: boolean;
  readonly blocked: boolean;
  beforePlacementChange(): void;
  cancelWorkspaceInteraction(): void;
  report(message: string): void;
}
type Gesture = {
  kind: "move" | "resize";
  pointer: number | null;
  target: HTMLElement;
  before: FloatingPanelRect;
  start: FloatingPanelRect;
  origin: { x: number; y: number };
  delta: { x: number; y: number };
  windowSize: { width: number; height: number };
};
const copy = (rect: FloatingPanelRect): FloatingPanelRect => ({ ...rect });
const same = (a: FloatingPanelRect, b: FloatingPanelRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
/** Position only: never moves, replaces, clones or applies the Inspector's form DOM. */
export function createFloatingInspector(host: InspectorFrameHost) {
  let saved = $state<InspectorPlacement | null>(
    untrack(getSavedInspectorPlacement),
  );
  const initial = untrack(
    () => saved ?? initialInspectorPlacement(host.viewport),
  );
  let mode = $state<"docked" | "floating">(initial.mode);
  let desired = $state<FloatingPanelRect>(copy(initial.rect));
  let saving = $state(false);
  let gesture = $state.raw<Gesture | null>(null);
  let announcement = $state("");
  const supported = $derived(supportsFloatingInspector(host.viewport));
  const rect = $derived(
    mode === "floating" && supported
      ? visibleInspectorRect(desired, host.viewport)
      : null,
  );
  function finish(commit: boolean) {
    const previous = gesture;
    if (!previous) return;
    gesture = null;
    if (!commit) desired = copy(previous.before);
    if (
      previous.pointer !== null &&
      previous.target.hasPointerCapture(previous.pointer)
    )
      previous.target.releasePointerCapture(previous.pointer);
    announcement = commit
      ? "プロパティの配置を確定しました"
      : "プロパティの配置変更を取り消しました";
  }
  $effect(() => {
    // Native resize cancels synchronously too; this covers mode, visibility and disconnected DOM.
    if (
      gesture &&
      (!rect || !host.visible || host.blocked || !host.element?.isConnected)
    )
      untrack(() => finish(false));
  });
  function start(
    kind: "move" | "resize",
    target: HTMLElement,
    pointer: number | null,
    origin: { x: number; y: number },
  ) {
    if (
      gesture ||
      !rect ||
      !host.visible ||
      !host.element?.isConnected ||
      host.blocked ||
      hasVisibleLayerAbove({ except: host.element })
    )
      return false;
    host.cancelWorkspaceInteraction();
    gesture = {
      kind,
      pointer,
      target,
      before: copy(desired),
      start: copy(rect),
      origin,
      delta: { x: 0, y: 0 },
      windowSize: { width: window.innerWidth, height: window.innerHeight },
    };
    if (pointer !== null) target.setPointerCapture(pointer);
    return true;
  }
  function update(dx: number, dy: number) {
    const current = gesture;
    if (!current) return;
    const next = adjustedInspectorRect(
      current.start,
      current.kind,
      dx,
      dy,
      host.viewport,
    );
    if (!next) {
      finish(false);
      return;
    }
    current.delta = { x: dx, y: dy };
    desired = copy(same(next, current.start) ? current.before : next);
    if (current.pointer === null)
      announcement = `X ${next.x}、Y ${next.y}、幅 ${next.width}、高さ ${next.height}`;
  }
  function pointerStart(kind: "move" | "resize", event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    if (
      start(kind, event.currentTarget as HTMLElement, event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
    ) {
      // Preserve the focused field and its IME/draft. Moving is not a numeric blur commit.
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function keyboardStart(kind: "move" | "resize", event: KeyboardEvent) {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      gesture
    )
      return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (start(kind, event.currentTarget as HTMLElement, null, { x: 0, y: 0 })) {
      event.preventDefault();
      event.stopPropagation();
      announcement =
        "矢印で調整、Enterで確定、Escapeで取消、Tabで確定して移動します";
    }
  }
  function setPlacement(value: InspectorPlacement) {
    if (host.blocked) return;
    finish(false);
    host.beforePlacementChange();
    mode = value.mode;
    desired = copy(value.rect);
  }
  function toggle() {
    if (mode === "floating")
      setPlacement({
        layoutVersion: 1,
        panelId: "inspector",
        mode: "docked",
        rect: copy(desired),
      });
    else if (supported)
      setPlacement({
        layoutVersion: 1,
        panelId: "inspector",
        mode: "floating",
        rect: copy(desired),
      });
  }
  function standard() {
    finish(false);
    host.beforePlacementChange();
    mode = "docked";
    desired = initialInspectorPlacement(host.viewport).rect;
  }
  function restore() {
    if (saved) setPlacement(saved);
  }
  async function save() {
    if (host.blocked || saving || gesture) return;
    const snapshot: InspectorPlacement = {
      layoutVersion: 1,
      panelId: "inspector",
      mode,
      rect: copy(desired),
    };
    saving = true;
    try {
      if (await saveInspectorPlacement(snapshot)) {
        saved = snapshot;
        host.report("プロパティの配置を保存しました。");
      }
    } finally {
      saving = false;
    }
  }
  onMount(() => {
    function activeGesture() {
      // The native viewport can change before its queued resize notification is delivered.
      // Never commit a drag based on the preceding window, even if pointerup wins that race.
      if (
        gesture &&
        (window.innerWidth !== gesture.windowSize.width ||
          window.innerHeight !== gesture.windowSize.height ||
          !host.visible ||
          host.blocked ||
          !host.element?.isConnected ||
          hasVisibleLayerAbove({ except: host.element }))
      )
        finish(false);
      return gesture;
    }
    const key = (event: KeyboardEvent) => {
      const current = activeGesture();
      if (
        !current ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        hasVisibleLayerAbove({ except: host.element })
      )
        return;
      if (event.key === "Tab" && current.pointer === null) {
        finish(true);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        finish(false);
        return;
      }
      if (current.pointer !== null) return;
      if (event.key === "Enter" || event.key === " ") {
        finish(true);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const step = event.shiftKey ? 32 : 8;
      const vector: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      const change = vector[event.key];
      if (change)
        update(current.delta.x + change.x, current.delta.y + change.y);
    };
    const move = (event: PointerEvent) => {
      if (activeGesture()?.pointer === event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        update(
          event.clientX - gesture!.origin.x,
          event.clientY - gesture!.origin.y,
        );
      }
    };
    const up = (event: PointerEvent) => {
      if (activeGesture()?.pointer === event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        update(
          event.clientX - gesture!.origin.x,
          event.clientY - gesture!.origin.y,
        );
        finish(true);
      }
    };
    const down = (event: PointerEvent) => {
      if (!activeGesture()) return;
      if (gesture!.pointer === null) {
        finish(true);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const lost = (event: PointerEvent) => {
      if (gesture?.pointer === event.pointerId) finish(false);
    };
    const cancel = () => finish(false);
    const block = (event: Event) => {
      if (!activeGesture()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("wheel", block, { capture: true, passive: false });
    window.addEventListener("contextmenu", block, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", lost, true);
    window.addEventListener("lostpointercapture", lost, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      finish(false);
      window.removeEventListener("wheel", block, true);
      window.removeEventListener("contextmenu", block, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", lost, true);
      window.removeEventListener("lostpointercapture", lost, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
    };
  });
  return {
    get floating() {
      return !!rect;
    },
    get preferredFloating() {
      return mode === "floating";
    },
    get supported() {
      return supported;
    },
    get rect() {
      return rect;
    },
    get gesturing() {
      return !!gesture;
    },
    get gestureKind() {
      return gesture?.kind ?? null;
    },
    get announcement() {
      return announcement;
    },
    get blocked() {
      return host.blocked;
    },
    get saving() {
      return saving;
    },
    get hasSaved() {
      return !!saved;
    },
    get style() {
      return rect
        ? `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`
        : undefined;
    },
    pointerStart,
    keyboardStart,
    toggle,
    standard,
    restore,
    save,
    cancel: () => finish(false),
  };
}
export type FloatingInspector = ReturnType<typeof createFloatingInspector>;
