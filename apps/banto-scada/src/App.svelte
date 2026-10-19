<script lang="ts">
  import {
    StatusBadge,
    ToastHost,
    Modal,
    Menu,
    MenuGroup,
    MenuItem,
  } from "@banto/ui";
  import { notify, type NotificationKind } from "@banto/admin-core";
  import {
    getThemeMode,
    getPanelWidths,
    getReferenceHeight,
    setReferenceHeight,
    setPanelWidths,
    setThemeMode,
    getRulersVisible,
    setRulersVisible,
    getMinimapVisible,
    setMinimapVisible,
    getMenubarVisible,
    setMenubarVisible,
    resetDesignerLayoutPreferences,
    toastStore,
  } from "./lib/banto/setup";
  import DesignerMenubar, {
    type DesignerMenu,
  } from "./lib/designer/DesignerMenubar.svelte";
  import { settleMenuFocus } from "./lib/designer/settle-menu-focus";
  let theme = $state(getThemeMode());
  let showRulers = $state(getRulersVisible());
  function toggleRulers() {
    canvasWorkspace?.preparePanelResize();
    showRulers = !showRulers;
    void setRulersVisible(showRulers);
  }
  let showMinimap = $state(getMinimapVisible());
  function toggleMinimap() {
    canvasWorkspace?.preparePanelResize();
    showMinimap = !showMinimap;
    void setMinimapVisible(showMinimap);
  }
  let showMenubar = $state(getMenubarVisible());
  let projectFileInput = $state<HTMLInputElement>();
  let helpOpen = $state(false);
  function toggleMenubar() {
    showMenubar = !showMenubar;
    void setMenubarVisible(showMenubar);
    if (!showMenubar)
      void tick().then(() =>
        document
          .querySelector<HTMLButtonElement>("[data-permanent-menu]")
          ?.focus(),
      );
  }
  function chooseTheme(value: "light" | "dark" | "system") {
    theme = value;
    void setThemeMode(value);
  }
  import { untrack, tick, flushSync } from "svelte";
  import { selectionNudge } from "./lib/keyboard-move";
  import { copyObjects, parseClipboard } from "./lib/clipboard";
  import { normalizeRotation } from "./lib/rotation";
  import { parseNumericProperty } from "./lib/designer/numeric-properties";
  import { placementLabel } from "./lib/placement-label";
  import { createProject } from "./lib/new-project";
  import { parseLineStyle } from "./lib/line-style";
  import { projectContent } from "./lib/save-state";
  import { createDraftGuard } from "./lib/designer/drafts.svelte";
  import DraftPrompt from "./lib/designer/DraftPrompt.svelte";
  import BindingReferences from "./lib/designer/BindingReferences.svelte";
  import {
    bindingReferences,
    type BindingUsage,
  } from "./lib/binding-references";
  import ContextActions, {
    type ContextAction,
  } from "./lib/designer/ContextActions.svelte";
  import type { SymbolUsage } from "./lib/symbol-usages";
  import { selectionTarget } from "./lib/selection-view";
  import type { Project } from "./lib/project";
  import {
    layerTree,
    folderAncestors,
    folderPath,
  } from "./lib/designer/layer-tree";
  import {
    LAYER_MIME,
    layerDragSource,
    folderDragSource,
    layerDropError,
    layerDragError,
    layerDropSurface,
    type LayerDrag,
  } from "./lib/designer/layer-drag";
  import FolderDialog, {
    type FolderRequest,
    type FolderOperation,
  } from "./lib/designer/FolderDialog.svelte";
  import sample from "../../../examples/minimal.project.json";
  import processSample from "../../../examples/process.project.json";
  import shapePaintSample from "../../../examples/shape-paint.project.json";
  import symbolColorSample from "../../../examples/symbol-color.project.json";
  import CanvasWorkspace, {
    type CanvasView,
    type CanvasContext,
  } from "./lib/designer/CanvasWorkspace.svelte";
  import Minimap from "./lib/designer/Minimap.svelte";
  import ScreenTabs from "./lib/designer/ScreenTabs.svelte";
  import CanvasControls from "./lib/designer/CanvasControls.svelte";
  import TreeSection from "./lib/designer/TreeSection.svelte";
  import ObjectIcon from "./lib/designer/ObjectIcon.svelte";
  let layerQuery = $state("");
  let layersExpanded = $state(true);
  import DesignerSidebar, {
    type DesignerPanel,
  } from "./lib/designer/DesignerSidebar.svelte";
  let activePanel = $state<DesignerPanel>("project");
  function expandTreeAncestors(element: Element) {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  function revealDraftForm(form: HTMLFormElement) {
    expandTreeAncestors(form);
    if (["screen", "project"].includes(form.dataset.editorForm ?? "")) {
      setAuxPanelVisibility({ sidebar: true });
      activePanel = "project";
    } else setInspectorVisibility(true);
  }
  import EditToolbar, {
    type ToolbarGroup,
  } from "./lib/designer/EditToolbar.svelte";
  import {
    DEFAULT_REFERENCE_HEIGHT,
    MIN_REFERENCE_HEIGHT,
    referenceHeightMaximum,
  } from "./lib/designer/panel-height";
  import PanelResizeHandle from "./lib/designer/PanelResizeHandle.svelte";
  import { DEFAULT_PANEL_LAYOUT } from "./lib/designer/panel-layout";
  import {
    DEFAULT_PANEL_WIDTHS,
    PANEL_WIDTH_LIMITS,
    panelWidthMaximum,
    type PanelWidths,
  } from "./lib/designer/panel-widths";
  let windowWidth = $state(window.innerWidth);
  let panelWidths = $state(getPanelWidths());
  const leftWidth = $derived(
    Math.min(panelWidths.left, panelWidthMaximum("left", windowWidth)),
  );
  const rightWidth = $derived(
    Math.min(panelWidths.right, panelWidthMaximum("right", windowWidth)),
  );
  let initialPanelWidths: PanelWidths | null = null;
  function beginPanelResize() {
    initialPanelWidths ??= { ...panelWidths };
    canvasWorkspace?.preparePanelResize(true);
  }
  function finishPanelResize(commit: boolean) {
    if (!commit && initialPanelWidths) panelWidths = initialPanelWidths;
    initialPanelWidths = null;
    canvasWorkspace?.finishPanelResize();
    if (commit) void setPanelWidths(panelWidths);
  }
  function changePanelWidth(side: keyof PanelWidths, width: number) {
    panelWidths = { ...panelWidths, [side]: width };
  }
  function resetPanelWidths() {
    beginPanelResize();
    panelWidths = { ...DEFAULT_PANEL_WIDTHS };
    finishPanelResize(true);
  }
  let canvasStackHeight = $state(0);
  let referenceHeight = $state(getReferenceHeight());
  let referencesExpanded = $state(false);
  const canSizeReferences = $derived(
    windowWidth >= 1100 && canvasStackHeight >= 500,
  );
  const referenceMaximum = $derived(referenceHeightMaximum(canvasStackHeight));
  const displayedReferenceHeight = $derived(
    Math.min(referenceHeight, referenceMaximum),
  );
  let initialReferenceHeight: number | null = null;
  function beginReferenceResize() {
    initialReferenceHeight ??= referenceHeight;
    canvasWorkspace?.preparePanelResize(true);
  }
  function finishReferenceResize(commit: boolean) {
    if (!commit && initialReferenceHeight !== null)
      referenceHeight = initialReferenceHeight;
    initialReferenceHeight = null;
    canvasWorkspace?.finishPanelResize();
    if (commit) void setReferenceHeight(referenceHeight);
  }
  function resetReferenceHeight() {
    beginReferenceResize();
    referenceHeight = DEFAULT_REFERENCE_HEIGHT;
    finishReferenceResize(true);
  }
  import type {
    NumericProperty,
    NumericTarget,
  } from "./lib/designer/numeric-properties";
  import InspectorPanel from "./lib/designer/InspectorPanel.svelte";
  let showInspector = $state(DEFAULT_PANEL_LAYOUT.panels.inspector);
  let showSidebar = $state(DEFAULT_PANEL_LAYOUT.panels.sidebar);
  let showReferences = $state(DEFAULT_PANEL_LAYOUT.panels.references);
  let leftResizer = $state<{ cancel: () => void }>();
  let rightResizer = $state<{ cancel: () => void }>();
  let bottomResizer = $state<{ cancel: () => void }>();
  function restorePanelLayout() {
    if (mode !== "edit" || busy || drafts.pending || replacement) return;
    leftResizer?.cancel();
    rightResizer?.cancel();
    bottomResizer?.cancel();
    canvasWorkspace?.preparePanelResize();
    panelWidths = { ...DEFAULT_PANEL_LAYOUT.widths };
    referenceHeight = DEFAULT_PANEL_LAYOUT.referenceHeight;
    showSidebar = DEFAULT_PANEL_LAYOUT.panels.sidebar;
    showInspector = DEFAULT_PANEL_LAYOUT.panels.inspector;
    showReferences = DEFAULT_PANEL_LAYOUT.panels.references;
    showMenubar = DEFAULT_PANEL_LAYOUT.menubar;
    showMinimap = DEFAULT_PANEL_LAYOUT.minimap;
    showRulers = DEFAULT_PANEL_LAYOUT.rulers;
    previousPanels = null;
    void resetDesignerLayoutPreferences();
    report("success", "パネルの表示とサイズを標準に戻しました。");
    void tick().then(() =>
      document
        .querySelector<HTMLButtonElement>("[data-permanent-menu]")
        ?.focus({ preventScroll: true }),
    );
  }
  type AuxVisibility = {
    sidebar: boolean;
    inspector: boolean;
    references: boolean;
  };
  let previousPanels = $state<AuxVisibility | null>(null);
  let sidebarPanel = $state<HTMLElement>();
  let referencesPanel = $state<HTMLDivElement>();
  function panelVisibility(): AuxVisibility {
    return {
      sidebar: showSidebar,
      inspector: showInspector,
      references: showReferences,
    };
  }
  function setAuxPanelVisibility(
    patch: Partial<AuxVisibility>,
    focus?: keyof AuxVisibility,
  ) {
    canvasWorkspace?.preparePanelResize();
    previousPanels = null;
    if (patch.sidebar !== undefined) showSidebar = patch.sidebar;
    if (patch.inspector !== undefined) showInspector = patch.inspector;
    if (patch.references !== undefined) showReferences = patch.references;
    if (focus)
      void tick().then(() => {
        const visible = panelVisibility()[focus];
        const panel =
          focus === "sidebar"
            ? sidebarPanel
            : focus === "inspector"
              ? inspectorPanel
              : referencesPanel;
        if (visible) panel?.focus({ preventScroll: true });
        else
          document
            .querySelector<HTMLButtonElement>("[data-permanent-menu]")
            ?.focus();
      });
  }
  function setInspectorVisibility(visible: boolean, focus = false) {
    if (showInspector === visible) {
      if (visible && focus)
        void tick().then(() => inspectorPanel?.focus({ preventScroll: true }));
      return;
    }
    setAuxPanelVisibility(
      { inspector: visible },
      focus ? "inspector" : undefined,
    );
  }
  function toggleAuxPanels() {
    const current = panelVisibility();
    const restore = previousPanels;
    if (restore) setAuxPanelVisibility(restore);
    else if (Object.values(current).some(Boolean)) {
      setAuxPanelVisibility({
        sidebar: false,
        inspector: false,
        references: false,
      });
      previousPanels = current;
    } else
      setAuxPanelVisibility({
        sidebar: true,
        inspector: true,
        references: true,
      });
    void tick().then(() =>
      document
        .querySelector<HTMLButtonElement>("[data-permanent-menu]")
        ?.focus(),
    );
  }
  import FavoritesDock from "./lib/designer/FavoritesDock.svelte";
  import {
    availableFavorites,
    favoriteKey,
    FAVORITES_LIMIT,
    DEFAULT_FAVORITES,
  } from "./lib/designer/favorites";
  import { getFavorites, setFavorites } from "./lib/banto/setup";
  let favoriteKeys = $state(getFavorites());
  function isFavorite(part: PalettePart) {
    return favoriteKeys.includes(favoriteKey(part, project.manifest.projectId));
  }
  function toggleFavorite(part: PalettePart) {
    const key = favoriteKey(part, project.manifest.projectId);
    if (favoriteKeys.includes(key))
      favoriteKeys = favoriteKeys.filter((item) => item !== key);
    else {
      if (favoriteKeys.length >= FAVORITES_LIMIT) {
        report(
          "warning",
          "お気に入りは64件までです。使わない部品を外してから登録してください。",
        );
        return;
      }
      favoriteKeys = [...favoriteKeys, key];
    }
    void setFavorites(favoriteKeys);
  }
  function resetFavorites() {
    favoriteKeys = [...DEFAULT_FAVORITES];
    void setFavorites(favoriteKeys);
  }
  let positionPlacement = $state(false);
  let armedPart = $state<PalettePart | null>(null);
  let placementTicket = 0;
  function stopPlacement(focus = false) {
    positionPlacement = false;
    armedPart = null;
    placementTicket++;
    if (focus)
      editorRegion
        ?.querySelector<HTMLElement>('[aria-label="キャンバス操作領域"]')
        ?.focus({ preventScroll: true });
  }
  function togglePlacement() {
    if (positionPlacement) stopPlacement();
    else {
      positionPlacement = true;
      canvasWorkspace?.setHand(false);
    }
  }
  function armPart(part: PalettePart) {
    if (
      mode !== "edit" ||
      busy ||
      drafts.pending ||
      replacement ||
      (activeDefinition && part.type !== "basic")
    )
      return;
    if (
      part.type === "symbol" &&
      !project.symbols.some((definition) => definition.id === part.symbolId)
    )
      return;
    placementTicket++;
    positionPlacement = true;
    armedPart = part;
    canvasWorkspace?.setHand(false);
    const ticket = placementTicket;
    void tick().then(() => {
      if (!(
        document.activeElement instanceof Element &&
        document.activeElement.closest(
          "input,textarea,select,[contenteditable]",
        )
      ))
        focusPlacement(ticket);
    });
  }
  function focusPlacement(ticket: number) {
    if (
      mode === "edit" &&
      positionPlacement &&
      ticket === placementTicket &&
      !busy &&
      !drafts.pending &&
      !replacement
    )
      editorRegion
        ?.querySelector<HTMLElement>('[aria-label="キャンバス操作領域"]')
        ?.focus({ preventScroll: true });
  }
  function isArmed(part: PalettePart) {
    return (
      !!armedPart &&
      favoriteKey(part, project.manifest.projectId) ===
        favoriteKey(armedPart, project.manifest.projectId)
    );
  }
  function choosePart(part: PalettePart) {
    if (positionPlacement) armPart(part);
    else placeFavorite(part);
  }
  function placeArmed(center: Point) {
    if (!positionPlacement || !armedPart) return;
    const ticket = placementTicket;
    const token = startPaletteDrag(armedPart);
    if (token)
      dropPalettePart(
        token,
        center,
        () => positionPlacement && ticket === placementTicket,
        () => focusPlacement(ticket),
      );
  }
  function beginPartDrag(part: PalettePart) {
    stopPlacement();
    return startPaletteDrag(part);
  }
  function placeFavorite(part: PalettePart) {
    const center = canvasWorkspace?.visibleCenter();
    const token = center && startPaletteDrag(part);
    if (token && center) dropPalettePart(token, center);
  }
  function browseParts() {
    setAuxPanelVisibility({ sidebar: true }, "sidebar");
    activePanel = "parts";
  }
  import PartPalette from "./lib/designer/PartPalette.svelte";
  import type { PalettePart } from "./lib/designer/palette-drag";
  let paletteDrag: {
    token: string;
    part: PalettePart;
    generation: number;
    target: string;
  } | null = null;
  function startPaletteDrag(part: PalettePart): string | null {
    if (
      mode !== "edit" ||
      busy ||
      drafts.pending ||
      replacement ||
      (activeDefinition && part.type !== "basic")
    )
      return null;
    const token = crypto.randomUUID();
    paletteDrag = {
      token,
      part,
      generation: workspaceGeneration,
      target: screen.id,
    };
    return token;
  }
  function canDropPart(): boolean {
    return (
      mode === "edit" &&
      !busy &&
      !drafts.pending &&
      !replacement &&
      !!paletteDrag &&
      paletteDrag.generation === workspaceGeneration &&
      paletteDrag.target === screen.id
    );
  }
  $effect(() => {
    mode;
    screen.id;
    workspaceGeneration;
    paletteDrag = null;
  });
  function dropPalettePart(
    token: string,
    center: Point,
    valid: () => boolean = () => true,
    onplaced?: () => void,
  ) {
    const drag = paletteDrag;
    if (!drag || drag.token !== token || !canDropPart()) return;
    paletteDrag = null;
    // Capture the target and point before the draft prompt; never retarget a deferred drop.
    transition(() => {
      if (!valid()) return;
      if (
        mode !== "edit" ||
        drag.generation !== workspaceGeneration ||
        drag.target !== screen.id
      ) {
        report(
          "error",
          "配置先が変わったため、部品をもう一度配置してください。",
        );
        return;
      }
      const part = drag.part;
      if (activeDefinition && part.type !== "basic") return;
      let committed: boolean;
      if (part.type === "basic")
        committed = edit({
          type: "add",
          screenId: screen.id,
          kind: part.kind,
          center,
        });
      else if (part.type === "builtin")
        committed = edit({
          type: "add-symbol",
          screenId: screen.id,
          template: part.template,
          center,
        });
      else
        committed = edit({
          type: "place-symbol",
          screenId: screen.id,
          symbolId: part.symbolId,
          center,
        });
      if (committed) onplaced?.();
    });
  }
  import SymbolLibrary from "./lib/designer/SymbolLibrary.svelte";
  import {
    parseProject,
    strokeOverflowIds,
    serializeProject,
    parsePoints,
    type Point,
    type ScreenObject,
  } from "./lib/project";
  import {
    type EditCommand,
    applyCommand,
    isObjectCommand,
    symbolUsage,
    type AddKind,
    type ObjectPatch,
  } from "./lib/editor";
  import {
    emptyHistory,
    recordEdit,
    travelHistory,
    type EditHistory,
  } from "./lib/history";
  const drafts = createDraftGuard(
    (text) => report("error", text),
    validateDrafts,
    revealDraftForm,
    () => {
      let ready = true;
      flushSync(() => {
        ready = inspectorController?.commitFocusedNumber() ?? true;
      });
      return ready;
    },
  );
  function transition(action: () => void) {
    if (drafts.allow(action)) action();
  }
  let history = $state<EditHistory>(emptyHistory());
  let workspaceGeneration = $state(0);
  let canvasWorkspace = $state<{
    centerOn: (point: Point) => void;
    visibleCenter: () => Point;
    revealObject: (id: string) => void;
    preparePanelResize: (continuous?: boolean) => void;
    finishPanelResize: () => void;
    showSelection: () => boolean;
    zoom: (value: number | null) => void;
    stepZoom: (direction: number) => void;
    setHand: (value: boolean) => void;
  }>();
  let canvasView = $state<CanvasView>({
    hand: false,
    zoom: null,
    scale: 1,
    fit: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  });
  let showGrid = $state(false),
    snapEnabled = $state(false),
    gridSize = $state(10);
  function travel(direction: "undo" | "redo") {
    if (!drafts.allow(() => travel(direction))) return;
    try {
      const result = travelHistory(project, history, direction, mode);
      if (result.project === project) return;
      project = result.project;
      history = result.history;
      if (!project.screens.some((s) => s.id === screenId))
        screenId = project.screens[0].id;
      normalizeTargets();
      selectedIds = selectedIds.filter((id) =>
        screen.objects.some((o) => o.id === id),
      );
      report(
        "info",
        direction === "undo" ? "元に戻しました。" : "やり直しました。",
      );
    } catch (e) {
      report(
        "error",
        `履歴エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function showSelection() {
    if (selectionViewReason) return;
    try {
      if (!canvasWorkspace?.showSelection()) return;
      const { clippedCount, outsideCount } = selectionViewTarget;
      if (clippedCount || outsideCount)
        report(
          "info",
          `画面外の部分は表示していません。完全に画面外の配置 ${outsideCount} 件。選択は保持しています。`,
        );
    } catch (error) {
      report(
        "error",
        error instanceof Error ? error.message : "選択範囲を表示できません。",
      );
    }
  }
  function shortcut(event: KeyboardEvent) {
    if (
      event.key.toLowerCase() === "f" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (
        !event.repeat &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !helpOpen &&
        !document.querySelector(
          '[role="dialog"]:not([data-layer-inactive="true"]),[popover]:popover-open',
        ) &&
        clipboardScope(event.target)
      ) {
        event.preventDefault();
        showSelection();
      }
      return;
    }

    if (event.key === "F1" || event.key === "F2") {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        return;
      event.preventDefault();
      if (
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        busy ||
        clipboardBusy ||
        drafts.pending ||
        replacement ||
        helpOpen ||
        inspectorController?.isTagPickerOpen() ||
        document.querySelector(
          '[role="dialog"]:not([data-layer-inactive="true"])',
        )
      )
        return;
      if (event.key === "F1") helpOpen = true;
      else if (mode === "edit" && !positionPlacement)
        renameFocused(event.target);
      return;
    }
    if (
      folderRequest !== null ||
      inspectorController?.isTagPickerOpen() ||
      (event.target instanceof Element &&
        event.target.closest('[role="dialog"][aria-label="タグを選択"]'))
    ) {
      const key = event.key.toLowerCase();
      const localInput =
        event.target instanceof Element &&
        event.target.closest(
          '[role="dialog"] input:not([type="checkbox"]),[role="dialog"] textarea,[role="dialog"] [contenteditable]',
        );
      if (
        (event.ctrlKey || event.metaKey) &&
        (key === "s" ||
          (!event.shiftKey && ["n", "o"].includes(key)) ||
          (!localInput && ["z", "y"].includes(key)))
      )
        event.preventDefault();
      return;
    }
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      positionPlacement &&
      !drafts.pending &&
      !replacement &&
      !(
        event.target instanceof Element &&
        event.target.closest(
          'input,textarea,select,[contenteditable],[role="menu"],[role="dialog"]',
        )
      )
    ) {
      event.preventDefault();
      stopPlacement(true);
      return;
    }
    const focusedFolder =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-layer-folder]")
        : null;
    if (focusedFolder && !event.isComposing) {
      if (
        event.key === "Delete" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        if (!event.repeat)
          openFolderRequest(
            "remove",
            focusedFolder.dataset.layerFolder,
            focusedFolder,
          );
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        ["d", "x", "c"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        return;
      }
    }
    if (
      event.key === "Delete" &&
      !event.repeat &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      mode === "edit" &&
      !busy &&
      !clipboardBusy &&
      !drafts.pending &&
      !replacement &&
      !positionPlacement &&
      clipboardScope(event.target)
    ) {
      event.preventDefault();
      if (!hiddenCanvasMutation(event.target)) removeSelection();
      return;
    }
    if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey))
      return;
    const key = event.key.toLowerCase();
    if (["n", "o"].includes(key) && !event.shiftKey) {
      event.preventDefault();
      if (
        event.repeat ||
        busy ||
        drafts.pending ||
        replacement ||
        helpOpen ||
        document.querySelector(
          '[role="dialog"]:not([data-layer-inactive="true"])',
        )
      )
        return;
      if (key === "n") newProject();
      else openProjectFile();
      return;
    }
    if (key === "s") {
      event.preventDefault();
      if (!busy && !event.repeat) save();
      return;
    }
    if (busy || mode !== "edit" || drafts.pending || replacement) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input,textarea,select,[contenteditable]")
    )
      return;
    if (key === "z") {
      event.preventDefault();
      travel(event.shiftKey ? "redo" : "undo");
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      travel("redo");
    } else if (key === "a" && !event.shiftKey) {
      event.preventDefault();
      transition(
        () =>
          (selectedIds = screen.objects
            .filter((o) => !o.locked && o.visible !== false)
            .map((o) => o.id)),
      );
    } else if (key === "d" && !event.shiftKey && selectedIds.length) {
      event.preventDefault();
      duplicateSelection();
    }
  }
  let mode = $state<"edit" | "preview">("preview");
  let selectedIds = $state<string[]>([]);
  let selectedId = $derived(selectedIds.length === 1 ? selectedIds[0] : null);
  function selectObjects(
    id: string | null,
    additive = false,
    preserve = false,
  ): string[] {
    if (!drafts.allow(() => selectObjects(id, additive, preserve))) return [];
    if (!id) {
      if (!additive) selectedIds = [];
      return [...selectedIds];
    }
    selectedIds = additive
      ? selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id]
      : preserve && selectedIds.includes(id)
        ? selectedIds
        : [id];
    if (selectedIds.includes(id)) revealLayerObject(id);
    return [...selectedIds];
  }
  function selectCanvasObjects(
    id: string | null,
    additive = false,
    preserve = false,
  ) {
    if (
      id &&
      screen.objects.some(
        (object) =>
          object.id === id && (object.locked || object.visible === false),
      )
    )
      return [...selectedIds];
    return selectObjects(id, additive, preserve);
  }
  function selectRange(ids: string[], additive: boolean) {
    const target = screen.id,
      generation = workspaceGeneration;
    const apply = () => {
      if (
        mode !== "edit" ||
        screen.id !== target ||
        workspaceGeneration !== generation
      )
        return;
      const live = ids.filter((id) =>
        screen.objects.some(
          (object) =>
            object.id === id && !object.locked && object.visible !== false,
        ),
      );
      selectedIds = additive
        ? [
            ...new Set([
              ...selectedIds.filter((id) =>
                screen.objects.some(
                  (object) =>
                    object.id === id &&
                    !object.locked &&
                    object.visible !== false,
                ),
              ),
              ...live,
            ]),
          ]
        : live;
      for (const id of live) revealLayerObject(id);
    };
    if (drafts.allow(apply)) apply();
  }
  function duplicateSelection() {
    if (selectedIds.length === 1)
      edit({
        type: "duplicate",
        screenId: screen.id,
        objectId: selectedIds[0],
      });
    else if (selectedIds.length > 1)
      edit({
        type: "duplicate-many",
        screenId: screen.id,
        objectIds: [...selectedIds],
      });
  }
  function removeSelection() {
    if (selectedIds.length)
      edit({
        type: "remove-many",
        screenId: screen.id,
        objectIds: [...selectedIds],
      });
  }
  const clipboardSession = crypto.randomUUID();
  let clipboardBusy = $state(false);
  let lastPaste: { key: string; count: number } | undefined;
  function hiddenCanvasMutation(target: EventTarget | null) {
    if (
      target instanceof Element &&
      target.closest('[aria-label="キャンバス操作領域"]') &&
      screen.objects.some(
        (object) => object.visible === false && selectedIds.includes(object.id),
      )
    ) {
      report(
        "info",
        "非表示の配置を含むため、キャンバスからは変更できません。レイヤーやプロパティで対象を確認してください。",
      );
      return true;
    }
    return false;
  }
  function clipboardScope(target: EventTarget | null) {
    return (
      target instanceof Element &&
      !target.closest(
        'input,textarea,select,[contenteditable],[role="menu"],[role="dialog"],[data-layer-folder]',
      ) &&
      !!target.closest(
        '[aria-label="キャンバス操作領域"],nav[aria-label="図形一覧"]',
      )
    );
  }
  function clipboardAction(
    kind: "copy" | "cut" | "paste",
    event?: ClipboardEvent,
  ) {
    if (
      busy ||
      clipboardBusy ||
      mode !== "edit" ||
      drafts.pending ||
      replacement
    )
      return;
    const target = screen.id,
      generation = workspaceGeneration;
    const ids = [...selectedIds];
    if (kind !== "paste" && !ids.length) return;
    event?.preventDefault();
    if (kind === "cut" && event && hiddenCanvasMutation(event.target)) return;
    let native = event?.clipboardData;
    const input = kind === "paste" ? native?.getData("text/plain") : undefined;
    const validTarget = () =>
      mode === "edit" &&
      screen.id === target &&
      workspaceGeneration === generation &&
      !busy &&
      !replacement;
    const run = async () => {
      if (!validTarget() || clipboardBusy) return;
      clipboardBusy = true;
      try {
        const revision = project.manifest.projectRevision;
        const origin = `${clipboardSession}:${generation}`;
        const command: EditCommand = {
          type: "remove-many",
          screenId: target,
          objectIds: ids,
          ...(activeDefinition ? { definitionId: activeDefinition.id } : {}),
        };
        if (kind === "paste") {
          const text = input ?? (await navigator.clipboard.readText());
          if (
            !validTarget() ||
            revision !== project.manifest.projectRevision ||
            drafts.dirty ||
            drafts.pending
          )
            return;
          parseClipboard(text);
          const center = canvasWorkspace?.visibleCenter() ?? {
            x: screen.width / 2,
            y: screen.height / 2,
          };
          const key = JSON.stringify([
            text,
            origin,
            target,
            canvasView.scale,
            center,
          ]);
          const count = lastPaste?.key === key ? lastPaste.count + 1 : 0;
          if (
            edit({
              type: "paste",
              screenId: target,
              text,
              origin,
              center,
              offset: count * 20,
            })
          ) {
            lastPaste = { key, count };
            stopPlacement();
          }
        } else {
          if (kind === "cut") applyCommand(project, command, mode);
          const text = copyObjects(project, target, ids, origin);
          if (native) native.setData("text/plain", text);
          else await navigator.clipboard.writeText(text);
          if (kind === "cut") {
            if (
              !validTarget() ||
              revision !== project.manifest.projectRevision ||
              drafts.dirty ||
              drafts.pending ||
              ids.join() !== selectedIds.join()
            ) {
              report(
                "info",
                "コピーしました。編集中の状態が変わったため切り取りは中止しました。",
              );
              return;
            }
            if (edit(command)) stopPlacement();
          } else report("info", "選択した図形をコピーしました。");
        }
      } catch (error) {
        report(
          "error",
          `クリップボード操作に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clipboardBusy = false;
      }
    };
    if (drafts.allow(() => void run())) void run();
    else native = null;
  }
  function nativeClipboard(event: ClipboardEvent) {
    if (clipboardScope(event.target))
      clipboardAction(event.type as "copy" | "cut" | "paste", event);
  }
  function nudgeSelection(direction: Point, large: boolean) {
    const ids = [...selectedIds],
      target = screen.id,
      generation = workspaceGeneration;
    transition(() => {
      if (
        busy ||
        replacement ||
        mode !== "edit" ||
        positionPlacement ||
        canvasView.hand ||
        target !== screen.id ||
        generation !== workspaceGeneration ||
        ids.join() !== selectedIds.join()
      )
        return;
      const objects = screen.objects.filter((o) => ids.includes(o.id));
      if (!objects.length || objects.length !== ids.length) return;
      if (objects.some((object) => object.visible === false)) {
        report(
          "info",
          "非表示の配置を含むため移動できません。プロパティで対象を確認してください。",
        );
        return;
      }
      const delta = selectionNudge(
        objects,
        direction,
        snapEnabled ? gridSize : null,
        large,
      );
      edit({
        type: "move-many",
        screenId: target,
        objectIds: ids,
        dx: delta.x,
        dy: delta.y,
      });
    });
  }
  function moveSelection(event: SubmitEvent) {
    submitForm(event);
  }
  let project = $state(parseProject(JSON.stringify(sample)));
  let editorRegion = $state<HTMLElement>();
  let inspectorPanel = $state<HTMLElement>();
  let inspectorController = $state<{
    focusName: () => void;
    commitFocusedNumber: () => boolean;
    isTagPickerOpen: () => boolean;
  }>();
  const references = $derived(bindingReferences(project));
  function openBinding(usage: BindingUsage) {
    transition(() => {
      setInspectorVisibility(true);
      editingSymbolId = null;
      screenId = usage.screenId;
      selectedIds = [usage.objectId];
      revealLayerObject(usage.objectId);
      void tick().then(() => {
        editorRegion?.scrollTo({ top: 0 });
        inspectorPanel
          ?.querySelector<HTMLInputElement>('input[name="externalName"]')
          ?.focus();
      });
    });
  }
  let screenId = $state(sample.screens[0].id);
  let editingSymbolId = $state<string | null>(null);
  let libraryId = $state("");
  let activeDefinition = $derived(
    project.symbols.find((s) => s.id === editingSymbolId),
  );
  const symbolStrokeOverflow = $derived(
    activeDefinition ? strokeOverflowIds(activeDefinition).length : 0,
  );
  const favoriteItems = $derived(
    availableFavorites(
      favoriteKeys,
      project.manifest.projectId,
      project.symbols,
      !activeDefinition,
    ),
  );
  const armedLabel = $derived(
    armedPart
      ? (availableFavorites(
          [favoriteKey(armedPart, project.manifest.projectId)],
          project.manifest.projectId,
          project.symbols,
          !activeDefinition,
        )[0]?.label ?? "部品")
      : "",
  );
  const placementTargetKey = $derived(
    `${workspaceGeneration}:${mode}:${screenId}:${editingSymbolId ?? ""}`,
  );
  $effect(() => {
    placementTargetKey;
    untrack(() => stopPlacement());
  });
  $effect(() => {
    if (
      armedPart?.type === "symbol" &&
      !project.symbols.some(
        (definition) =>
          armedPart?.type === "symbol" && definition.id === armedPart.symbolId,
      )
    )
      stopPlacement();
  });
  function normalizeTargets() {
    if (
      editingSymbolId &&
      !project.symbols.some((s) => s.id === editingSymbolId)
    )
      editingSymbolId = null;
  }
  function withDefinition(id: string, action: () => void) {
    const generation = workspaceGeneration;
    const run = () => {
      if (
        generation !== workspaceGeneration ||
        !project.symbols.some((s) => s.id === id)
      )
        return;
      if (drafts.allow(run)) action();
    };
    run();
  }
  function openDefinition(id: string) {
    withDefinition(id, () => {
      setAuxPanelVisibility({ sidebar: true });
      editingSymbolId = id;
      activePanel = "project";
      libraryId = id;
      selectedIds = [];
    });
  }
  function deleteDefinition(id: string) {
    withDefinition(id, () => {
      const definition = project.symbols.find((s) => s.id === id)!;
      if (
        symbolUsage(project, id) === 0 &&
        window.confirm(`「${definition.name}」の Symbol 定義を削除しますか？`)
      ) {
        if (edit({ type: "remove-symbol", symbolId: id }))
          void tick().then(() => {
            const target =
              document.querySelector<HTMLButtonElement>(
                'nav[aria-label="共有 Symbol 一覧"] button[aria-pressed="true"]',
              ) ??
              document.querySelector<HTMLButtonElement>("[data-create-symbol]");
            target?.focus({ preventScroll: true });
          });
      }
    });
  }
  function openSymbolUsage(usage: SymbolUsage) {
    const generation = workspaceGeneration;
    const run = () => {
      if (generation !== workspaceGeneration || mode !== "edit") return;
      if (!drafts.allow(run)) return;
      const target = project.screens
        .find((s) => s.id === usage.screenId)
        ?.objects.find((o) => o.id === usage.objectId);
      if (
        target?.shape.type !== "symbol" ||
        target.shape.symbolId !== usage.symbolId
      ) {
        report("info", "使用先が変更されたため移動を中止しました。");
        return;
      }
      editingSymbolId = null;
      screenId = usage.screenId;
      selectedIds = [usage.objectId];
      libraryId = usage.symbolId;
      void tick().then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (
              generation !== workspaceGeneration ||
              screenId !== usage.screenId ||
              editingSymbolId ||
              selectedId !== usage.objectId
            )
              return;
            editorRegion?.scrollTo({ top: 0 });
            revealLayerObject(usage.objectId);
            canvasWorkspace?.revealObject(usage.objectId);
          }),
        ),
      );
    };
    run();
  }
  function symbolLibraryCommand(command: EditCommand) {
    if (
      command.type === "duplicate-symbol" ||
      command.type === "place-symbol"
    ) {
      withDefinition(command.symbolId, () => {
        if (
          command.type === "place-symbol" &&
          (editingSymbolId || screenId !== command.screenId)
        )
          return;
        edit(command);
      });
    } else edit(command);
  }
  let screen = $derived(
    activeDefinition ??
      project.screens.find((s) => s.id === screenId) ??
      project.screens[0],
  );
  let message = $state("サンプルを表示しています。Hub には接続していません。");
  let busy = $state(false);
  let baseline = $state(untrack(() => projectContent(project)));
  let baselineSource = $state<"sample" | "file" | "download" | "new">("sample");
  let lastExport = $state<string | null>(null);
  let projectChanged = $derived(projectContent(project) !== baseline);
  let replacement = $state<{
    project: Project;
    source: "sample" | "file" | "new";
  } | null>(null);
  const saveLabel = $derived(
    projectChanged
      ? "未書き出しの変更あり"
      : baselineSource === "download"
        ? "書き出し要求後の変更なし"
        : baselineSource === "file"
          ? "読込後の変更なし"
          : baselineSource === "new"
            ? "新しいProject・未書き出し"
            : "サンプルからの変更なし",
  );
  function adopt(next: Project, source: "sample" | "file" | "new") {
    project = next;
    baseline = projectContent(next);
    baselineSource = source;
    lastExport = null;
    history = emptyHistory();
    referencesExpanded = false;
    layerQuery = "";
    layersExpanded = true;
    workspaceGeneration++;
    screenId = project.screens[0].id;
    editingSymbolId = null;
    selectedIds = [];
    if (source === "new") mode = "edit";
    report(
      "info",
      source === "sample"
        ? "工程図サンプルを開きました。設備や計測値には接続していません。"
        : source === "new"
          ? "新しいProjectを作成しました。JSONを書き出して保存してください。"
          : "Project を読み込みました。",
    );
  }
  function requestReplacement(
    next: Project,
    source: "sample" | "file" | "new",
    generation = workspaceGeneration,
  ) {
    if (generation !== workspaceGeneration) return;
    if (!drafts.allow(() => requestReplacement(next, source, generation)))
      return;
    if (projectChanged) replacement = { project: next, source };
    else adopt(next, source);
  }
  function replaceNow() {
    const next = replacement;
    replacement = null;
    if (next) adopt(next.project, next.source);
  }
  function newProject() {
    if (busy || drafts.pending || replacement) return;
    requestReplacement(createProject(), "new");
  }
  function openProjectFile() {
    if (busy || drafts.pending || replacement) return;
    projectFileInput?.click();
  }
  function showProcessSample() {
    requestReplacement(parseProject(JSON.stringify(processSample)), "sample");
  }
  function beforeLeave(event: BeforeUnloadEvent) {
    if (projectChanged || drafts.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  function report(kind: NotificationKind, text: string) {
    message = text;
    notify(kind, text);
  }
  let selected = $derived(screen.objects.find((o) => o.id === selectedId));
  function rotateSelection(delta: number) {
    if (mutationBlocked || !selectedId) return;
    const id = selectedId,
      scope = folderScope;
    transition(() => {
      if (scope !== folderScope || mode !== "edit") return;
      const object = screen.objects.find((object) => object.id === id);
      if (!object || object.locked) return;
      edit({
        type: "update",
        screenId: screen.id,
        objectId: id,
        patch: { rotation: normalizeRotation(object.rotation + delta) },
      });
    });
  }
  function commitNumber(
    target: NumericTarget,
    field: NumericProperty,
    value: number,
    input: HTMLInputElement,
  ): string | null {
    if (
      mode !== "edit" ||
      busy ||
      replacement ||
      drafts.pending ||
      selected?.locked ||
      !input.isConnected ||
      target.generation !== workspaceGeneration ||
      target.screenId !== screen.id ||
      target.objectId !== selected?.id ||
      target.definition !== !!activeDefinition
    )
      return "編集対象または操作状態が変わりました。入力を確認してください。";
    try {
      if (field === "rotation") value = normalizeRotation(value);
      const result = recordEdit(
        project,
        history,
        {
          type: "update",
          screenId: target.screenId,
          objectId: target.objectId,
          ...(target.definition ? { definitionId: target.screenId } : {}),
          patch: {
            [field]:
              field === "opacity" || field === "colorAlpha"
                ? value / 100
                : value,
          },
        },
        mode,
      );
      // Acknowledge only this field before the model refreshes the persistent form.
      input.value = String(value);
      drafts.acceptField(input);
      project = result.project;
      history = result.history;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "数値を確定できません。";
    }
  }
  function acknowledgeForm(form: HTMLFormElement) {
    if (form.dataset.editorForm === "selection-outline") {
      for (const name of [
        "outlineMode",
        "outlineColor",
        "outlineWidth",
        "outlineStyle",
      ]) {
        const input = form.elements.namedItem(name);
        if (
          input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
        )
          input.value = "";
      }
    }

    if (form.dataset.editorForm === "selection-line") {
      const width = form.elements.namedItem("strokeWidth"),
        arrow = form.elements.namedItem("arrow");
      if (width instanceof HTMLInputElement) width.value = "";
      if (arrow instanceof HTMLSelectElement) arrow.value = "";
      const style = form.elements.namedItem("lineStyle");
      if (style instanceof HTMLSelectElement) style.value = "";
    }
    if (form.dataset.editorForm === "selection-color") {
      const input = form.elements.namedItem("fill");
      if (input instanceof HTMLInputElement) input.value = "";
      const convert = form.elements.namedItem("convertDefinitionSymbols");
      if (convert instanceof HTMLInputElement) convert.checked = false;
    }
    if (form.dataset.editorForm === "project") {
      const input = form.elements.namedItem("name");
      if (input instanceof HTMLInputElement)
        input.value = project.manifest.name;
    }
    if (form.dataset.editorForm === "object") {
      const input = form.elements.namedItem("name");
      if (input instanceof HTMLInputElement) input.value = selected?.name ?? "";
    }
    drafts.submitted(form);
  }
  function edit(
    command: EditCommand,
    form?: HTMLFormElement,
    onerror?: (message: string) => void,
  ): boolean {
    if (
      form
        ? !drafts.beforeSubmit(form)
        : !drafts.allow(() => edit(command, undefined, onerror))
    )
      return false;
    try {
      const oldEditingDefinition = editingSymbolId;
      const oldIds = new Set(screen.objects.map((o) => o.id));
      const oldScreens = new Set(project.screens.map((s) => s.id));
      const oldDefinitions = new Set(project.symbols.map((s) => s.id));
      if (activeDefinition && isObjectCommand(command))
        command = { ...command, definitionId: activeDefinition.id };
      if (
        command.type === "add" ||
        command.type === "add-symbol" ||
        command.type === "place-symbol"
      )
        command = {
          ...command,
          center: command.center ?? canvasWorkspace?.visibleCenter(),
        };
      const result = recordEdit(project, history, command, mode);
      if (result.project === project) {
        if (form) acknowledgeForm(form);
        return true;
      }
      project = result.project;
      history = result.history;
      normalizeTargets();
      if (
        command.type === "create-symbol" ||
        command.type === "duplicate-symbol" ||
        command.type === "make-symbol-unique"
      ) {
        openDefinition(
          project.symbols.find((s) => !oldDefinitions.has(s.id))!.id,
        );
      } else if (
        command.type === "remove-symbol" &&
        command.symbolId === oldEditingDefinition
      )
        selectedIds = [];
      if (
        command.type === "create-screen" ||
        command.type === "duplicate-screen"
      ) {
        screenId = project.screens.find((s) => !oldScreens.has(s.id))!.id;
        selectedIds = [];
      } else if (
        command.type === "remove-screen" &&
        command.screenId === screenId
      ) {
        screenId = project.screens[0].id;
        selectedIds = [];
      }
      if (
        command.type === "add" ||
        command.type === "add-symbol" ||
        command.type === "place-symbol" ||
        command.type === "duplicate" ||
        command.type === "duplicate-many" ||
        command.type === "paste"
      )
        selectedIds = screen.objects
          .filter((o) => !oldIds.has(o.id) && !o.locked && o.visible !== false)
          .map((o) => o.id);
      if (command.type === "remove" || command.type === "remove-many")
        selectedIds = [];
      if (command.type === "set-visibility" && !command.visible) {
        const hiddenId = command.objectId;
        selectedIds = selectedIds.filter((id) => id !== hiddenId);
      }
      if (form) acknowledgeForm(form);
      report(
        "success",
        "変更を適用しました。JSON を保存するとファイルに残せます。",
      );
      return true;
    } catch (e) {
      onerror?.(e instanceof Error ? e.message : String(e));
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
  function screenProperties(event: SubmitEvent) {
    submitForm(event);
  }
  function focusProjectName() {
    const generation = workspaceGeneration;
    setAuxPanelVisibility({ sidebar: true });
    activePanel = "project";
    void tick().then(() => {
      if (generation !== workspaceGeneration || mode !== "edit") return;
      const input = document.querySelector<HTMLInputElement>(
        'form[data-editor-form="project"] input[name="name"]',
      );
      if (input) expandTreeAncestors(input);
      input?.focus();
      input?.select();
    });
  }
  function renamePlacement(id: string) {
    const generation = workspaceGeneration,
      target = screen.id;
    const run = () => {
      if (
        generation !== workspaceGeneration ||
        screen.id !== target ||
        mode !== "edit"
      )
        return;
      const object = screen.objects.find((object) => object.id === id);
      if (!object) return;
      if (object.locked) {
        report("info", "ロックを解除してから配置名を変更してください。");
        return;
      }
      if (selectedId !== id && !drafts.allow(run)) return;
      selectedIds = [id];
      setInspectorVisibility(true);
      void tick().then(() => {
        if (
          generation === workspaceGeneration &&
          screen.id === target &&
          selectedId === id &&
          mode === "edit"
        )
          inspectorController?.focusName();
      });
    };
    run();
  }
  function renameFocused(target: EventTarget | null) {
    if (
      !(target instanceof Element) ||
      target.closest('input,textarea,select,[contenteditable],[role="menu"]')
    )
      return;
    const row = target.closest<HTMLElement>(
      "[data-screen-tab],[data-screen-id]",
    );
    if (row) {
      openScreen(row.dataset.screenTab ?? row.dataset.screenId!, true);
      return;
    }
    const folder = target.closest<HTMLElement>("[data-layer-folder]");
    if (folder) {
      openFolderRequest("rename", folder.dataset.layerFolder, folder);
      return;
    }
    const layer = target.closest<HTMLElement>("[data-layer-id]");
    if (layer) renamePlacement(layer.dataset.layerId!);
    else if (target.matches('[aria-label="キャンバス操作領域"]')) {
      if (selectedId) renamePlacement(selectedId);
      else report("info", "名前を変更する配置を1件選択してください。");
    }
  }
  function withScreen(id: string, action: () => void) {
    const generation = workspaceGeneration;
    const run = () => {
      if (
        generation !== workspaceGeneration ||
        !project.screens.some((s) => s.id === id)
      )
        return;
      if (drafts.allow(run)) action();
    };
    run();
  }
  function openScreen(id: string, rename = false) {
    const generation = workspaceGeneration;
    const run = () => {
      if (screenId !== id || editingSymbolId) selectedIds = [];
      screenId = id;
      editingSymbolId = null;
      if (rename) {
        setAuxPanelVisibility({ sidebar: true });
        activePanel = "project";
        void tick().then(() => {
          if (
            generation !== workspaceGeneration ||
            screenId !== id ||
            editingSymbolId ||
            mode !== "edit"
          )
            return;
          const input = document.querySelector<HTMLInputElement>(
            'form[data-editor-form="screen"] input[name="name"]',
          );
          if (input) expandTreeAncestors(input);
          input?.focus();
          input?.select();
        });
      }
    };
    // Revealing the current name must not resolve or replace its pending text.
    if (rename && screenId === id && !editingSymbolId) run();
    else withScreen(id, run);
  }
  function removeScreen(id: string) {
    withScreen(id, () => {
      const target = project.screens.find((s) => s.id === id)!;
      if (
        project.screens.length > 1 &&
        window.confirm(`「${target.name}」と画面内の図形を削除しますか？`)
      )
        edit({ type: "remove-screen", screenId: id });
    });
  }
  function screenContextItems(id: string): ContextAction[] {
    const command = (action: EditCommand) => () =>
      withScreen(id, () => edit(action));
    return [
      { label: "開く", run: () => openScreen(id) },
      { label: "名前変更", run: () => openScreen(id, true) },
      {
        label: "画面を複製",
        disabled: project.screens.length >= 100,
        run: command({ type: "duplicate-screen", screenId: id }),
      },
      {
        label: "画面を上へ",
        disabled: project.screens[0].id === id,
        run: command({ type: "reorder-screen", screenId: id, direction: "up" }),
      },
      {
        label: "画面を下へ",
        disabled: project.screens.at(-1)?.id === id,
        run: command({
          type: "reorder-screen",
          screenId: id,
          direction: "down",
        }),
      },
      {
        label: "画面を削除",
        disabled: project.screens.length === 1,
        run: () => removeScreen(id),
      },
    ];
  }
  function add(kind: AddKind) {
    edit({ type: "add", screenId: screen.id, kind });
  }
  function formCommand(form: HTMLFormElement): EditCommand {
    const data = new FormData(form);
    if (form.dataset.editorForm === "shape-paint") {
      if (
        !selected ||
        form.dataset.targetKey !==
          `${workspaceGeneration}:${screen.id}:${!!activeDefinition}` ||
        selected?.id !== form.dataset.objectId ||
        (selected.shape.type !== "rectangle" &&
          selected.shape.type !== "ellipse")
      )
        throw new Error(
          "塗りと枠線の適用先が変更されています。選択し直してください。",
        );
      const fill = data.get("fillEnabled"),
        stroke = data.get("strokeEnabled");
      if (
        !["true", "false"].includes(String(fill)) ||
        !["true", "false"].includes(String(stroke))
      )
        throw new Error("塗りと枠線の有無を選択してください。");
      const width =
        stroke === "true"
          ? parseNumericProperty(String(data.get("strokeSize") ?? ""))
          : 0;
      if (stroke === "true" && (width <= 0 || width > 64))
        throw new Error("枠線の幅は0より大きく64以下にしてください。");
      return {
        type: "update",
        screenId: screen.id,
        objectId: selected.id,
        patch: {
          paint: {
            fillEnabled: fill === "true",
            stroke:
              stroke === "true"
                ? {
                    color: String(data.get("strokeColor")),
                    width: Number(width),
                    ...(parseNumericProperty(
                      String(data.get("strokeAlpha")),
                    ) === 100 &&
                    selected.shape.paint.stroke?.alpha === undefined
                      ? {}
                      : {
                          alpha:
                            parseNumericProperty(
                              String(data.get("strokeAlpha")),
                            ) / 100,
                        }),
                    ...(parseLineStyle(data.get("strokeStyle")) === "solid" &&
                    selected.shape.paint.stroke?.lineStyle !== "solid"
                      ? {}
                      : { lineStyle: parseLineStyle(data.get("strokeStyle")) }),
                  }
                : null,
          },
        },
      };
    }
    if (form.dataset.editorForm === "symbol-color-mode") {
      if (
        form.dataset.targetKey !==
          `${workspaceGeneration}:${screen.id}:${!!activeDefinition}` ||
        selected?.id !== form.dataset.objectId ||
        selected?.shape.type !== "symbol" ||
        activeDefinition
      )
        throw new Error(
          "Symbolの色の適用先が変更されています。選択し直してください。",
        );
      const colorMode = String(data.get("colorMode"));
      if (colorMode !== "monochrome" && colorMode !== "definition")
        throw new Error("色の使い方を選択してください。");
      return {
        type: "update",
        screenId: screen.id,
        objectId: selected.id,
        patch: { colorMode },
      };
    }
    if (
      ["selection-color", "selection-line", "selection-outline"].includes(
        form.dataset.editorForm ?? "",
      )
    ) {
      if (
        form.dataset.targetKey !==
        `${workspaceGeneration}:${screen.id}:${!!activeDefinition}`
      )
        throw new Error(
          "スタイルの適用先が変更されています。選択し直してください。",
        );
      const ids: unknown = JSON.parse(form.dataset.objectIds ?? "[]");
      if (
        !Array.isArray(ids) ||
        ids.length !== selectedIds.length ||
        ids.some((id) => typeof id !== "string" || !selectedIds.includes(id))
      )
        throw new Error(
          "スタイルの適用対象が変更されています。選択し直してください。",
        );
      if (form.dataset.editorForm === "selection-outline") {
        const rawMode = String(data.get("outlineMode") ?? ""),
          color = String(data.get("outlineColor") ?? ""),
          width = String(data.get("outlineWidth") ?? "");
        const style = String(data.get("outlineStyle") ?? "");
        if (rawMode !== "" && rawMode !== "none" && rawMode !== "enabled")
          throw new Error("枠線の有無を選択してください。");
        return {
          type: "set-outline-style",
          screenId: screen.id,
          objectIds: ids as string[],
          patch: {
            ...(rawMode === "" ? {} : { mode: rawMode }),
            ...(color === "" ? {} : { color }),
            ...(width === "" ? {} : { width: parseNumericProperty(width) }),
            ...(style === "" ? {} : { lineStyle: parseLineStyle(style) }),
          },
        };
      }
      if (form.dataset.editorForm === "selection-line") {
        const width = String(data.get("strokeWidth") ?? ""),
          arrow = String(data.get("arrow") ?? "");
        const style = String(data.get("lineStyle") ?? "");
        if (arrow !== "" && arrow !== "none" && arrow !== "end")
          throw new Error("矢印の指定が不正です。");
        return {
          type: "set-line-style",
          screenId: screen.id,
          objectIds: ids as string[],
          patch: {
            ...(width === ""
              ? {}
              : { strokeWidth: parseNumericProperty(width) }),
            ...(arrow === "" ? {} : { arrow }),
            ...(style === "" ? {} : { lineStyle: parseLineStyle(style) }),
          },
        };
      }
      return {
        type: "set-color",
        screenId: screen.id,
        objectIds: ids as string[],
        fill: String(data.get("fill")),
        convertDefinitionSymbols: data.get("convertDefinitionSymbols") === "on",
      };
    }
    if (form.dataset.editorForm === "project")
      return { type: "update-project", name: String(data.get("name")) };
    if (form.dataset.editorForm === "screen")
      return {
        ...(activeDefinition
          ? { type: "update-symbol" as const, symbolId: activeDefinition.id }
          : {
              type: "update-screen" as const,
              screenId: screen.id,
              background: String(data.get("background")),
            }),
        name: String(data.get("name")),
        width: Number(data.get("width")),
        height: Number(data.get("height")),
      };
    if (form.dataset.editorForm === "move")
      return {
        type: "move-many",
        screenId: screen.id,
        objectIds: [...selectedIds],
        dx: Number(data.get("dx")),
        dy: Number(data.get("dy")),
      };
    if (!selected) throw new Error("選択した図形が見つかりません");
    const patch: ObjectPatch = {
      name: String(data.get("name") ?? ""),
      x: Number(data.get("x")),
      y: Number(data.get("y")),
      rotation: parseNumericProperty(String(data.get("rotation") ?? "")),
      opacity: parseNumericProperty(String(data.get("opacity") ?? "")) / 100,
      ...(data.has("colorAlpha")
        ? {
            colorAlpha:
              parseNumericProperty(String(data.get("colorAlpha"))) / 100,
          }
        : {}),
      ...(data.has("fill") ? { fill: String(data.get("fill")) } : {}),
    };
    if ("width" in selected) {
      patch.width = Number(data.get("width"));
      patch.height = Number(data.get("height"));
    }
    if (selected.shape.type === "text") {
      patch.text = String(data.get("text"));
      const fontWeight = String(data.get("fontWeight")),
        align = String(data.get("textAlign"));
      if (
        !["normal", "bold"].includes(fontWeight) ||
        !["left", "center", "right"].includes(align)
      )
        throw new Error("文字書式を選択してください。");
      patch.textStyle = {
        fontSize: parseNumericProperty(String(data.get("fontSize") ?? "")),
        fontWeight: fontWeight as "normal" | "bold",
        align: align as "left" | "center" | "right",
      };
      if (!activeDefinition) {
        const externalName = String(data.get("externalName") ?? "");
        patch.binding = externalName === "" ? null : { externalName };
      }
    }
    if (selected.shape.type === "symbol")
      patch.symbolId = String(data.get("symbolId"));
    if (selected.shape.type === "polyline") {
      patch.lineStyle = parseLineStyle(data.get("lineStyle"));
      patch.points = parsePoints(String(data.get("points")));
      patch.strokeWidth = Number(data.get("strokeWidth"));
      patch.arrow = data.get("arrow") === "end" ? "end" : "none";
    }
    return {
      type: "update",
      screenId: screen.id,
      objectId: selected.id,
      patch,
    };
  }
  function validateDrafts(forms: HTMLFormElement[]): boolean {
    let validatingForm: HTMLFormElement | undefined;
    try {
      let candidate = project;
      for (const form of forms) {
        validatingForm = form;
        if (!form.isConnected) continue;
        let command = formCommand(form);
        if (activeDefinition && isObjectCommand(command))
          command = { ...command, definitionId: activeDefinition.id };
        candidate = applyCommand(candidate, command, mode);
      }
      return true;
    } catch (e) {
      if (validatingForm) revealDraftForm(validatingForm);
      if (validatingForm?.dataset.editorForm === "project") focusProjectName();
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
  const composingForms = new WeakSet<HTMLFormElement>();
  function nameFormKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (event.isComposing ||
        event.keyCode === 229 ||
        composingForms.has((event.currentTarget as HTMLInputElement).form!))
    )
      event.preventDefault();
  }
  function submitForm(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (composingForms.has(form)) return;
    try {
      edit(formCommand(form), form);
    } catch (e) {
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function properties(event: SubmitEvent) {
    submitForm(event);
  }

  let fileReadRequest = 0;
  async function load(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !input.isConnected) return;
    const generation = workspaceGeneration;
    const request = ++fileReadRequest;
    const current = () =>
      request === fileReadRequest &&
      generation === workspaceGeneration &&
      input.isConnected;
    busy = true;
    try {
      if (file.size > 1024 * 1024)
        throw new Error("ファイルは 1 MiB 以下にしてください");
      const text = await file.text();
      if (!current()) return;
      const next = parseProject(text);
      requestReplacement(next, "file", generation);
    } catch (e) {
      if (!current()) return;
      report(
        "error",
        `読込エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (request === fileReadRequest) busy = false;
      if (input.isConnected) input.value = "";
    }
  }
  function save() {
    if (replacement) {
      writeJson();
      return;
    }
    if (!drafts.allow(save)) return;
    writeJson();
  }
  function writeJson() {
    try {
      const json = serializeProject(project);
      const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "project.json";
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      baseline = projectContent(project);
      baselineSource = "download";
      lastExport = new Date().toLocaleTimeString("ja-JP");
      report(
        "success",
        "Project JSON のダウンロードを開始しました。保存先でファイルを確認してください。",
      );
    } catch (e) {
      report(
        "error",
        `書き出しエラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function changeMode(next: "edit" | "preview") {
    transition(() => {
      mode = next;
      if (next === "preview") editingSymbolId = null;
      selectedIds = [];
    });
  }
  let selectionMenu = $state<{
    show: (origin: HTMLElement, point?: Point) => Promise<void>;
  }>();
  let selectionOrigin: HTMLElement | null = null;
  let contextKind = $state<"selection" | "blank">("blank");
  let contextRequest = $state(0);
  let contextPoint = $state<Point | null>(null);
  const contextScope = $derived(
    `${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${mode}:${selectedIds.join(",")}:${activePanel}:${showSidebar}:${showInspector}:${snapEnabled}:${gridSize}:${contextKind}:${busy}:${!!drafts.pending}:${!!replacement}:${contextRequest}`,
  );
  const folderScope = $derived(`${workspaceGeneration}:${screen.id}`);
  let closedLayerFolders = $state<Record<string, string[]>>({});
  const closedFolders = $derived(
    new Set(closedLayerFolders[folderScope] ?? []),
  );
  const layerTreeView = $derived(
    layerTree(screen, layerQuery, closedFolders, layerSearchText),
  );
  const visibleLayers = $derived(layerTreeView.matchingObjects);
  function layerSearchText(object: ScreenObject) {
    return [
      objectLabel(object),
      placementLabel({ ...object, name: undefined }, project.symbols),
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
    if (screen.folders.length)
      revealFolder(screen.objects.find((object) => object.id === id)?.folderId);
  }
  function toggleFolder(id: string) {
    if (layerQuery.trim()) return;
    const next = new Set(closedFolders);
    if (!next.delete(id)) next.add(id);
    closedLayerFolders = { ...closedLayerFolders, [folderScope]: [...next] };
  }
  function revealFolder(id?: string) {
    const ancestors = new Set(
      folderAncestors(screen.folders, id).map((folder) => folder.id),
    );
    closedLayerFolders = {
      ...closedLayerFolders,
      [folderScope]: [...closedFolders].filter((id) => !ancestors.has(id)),
    };
  }
  let lastFolderReveal = "";
  $effect(() => {
    const ancestors = selectedIds.flatMap((id) =>
      folderAncestors(
        screen.folders,
        screen.objects.find((object) => object.id === id)?.folderId,
      ).map((folder) => folder.id),
    );
    const key = `${folderScope}:${selectedIds.join(",")}:${ancestors.join(",")}`;
    if (key === lastFolderReveal) return;
    lastFolderReveal = key;
    untrack(() => {
      if (
        !ancestors.length ||
        !selectedIds.some((id) =>
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
      ? layerDropError(screen, folderScope, layerDragGuide, layerDropTarget)
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
          ? `${folderPath(screen.folders, layerDropTarget)} 直下へ`
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
    mode;
    activePanel;
    showSidebar;
    untrack(endLayerDrag);
  });
  function beginLayerDrag(event: DragEvent, id: string) {
    const ids = layerDragSource(screen, id, selectedIds);
    if (editBlocked || !ids || !event.dataTransfer) {
      event.preventDefault();
      if (!ids)
        report("error", "ロックを含む配置はドラッグで所属を変更できません。");
      return;
    }
    layerDrag = {
      kind: "objects",
      token: crypto.randomUUID(),
      scope: folderScope,
      ids,
      hidden: ids.filter(
        (id) =>
          screen.objects.find((object) => object.id === id)?.visible === false,
      ).length,
    };
    layerDragClickUntil = performance.now() + 300;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(LAYER_MIME, layerDrag.token);
  }
  function beginFolderDrag(event: DragEvent, id: string) {
    const source = folderDragSource(screen, id);
    if (editBlocked || !source || !event.dataTransfer) {
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
      !editBlocked &&
      layerDrag.scope === folderScope &&
      event.dataTransfer?.types.includes(LAYER_MIME) &&
      !layerDragError(screen, folderScope, layerDrag)
    );
  }
  function dropLayer(event: DragEvent, destination: string) {
    const drag = layerDrag;
    if (!drag || event.dataTransfer?.getData(LAYER_MIME) !== drag.token) return;
    endLayerDrag();
    // Snapshot survives native dragend and the draft prompt; never retarget it.
    transition(() => {
      const error = layerDropError(screen, folderScope, drag, destination);
      if (mode !== "edit" || error) {
        report("error", error ?? "編集モードでやり直してください。");
        return;
      }
      if (
        !edit(
          drag.kind === "objects"
            ? {
                type: "set-folder",
                screenId: screen.id,
                objectIds: drag.ids,
                folderId: destination || null,
              }
            : {
                type: "move-folder",
                screenId: screen.id,
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
          report(
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
    selectObjects(id, event.shiftKey);
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
    if (editBlocked || (kind === "assign" && mutationBlocked)) return;
    const scope = folderScope,
      ids = [...selectedIds];
    const source =
      origin ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    transition(() => {
      if (
        scope !== folderScope ||
        mode !== "edit" ||
        (folderId &&
          !screen.folders.some((folder) => folder.id === folderId)) ||
        (kind === "assign" &&
          (!ids.length ||
            ids.some(
              (id) => !screen.objects.some((object) => object.id === id),
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
      (folderRequest.scope !== folderScope || mode !== "edit")
    )
      folderRequest = null;
  });
  function applyFolderCommand(command: EditCommand): string | null {
    const request = folderRequest;
    if (!request || request.scope !== folderScope || mode !== "edit")
      return "編集対象が変わりました。閉じてやり直してください。";
    const before = new Set(screen.folders.map((folder) => folder.id));
    let error = "";
    if (!edit(command, undefined, (message) => (error = message)))
      return error || "変更できませんでした。対象と入力を確認してください。";
    const destination =
      command.type === "create-folder"
        ? screen.folders.find((folder) => !before.has(folder.id))?.id
        : command.type === "set-folder"
          ? (command.folderId ?? undefined)
          : request.folderId;
    if (!layerQuery.trim()) revealFolder(destination);
    closeFolderRequest();
    return null;
  }
  function showFolderMenu(id: string, origin: HTMLElement) {
    if (menuBlocked) return;
    contextFolderId = id;
    folderOrigin = origin;
    const request = ++folderMenuRequest,
      scope = folderScope;
    void tick().then(() => {
      if (
        request === folderMenuRequest &&
        scope === folderScope &&
        mode === "edit" &&
        !menuBlocked &&
        screen.folders.some((folder) => folder.id === id)
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
  function toggleObjectVisibility(id: string) {
    const generation = workspaceGeneration,
      target = screen.id;
    const apply = () => {
      if (
        generation !== workspaceGeneration ||
        target !== screen.id ||
        mode !== "edit" ||
        busy ||
        replacement
      )
        return;
      const object = screen.objects.find((object) => object.id === id);
      if (object)
        edit({
          type: "set-visibility",
          screenId: screen.id,
          objectId: id,
          visible: object.visible === false,
        });
    };
    if (drafts.allow(apply)) apply();
  }
  function toggleObjectLock(id: string) {
    const generation = workspaceGeneration,
      target = screen.id;
    const apply = () => {
      if (
        generation !== workspaceGeneration ||
        target !== screen.id ||
        mode !== "edit" ||
        busy ||
        replacement
      )
        return;
      const object = screen.objects.find((object) => object.id === id);
      if (object)
        edit({
          type: "set-lock",
          screenId: screen.id,
          objectId: id,
          locked: !object.locked,
        });
    };
    if (drafts.allow(apply)) apply();
  }
  function objectLabel(object: ScreenObject) {
    return placementLabel(object, project.symbols);
  }
  const hiddenSelectionCount = $derived(
    screen.objects.filter(
      (object) => object.visible === false && selectedIds.includes(object.id),
    ).length,
  );
  const baseSelectionContextLabel = $derived(
    contextKind === "blank"
      ? "キャンバス"
      : selectedIds.length > 1
        ? `選択図形（${selectedIds.length} 件）`
        : selected
          ? objectLabel(selected)
          : "選択図形",
  );
  const selectionContextLabel = $derived(
    contextKind !== "blank" && hiddenSelectionCount
      ? `${baseSelectionContextLabel}（非表示 ${hiddenSelectionCount} 件）`
      : baseSelectionContextLabel,
  );
  function requestSelectionContext(request: CanvasContext) {
    if (mode !== "edit" || busy || drafts.pending || replacement) return;
    const generation = workspaceGeneration,
      target = screen.id;
    const finish = () => {
      if (
        mode !== "edit" ||
        workspaceGeneration !== generation ||
        screen.id !== target ||
        (request.objectId &&
          !screen.objects.some((object) => object.id === request.objectId))
      )
        return;
      if (request.objectId && !selectedIds.includes(request.objectId))
        selectedIds = [request.objectId];
      const requestId = ++contextRequest;
      selectionOrigin = request.origin;
      contextKind = request.objectId ? "selection" : "blank";
      contextPoint = request.designPoint;
      void tick().then(() => {
        if (
          mode === "edit" &&
          generation === workspaceGeneration &&
          target === screen.id &&
          requestId === contextRequest
        )
          void selectionMenu?.show(request.origin, request.point);
      });
    };
    if (request.objectId && !selectedIds.includes(request.objectId))
      transition(finish);
    else finish();
  }
  function layerContext(objectId: string, origin: HTMLElement) {
    const rect = origin.getBoundingClientRect();
    requestSelectionContext({
      objectId,
      origin,
      point: { x: rect.right, y: rect.bottom },
      designPoint: null,
    });
  }
  function layerContextKey(event: KeyboardEvent, objectId: string) {
    if (
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      layerContext(objectId, event.currentTarget as HTMLElement);
    }
  }
  const menuBlocked = $derived(busy || !!drafts.pending || !!replacement);
  const editBlocked = $derived(menuBlocked || mode !== "edit");
  const selectionViewTarget = $derived(selectionTarget(screen, selectedIds));
  const selectionViewReason = $derived(
    mode !== "edit"
      ? "編集モードで使用できます"
      : menuBlocked || clipboardBusy
        ? "確認中の操作を完了してください"
        : positionPlacement
          ? "連続配置を終了してください"
          : selectionViewTarget.reason,
  );

  const selectionLocked = $derived(
    screen.objects.some(
      (object) => object.locked && selectedIds.includes(object.id),
    ),
  );
  const mutationBlocked = $derived(editBlocked || selectionLocked);
  const folderContextItems: ContextAction[] = $derived([
    {
      label: "子フォルダーを作成",
      disabled: editBlocked || screen.folders.length >= 256,
      run: () =>
        openFolderRequest("create", contextFolderId, folderOrigin ?? undefined),
    },
    {
      label: "フォルダー名を変更",
      disabled: editBlocked,
      run: () =>
        openFolderRequest("rename", contextFolderId, folderOrigin ?? undefined),
    },
    {
      label: "親フォルダーを変更",
      disabled: editBlocked,
      run: () =>
        openFolderRequest("move", contextFolderId, folderOrigin ?? undefined),
    },
    {
      label: "空のフォルダーを削除",
      disabled: editBlocked,
      run: () =>
        openFolderRequest("remove", contextFolderId, folderOrigin ?? undefined),
    },
  ]);
  const editToolbarGroups: ToolbarGroup[] = $derived([
    {
      id: "history",
      label: "編集履歴",
      items: [
        {
          label: "元に戻す",
          icon: "M8 5L3 10L8 15M3 10H14A6 6 0 0 1 14 22",
          disabled: editBlocked || !history.past.length,
          run: () => travel("undo"),
        },
        {
          label: "やり直す",
          icon: "M16 5L21 10L16 15M21 10H10A6 6 0 0 0 10 22",
          disabled: editBlocked || !history.future.length,
          run: () => travel("redo"),
        },
      ],
    },
    {
      id: "selection",
      label: "選択と編集",
      items: [
        {
          label: "すべて選択",
          icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M7 7H17V17H7Z",
          disabled:
            editBlocked ||
            !screen.objects.some(
              (object) => !object.locked && object.visible !== false,
            ),
          run: () =>
            transition(
              () =>
                (selectedIds = screen.objects
                  .filter((o) => !o.locked && o.visible !== false)
                  .map((o) => o.id)),
            ),
        },
        {
          label: "選択解除",
          icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M8 8L16 16M16 8L8 16",
          disabled: mutationBlocked || !selectedIds.length,
          run: () => transition(() => (selectedIds = [])),
        },
        {
          label: "選択図形を複製",
          icon: "M9 9H21V21H9ZM15 5V3H3V15H5",
          disabled: mutationBlocked || !selectedIds.length,
          run: duplicateSelection,
        },
        {
          label: "選択図形を削除",
          icon: "M3 6H21M9 6V3H15V6M6 6L7 21H17L18 6M10 10V17M14 10V17",
          disabled: mutationBlocked || !selectedIds.length,
          run: removeSelection,
        },
      ],
    },
    {
      id: "rotation",
      label: "回転（単一選択）",
      items: [
        {
          label: "左へ90°回転",
          icon: "M3 10A9 9 0 1 1 5 18M3 3V10H10",
          disabled: mutationBlocked || selectedIds.length !== 1,
          run: () => rotateSelection(-90),
        },
        {
          label: "右へ90°回転",
          icon: "M21 10A9 9 0 1 0 19 18M21 3V10H14",
          disabled: mutationBlocked || selectedIds.length !== 1,
          run: () => rotateSelection(90),
        },
      ],
    },
    {
      id: "order",
      label: "重なり順（単一選択）",
      items: [
        {
          direction: "back" as const,
          label: "最背面へ",
          icon: "M3 3H21M7 8H17V18H7ZM12 11V22M9 19L12 22L15 19",
        },
        {
          direction: "backward" as const,
          label: "1つ背面へ",
          icon: "M3 4H14V15H3ZM10 10H21V21H10M16 12V19M13 16L16 19L19 16",
        },
        {
          direction: "forward" as const,
          label: "1つ前面へ",
          icon: "M3 4H14V15H3M10 10H21V21H10ZM16 19V12M13 15L16 12L19 15",
        },
        {
          direction: "front" as const,
          label: "最前面へ",
          icon: "M3 21H21M7 6H17V16H7ZM12 13V2M9 5L12 2L15 5",
        },
      ].map((item) => ({
        ...item,
        disabled: mutationBlocked || selectedIds.length !== 1,
        run: () => {
          if (selectedIds.length === 1)
            edit({
              type: "reorder",
              screenId: screen.id,
              objectId: selectedIds[0],
              direction: item.direction,
            });
        },
      })),
    },
    {
      id: "align",
      label: "整列（複数選択）",
      items: [
        ...[
          {
            alignment: "left" as const,
            label: "左揃え",
            icon: "M3 3V21M7 5H20V10H7ZM7 14H15V19H7Z",
          },
          {
            alignment: "center-x" as const,
            label: "左右中央揃え",
            icon: "M12 2V22M4 5H20V10H4ZM7 14H17V19H7Z",
          },
          {
            alignment: "right" as const,
            label: "右揃え",
            icon: "M21 3V21M4 5H17V10H4ZM9 14H17V19H9Z",
          },
          {
            alignment: "top" as const,
            label: "上揃え",
            icon: "M3 3H21M5 7H10V20H5ZM14 7H19V15H14Z",
          },
          {
            alignment: "center-y" as const,
            label: "上下中央揃え",
            icon: "M2 12H22M5 4H10V20H5ZM14 7H19V17H14Z",
          },
          {
            alignment: "bottom" as const,
            label: "下揃え",
            icon: "M3 21H21M5 4H10V17H5ZM14 9H19V17H14Z",
          },
        ].map((item) => ({
          ...item,
          disabled: mutationBlocked || selectedIds.length < 2,
          run: () =>
            edit({
              type: "align",
              screenId: screen.id,
              objectIds: [...selectedIds],
              alignment: item.alignment,
            }),
        })),
        ...[
          {
            axis: "x" as const,
            label: "中心を水平方向に等間隔",
            icon: "M3 3V21M21 3V21M4 9H6V15H4ZM11 6H13V18H11ZM18 9H20V15H18Z",
          },
          {
            axis: "y" as const,
            label: "中心を垂直方向に等間隔",
            icon: "M3 3H21M3 21H21M9 4H15V6H9ZM6 11H18V13H6ZM9 18H15V20H9Z",
          },
        ].map((item) => ({
          ...item,
          disabled: mutationBlocked || selectedIds.length < 3,
          run: () =>
            edit({
              type: "distribute",
              screenId: screen.id,
              objectIds: [...selectedIds],
              axis: item.axis,
            }),
        })),
      ],
    },
  ]);
  function editGroupItems(id: string) {
    return editToolbarGroups.find((group) => group.id === id)!.items;
  }
  const selectionContextItems: ContextAction[] = $derived.by(() => {
    const properties: ContextAction = {
      label: "プロパティを表示",
      run: () => setInspectorVisibility(true, true),
    };
    if (contextKind === "blank")
      return [
        ...(contextPoint
          ? (
              [
                { kind: "rectangle", label: "Rectangle を挿入" },
                { kind: "ellipse", label: "Ellipse を挿入" },
                { kind: "text", label: "Text を挿入" },
                { kind: "line", label: "線を挿入" },
                { kind: "pipe", label: "配管を挿入" },
              ] as const
            ).map((part) => ({
              label: part.label,
              disabled: editBlocked,
              run: () =>
                edit({
                  type: "add",
                  screenId: screen.id,
                  kind: part.kind,
                  center: contextPoint!,
                }),
            }))
          : []),
        clipboardItems[2],
        editGroupItems("selection")[0],
        properties,
        { label: "全体表示", run: () => canvasWorkspace?.zoom(null) },
        {
          label: "補助パネルをすべて隠す",
          run: () => {
            if (showSidebar || showInspector || showReferences)
              toggleAuxPanels();
          },
        },
      ];
    return [
      properties,
      {
        label: "配置の所属を変更",
        disabled: mutationBlocked || !selectedIds.length,
        run: () =>
          openFolderRequest("assign", undefined, selectionOrigin ?? undefined),
      },
      ...(selected
        ? [
            {
              label: "配置名を変更",
              disabled: mutationBlocked,
              run: () => selected && renamePlacement(selected.id),
            },
          ]
        : []),
      ...(selected
        ? [
            {
              label:
                selected.visible === false
                  ? "配置を再表示"
                  : "配置を非表示（表示プレビューにも反映）",
              disabled: editBlocked,
              run: () => selected && toggleObjectVisibility(selected.id),
            },
          ]
        : []),
      ...(selected
        ? [
            {
              label: selected.locked ? "ロックを解除" : "配置をロック",
              disabled: editBlocked,
              run: () => selected && toggleObjectLock(selected.id),
            },
          ]
        : []),
      ...clipboardItems,
      ...editGroupItems("selection").slice(2),
      ...(selectedIds.length > 1
        ? editGroupItems("align")
        : [...editGroupItems("rotation"), ...editGroupItems("order")]),
      ...(selected?.shape.type === "symbol"
        ? [
            {
              label: "参照する Symbol 定義を編集",
              run: () => {
                if (selected?.shape.type === "symbol")
                  openDefinition(selected.shape.symbolId);
              },
            },
            {
              label: "定義を複製してこの配置に適用",
              disabled: mutationBlocked || project.symbols.length >= 100,
              run: () => {
                if (selected)
                  edit({
                    type: "make-symbol-unique",
                    screenId: screen.id,
                    objectId: selected.id,
                  });
              },
            },
          ]
        : []),
    ];
  });
  const clipboardItems: ContextAction[] = $derived([
    {
      label: "切り取り",
      disabled: mutationBlocked || clipboardBusy || !selectedIds.length,
      run: () => clipboardAction("cut"),
    },
    {
      label: "コピー",
      disabled: editBlocked || clipboardBusy || !selectedIds.length,
      run: () => clipboardAction("copy"),
    },
    {
      label: "貼り付け",
      disabled: editBlocked || clipboardBusy,
      run: () => clipboardAction("paste"),
    },
  ]);
  const menuGroups: DesignerMenu[] = $derived([
    {
      label: "ファイル",
      items: [
        { label: "新しいProject", disabled: menuBlocked, run: newProject },
        {
          label: "Project JSON を開く",
          disabled: menuBlocked,
          run: openProjectFile,
        },
        { label: "Project JSON を保存", disabled: menuBlocked, run: save },
        {
          label: "プロジェクト名を変更",
          disabled: editBlocked,
          run: focusProjectName,
        },
        {
          label: "工程図サンプルを開く",
          disabled: menuBlocked,
          run: showProcessSample,
        },
        {
          label: "Symbol配色サンプルを開く",
          disabled: menuBlocked,
          run: () =>
            requestReplacement(
              parseProject(JSON.stringify(symbolColorSample)),
              "sample",
            ),
        },
        {
          label: "塗りと枠線サンプルを開く",
          disabled: menuBlocked,
          run: () =>
            requestReplacement(
              parseProject(JSON.stringify(shapePaintSample)),
              "sample",
            ),
        },
      ],
    },
    {
      label: "編集",
      items: [
        ...clipboardItems,
        ...editToolbarGroups.flatMap((group) => group.items),
      ],
    },
    {
      label: "表示",
      items: [
        {
          label: "選択範囲を表示",
          disabled: !!selectionViewReason,
          run: showSelection,
        },
        {
          label: showRulers ? "ルーラーを隠す" : "ルーラーを表示",
          disabled: mode !== "edit",
          run: toggleRulers,
        },
        {
          label: showSidebar ? "左パネルを隠す" : "左パネルを表示",
          disabled: mode !== "edit",
          run: () =>
            setAuxPanelVisibility({ sidebar: !showSidebar }, "sidebar"),
        },
        {
          label: showReferences ? "タグ参照一覧を隠す" : "タグ参照一覧を表示",
          disabled: mode !== "edit",
          run: () =>
            setAuxPanelVisibility(
              { references: !showReferences },
              "references",
            ),
        },
        {
          label: previousPanels
            ? "補助パネルを元の表示に戻す"
            : Object.values(panelVisibility()).some(Boolean)
              ? "補助パネルをすべて隠す"
              : "補助パネルをすべて表示",
          disabled: mode !== "edit",
          run: toggleAuxPanels,
        },
        {
          label: showInspector ? "プロパティを隠す" : "プロパティを表示",
          disabled: mode !== "edit",
          run: () => setInspectorVisibility(!showInspector, true),
        },
        {
          label: showMinimap ? "ミニマップを隠す" : "ミニマップを表示",
          disabled: mode !== "edit",
          run: toggleMinimap,
        },
        {
          label: "お気に入りを標準に戻す",
          run: resetFavorites,
        },
        {
          label: "パネルの幅を標準に戻す",
          disabled: mode !== "edit",
          run: resetPanelWidths,
        },
        {
          label: "標準レイアウトに戻す",
          disabled: editBlocked,
          run: restorePanelLayout,
        },
        {
          label: "タグ参照パネルの高さを標準に戻す",
          disabled: mode !== "edit",
          run: resetReferenceHeight,
        },
        {
          label: showMenubar ? "メニューバーを隠す" : "メニューバーを表示",
          run: toggleMenubar,
        },
        {
          label: "編集モード",
          disabled: menuBlocked,
          run: () => changeMode("edit"),
        },
        {
          label: "表示プレビュー",
          disabled: menuBlocked,
          run: () => changeMode("preview"),
        },
        { label: "テーマ：ライト", run: () => chooseTheme("light") },
        { label: "テーマ：ダーク", run: () => chooseTheme("dark") },
        { label: "テーマ：OS に合わせる", run: () => chooseTheme("system") },
      ],
    },
    {
      label: "挿入",
      items: [
        ...(
          [
            { kind: "rectangle", label: "Rectangle を追加" },
            { kind: "ellipse", label: "Ellipse を追加" },
            { kind: "text", label: "Text を追加" },
            { kind: "line", label: "線を追加" },
            { kind: "pipe", label: "配管を追加" },
          ] as const
        ).map((part) => ({
          label: part.label,
          disabled: editBlocked,
          run: () => add(part.kind),
        })),
        ...(["pump", "valve"] as const).map((template) => ({
          label: template === "pump" ? "ポンプを追加" : "バルブを追加",
          disabled: editBlocked || !!activeDefinition,
          run: () => {
            edit({ type: "add-symbol", screenId: screen.id, template });
          },
        })),
      ],
    },
    {
      label: "ツール",
      items: [
        {
          label: showGrid ? "グリッドを隠す" : "グリッドを表示",
          disabled: editBlocked,
          run: () => (showGrid = !showGrid),
        },
        {
          label: snapEnabled ? "スナップを無効にする" : "スナップを有効にする",
          disabled: editBlocked,
          run: () => (snapEnabled = !snapEnabled),
        },
      ],
    },
    {
      label: "ヘルプ",
      items: [
        { label: "操作ガイド・アプリ情報", run: () => (helpOpen = true) },
      ],
    },
  ]);
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  oncopy={nativeClipboard}
  oncut={nativeClipboard}
  onpaste={nativeClipboard}
  onkeydown={shortcut}
  onbeforeunload={beforeLeave}
/>

<svelte:head
  ><meta
    name="description"
    content="Banto SCADA の初期 Project エディタ"
  /></svelte:head
>
{#key workspaceGeneration}
  <input
    hidden
    aria-label="Project JSON を開く"
    bind:this={projectFileInput}
    type="file"
    accept=".json,application/json"
    disabled={busy}
    onchange={load}
  />
{/key}
<header class="app-header">
  <span class="studio-brand">SCADA<span>/ studio</span></span>
  <h1 title={project.manifest.name}>{project.manifest.name}</h1>
  {#if showMenubar}<DesignerMenubar groups={menuGroups} />{/if}
  <div class="header-actions" use:settleMenuFocus>
    <Menu label="常設メニュー" placement="bottom-end">
      {#snippet trigger(props)}
        <button
          {...props}
          data-permanent-menu
          aria-label="メニュー"
          title="メニュー">☰</button
        >
      {/snippet}
      <MenuGroup label="ファイル">
        {#each menuGroups[0].items as item}
          <MenuItem
            label={item.label}
            disabled={item.disabled}
            onSelect={item.run}
          />
        {/each}
      </MenuGroup>
      <MenuGroup label="表示">
        {#each menuGroups[2].items as item}
          <MenuItem
            label={item.label}
            disabled={item.disabled}
            onSelect={item.run}
          />
        {/each}
      </MenuGroup>
      <MenuGroup label="ヘルプ">
        <MenuItem
          label="操作ガイド・アプリ情報"
          onSelect={() => (helpOpen = true)}
        />
      </MenuGroup>
    </Menu>
    <Menu label="テーマ" placement="bottom-end">
      {#snippet trigger(props)}
        <button
          {...props}
          class="theme-icon"
          aria-label="テーマを変更"
          data-theme-mode={theme}
          title={`テーマ：${theme === "light" ? "ライト" : theme === "dark" ? "ダーク" : "OS に合わせる"}`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            {#if theme === "light"}<circle cx="12" cy="12" r="4" /><path
                d="M12 2V4M12 20V22M2 12H4M20 12H22M5 5L7 7M17 17L19 19M5 19L7 17M17 7L19 5"
              />
            {:else if theme === "dark"}<path
                d="M20 15A9 9 0 0 1 9 4A9 9 0 1 0 20 15Z"
              />
            {:else}<path d="M3 4H21V17H3ZM8 21H16M12 17V21" />{/if}
          </svg>
        </button>
      {/snippet}
      <MenuItem label="ライト" onSelect={() => chooseTheme("light")} />
      <MenuItem label="ダーク" onSelect={() => chooseTheme("dark")} />
      <MenuItem label="OS に合わせる" onSelect={() => chooseTheme("system")} />
    </Menu>
  </div>
</header>
<EditToolbar
  groups={mode === "edit" ? editToolbarGroups : []}
  selectionCount={selectedIds.length}
  {hiddenSelectionCount}
>
  {#snippet modes()}
    <div class="mode-tools" role="group" aria-label="表示モード">
      <button
        class:active={mode === "edit"}
        aria-pressed={mode === "edit"}
        disabled={menuBlocked}
        onclick={() => changeMode("edit")}
        title="編集モード">編集</button
      >
      <button
        class:active={mode === "preview"}
        aria-pressed={mode === "preview"}
        disabled={menuBlocked}
        onclick={() => changeMode("preview")}
        title="表示プレビュー">表示プレビュー</button
      >
      {#if mode === "edit"}<button
          aria-label="キャンバスの操作"
          title="キャンバスの操作（Shift+F10）"
          aria-haspopup="menu"
          disabled={menuBlocked}
          onclick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            requestSelectionContext({
              objectId: selectedIds[0] ?? null,
              origin: event.currentTarget,
              point: { x: rect.left, y: rect.bottom },
              designPoint: canvasWorkspace?.visibleCenter() ?? null,
            });
          }}>⋮</button
        >{/if}
    </div>
  {/snippet}
  {#snippet controls()}
    {#if mode === "edit"}
      <CanvasControls
        view={canvasView}
        selectionReason={selectionViewReason}
        onselection={showSelection}
        bind:showGrid
        bind:snapEnabled
        bind:gridSize
        placing={positionPlacement}
        onplacing={togglePlacement}
        onhand={(value) => {
          stopPlacement();
          canvasWorkspace?.setHand(value);
        }}
        onzoom={(value) => canvasWorkspace?.zoom(value)}
        onstep={(value) => canvasWorkspace?.stepZoom(value)}
      />
    {/if}
  {/snippet}
  {#snippet status()}
    <div
      class="save-state"
      data-testid="save-state"
      role="group"
      aria-label="保存状態"
      title={lastExport ? `最終書き出し要求 ${lastExport}` : saveLabel}
    >
      <StatusBadge
        variant={projectChanged ? "warning" : "neutral"}
        label={saveLabel}
      />
      {#if drafts.dirty}<span>未適用の入力あり · {drafts.count} フォーム</span
        >{/if}
      {#if lastExport}<span class="sr-only">最終書き出し要求 {lastExport}</span
        >{/if}
    </div>
    <StatusBadge variant="neutral" label="Hub 未接続" />
  {/snippet}
</EditToolbar>
<ScreenTabs
  screens={project.screens}
  activeId={activeDefinition ? null : screen.id}
  editable={mode === "edit"}
  contextKey={contextScope}
  onopen={openScreen}
  actions={screenContextItems}
/>
<main
  style:--sidebar-width={`${leftWidth}px`}
  style:--inspector-width={`${rightWidth}px`}
  class:editing={mode === "edit"}
  class:sidebar-visible={mode !== "edit" || showSidebar}
  class:inspector-visible={showInspector && mode === "edit"}
>
  <aside
    class="project-sidebar"
    id="designer-project-panel"
    aria-label="Project と部品"
    hidden={mode === "edit" && !showSidebar}
    bind:this={sidebarPanel}
    tabindex="-1"
  >
    {#if mode === "edit"}<div class="sidebar-heading">
        <span>作業パネル</span><button
          aria-label="左パネルを隠す"
          title="左パネルを隠す"
          onclick={() => setAuxPanelVisibility({ sidebar: false }, "sidebar")}
          >×</button
        >
      </div>{/if}
    <DesignerSidebar bind:active={activePanel} editable={mode === "edit"}>
      {#snippet projectPanel()}
        <div class="project-root" title={project.manifest.name}>
          <span aria-hidden="true">▦</span>
          {project.manifest.name}
        </div>
        <TreeSection label="画面" count={project.screens.length}>
          <nav aria-label="画面一覧">
            {#each project.screens as item (item.id)}
              {#snippet row()}
                <button
                  class="screen-row"
                  data-screen-id={item.id}
                  class:active={!activeDefinition && screen.id === item.id}
                  aria-pressed={!activeDefinition && screen.id === item.id}
                  onclick={() => openScreen(item.id)}
                  ><svg
                    class="screen-icon"
                    aria-hidden="true"
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    ><path d="M5 3h9l5 5v13H5V3zm9 0v6h5M8 13h8M8 17h8" /></svg
                  >{item.name}</button
                >
              {/snippet}
              {#if mode === "edit"}
                <ContextActions
                  flat
                  label={`画面：${item.name}`}
                  contextKey={`${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}:${mode}:${busy}:${!!drafts.pending}:${!!replacement}`}
                  items={screenContextItems(item.id)}
                  >{@render row()}</ContextActions
                >
              {:else}{@render row()}{/if}
            {/each}
          </nav>
        </TreeSection>
        {#if mode === "edit"}
          <TreeSection label="タグ参照" count={references.length}>
            <button
              class="reference-link"
              disabled={!references.length}
              onclick={() => {
                canvasWorkspace?.preparePanelResize();
                referencesExpanded = true;
                setAuxPanelVisibility({ references: true }, "references");
              }}>タグ参照一覧を開く</button
            >
            <p class="hint">
              {references.length
                ? "Project 内の割り当てと使用先を確認します。"
                : "表示タグの割り当てはありません。"}
            </p>
          </TreeSection>
          <TreeSection label="シンボル" count={project.symbols.length}>
            <SymbolLibrary
              {project}
              selectedId={libraryId}
              workspaceKey={workspaceGeneration}
              onopenusage={openSymbolUsage}
              screenId={screen.id}
              editingDefinition={!!activeDefinition}
              contextKey={`${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}:${mode}:${busy}:${!!drafts.pending}:${!!replacement}`}
              onchoose={(id) => (libraryId = id)}
              onedit={openDefinition}
              ondelete={deleteDefinition}
              oncommand={symbolLibraryCommand}
            />
          </TreeSection>
          <TreeSection label="プロジェクト設定">
            {#key `${workspaceGeneration}:${project.manifest.projectId}`}
              <form
                use:drafts.track={{ name: project.manifest.name }}
                data-editor-form="project"
                aria-label="プロジェクト情報"
                onsubmit={submitForm}
                oncompositionstart={(event) =>
                  composingForms.add(event.currentTarget)}
                oncompositionend={(event) =>
                  composingForms.delete(event.currentTarget)}
              >
                <label
                  >プロジェクト名<input
                    onkeydown={nameFormKey}
                    name="name"
                    required
                    maxlength="200"
                  /></label
                >
                <button type="submit">プロジェクト名を適用</button>
              </form>
            {/key}
            <h2>{activeDefinition ? "Symbol 設定" : "画面管理"}</h2>
            {#if !activeDefinition}
              <button
                disabled={project.screens.length >= 100}
                onclick={() =>
                  edit({
                    type: "create-screen",
                    name: `画面 ${project.screens.length + 1}`,
                    width: screen.width,
                    height: screen.height,
                  })}>画面を追加</button
              >
              <button
                disabled={project.screens.length >= 100}
                onclick={() =>
                  edit({ type: "duplicate-screen", screenId: screen.id })}
                >画面を複製</button
              >
              <div class="actions" role="group" aria-label="画面の並び順">
                <button
                  disabled={project.screens[0].id === screen.id}
                  onclick={() =>
                    edit({
                      type: "reorder-screen",
                      screenId: screen.id,
                      direction: "up",
                    })}>画面を上へ</button
                >
                <button
                  disabled={project.screens.at(-1)?.id === screen.id}
                  onclick={() =>
                    edit({
                      type: "reorder-screen",
                      screenId: screen.id,
                      direction: "down",
                    })}>画面を下へ</button
                >
              </div>
              <p>画面順は JSON に保存され、読込時は先頭の画面を開きます。</p>
              <button
                disabled={project.screens.length === 1}
                onclick={() => removeScreen(screen.id)}>画面を削除</button
              >
            {/if}
            {#key screen}
              <form
                use:drafts.track
                data-editor-form="screen"
                oncompositionstart={(event) =>
                  composingForms.add(event.currentTarget)}
                oncompositionend={(event) =>
                  composingForms.delete(event.currentTarget)}
                onsubmit={screenProperties}
                aria-label="画面設定"
              >
                <label
                  >{activeDefinition ? "Symbol 名" : "画面名"}<input
                    onkeydown={nameFormKey}
                    name="name"
                    value={screen.name}
                    required
                    maxlength="200"
                  /></label
                >
                <label
                  >{activeDefinition ? "定義の幅" : "画面の幅"}<input
                    name="width"
                    type="number"
                    step="any"
                    min="1"
                    value={screen.width}
                    required
                  /></label
                >
                <label
                  >{activeDefinition ? "定義の高さ" : "画面の高さ"}<input
                    name="height"
                    type="number"
                    step="any"
                    min="1"
                    value={screen.height}
                    required
                  /></label
                >
                {#if !activeDefinition}
                  <label
                    >画面の背景色<input
                      name="background"
                      type="color"
                      value={"background" in screen
                        ? screen.background
                        : "#ffffff"}
                      required
                    /></label
                  >
                  <p class="hint">アプリのテーマと図形の色は変わりません。</p>
                {/if}
                <button type="submit"
                  >{activeDefinition
                    ? "Symbol 設定を適用"
                    : "画面設定を適用"}</button
                >
              </form>
            {/key}
            <p class="hint">
              サイズ変更は表示領域のみを変更します。図形の位置・サイズは変わりません。
            </p>
          </TreeSection>
        {/if}
      {/snippet}
      {#snippet layersPanel()}
        {#if mode === "edit"}
          <div
            class="layer-browser"
            use:layerDropSurface={{
              accepts: acceptsLayerDrag,
              active: () =>
                !!layerDrag &&
                !editBlocked &&
                !layerDragError(screen, folderScope, layerDrag),
              allowed: (destination) =>
                !!layerDrag &&
                !layerDropError(screen, folderScope, layerDrag, destination),
              hover: (target) => {
                layerDropTarget = target;
                layerDragGuide = layerDrag;
              },
              drop: dropLayer,
              end: endLayerDrag,
            }}
          >
            <div class="layer-search-row">
              <input
                class="layer-search"
                type="search"
                aria-label="レイヤーを検索"
                placeholder="検索"
                bind:value={layerQuery}
                oninput={() => (layersExpanded = true)}
              />
              <button
                data-create-layer-folder
                title="ルートにフォルダーを作成"
                aria-label="ルートにフォルダーを作成"
                disabled={editBlocked || screen.folders.length >= 256}
                onclick={(event) =>
                  openFolderRequest("create", undefined, event.currentTarget)}
                ><svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  aria-hidden="true"
                  ><path d="M3 7V5h7l2 3h9v12H3V7M12 11v6M9 14h6" /></svg
                ></button
              >
            </div>
            {#if layerQuery.trim()}<p class="layer-query-status">
                検索結果を展開中 <button onclick={() => (layerQuery = "")}
                  >検索を解除</button
                >
              </p>{/if}
            {#if layerDragGuide}
              <div class="layer-drag-guide">
                {#if layerDragGuide.kind === "folder"}
                  <p class="layer-caption" title={layerDragDescription}>
                    フォルダー「{layerDragGuide.name}」と配下を移動
                  </p>
                  <p class="layer-caption">
                    配置 {layerDragGuide.count} 件・非表示 {layerDragGuide.hidden}
                    件
                  </p>
                  <p
                    class="layer-caption"
                    role="status"
                    title={layerDragDescription}
                  >
                    {layerDropTargetError ??
                      (layerDropTarget === null
                        ? "フォルダーへドロップ"
                        : layerDropTarget
                          ? `${folderPath(screen.folders, layerDropTarget)} 直下へ`
                          : "ルートへ移動")}
                  </p>
                {:else}
                  <p
                    class="layer-caption"
                    role="status"
                    title={layerDragDescription}
                  >
                    {layerDragDescription}
                  </p>
                {/if}
                <div
                  class="layer-root-drop"
                  class:drop-hover={layerDropTarget === "" &&
                    !layerDropTargetError}
                  data-layer-drop-folder=""
                >
                  {layerDragGuide.kind === "folder"
                    ? "ルートへ移動（親フォルダーなし）"
                    : "フォルダーから外す（ルートへ）"}
                </div>
              </div>
            {:else}<p class="layer-caption">
                {selectedIds.length} 件選択{#if hiddenSelectionCount}（非表示 {hiddenSelectionCount}
                  件）{/if} · {screen.folders.length
                  ? "所属と描画順は独立"
                  : "下の配置ほど前面"}
              </p>{/if}
            <TreeSection
              label={screen.name}
              count={screen.objects.length}
              bind:open={layersExpanded}
            >
              {#if selectedIds.some((id) => !visibleLayers.some((object) => object.id === id))}
                <p class="hint" role="status">
                  選択中の配置は検索条件外です。選択とプロパティは保持しています。
                </p>
              {/if}
              <nav aria-label="図形一覧">
                {#each layerTreeView.rows as row (row.kind === "folder" ? row.folder.id : row.object.id)}
                  {#if row.kind === "folder"}
                    <div
                      class="layer-folder"
                      class:drop-hover={!!layerDrag &&
                        !layerDropTargetError &&
                        layerDropTarget === row.folder.id}
                      data-layer-drop-folder={row.folder.id}
                      style:margin-left={`${row.depth * 10}px`}
                    >
                      <button
                        data-layer-folder={row.folder.id}
                        aria-expanded={row.open}
                        title={folderPath(screen.folders, row.folder.id)}
                        onclick={(event) => {
                          if (
                            event.detail &&
                            performance.now() < layerDragClickUntil
                          )
                            return;
                          toggleFolder(row.folder.id);
                        }}
                        oncontextmenu={(event) => {
                          event.preventDefault();
                          showFolderMenu(row.folder.id, event.currentTarget);
                        }}
                        onkeydown={(event) => folderKey(event, row.folder.id)}
                      >
                        <span class="folder-chevron" aria-hidden="true"
                          >{row.open ? "⌄" : "›"}</span
                        >
                        <span
                          class="folder-drag-source"
                          role="img"
                          aria-label={row.folder.name}
                          draggable={!editBlocked}
                          data-folder-drag-source={row.folder.id}
                          ondragstart={(event) =>
                            beginFolderDrag(event, row.folder.id)}
                        >
                          <svg
                            width="19"
                            height="19"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            aria-hidden="true"
                            ><path
                              d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7h18"
                            /></svg
                          >
                          <span class="folder-name">{row.folder.name}</span
                          ></span
                        >
                      </button>
                      <button
                        class="folder-more"
                        data-layer-folder={row.folder.id}
                        aria-label={`フォルダー操作：${row.folder.name}`}
                        aria-haspopup="menu"
                        onclick={(event) =>
                          showFolderMenu(row.folder.id, event.currentTarget)}
                        onkeydown={(event) => folderKey(event, row.folder.id)}
                        >⋮</button
                      >
                    </div>
                  {:else}
                    {@const object = row.object}

                    <div
                      class="layer-entry"
                      style:margin-left={`${row.depth * 10}px`}
                      class:hidden-placement={object.visible === false}
                    >
                      <button
                        class:active={selectedIds.includes(object.id)}
                        aria-pressed={selectedIds.includes(object.id)}
                        data-layer-id={object.id}
                        draggable={!editBlocked}
                        ondragstart={(event) =>
                          beginLayerDrag(event, object.id)}
                        title={`${objectLabel(object)}
${object.shape.type} · ${object.order}
${object.id}`}
                        onclick={(event) => layerClick(event, object.id)}
                        oncontextmenu={(event) => {
                          event.preventDefault();
                          layerContext(object.id, event.currentTarget);
                        }}
                        onkeydown={(event) => layerContextKey(event, object.id)}
                        ><ObjectIcon
                          {object}
                          definition={object.shape.type === "symbol"
                            ? project.symbols.find(
                                (d) =>
                                  object.shape.type === "symbol" &&
                                  d.id === object.shape.symbolId,
                              )
                            : undefined}
                        /><span>{objectLabel(object)}</span></button
                      >
                      <button
                        class="layer-visible"
                        aria-label={`${object.visible === false ? "再表示" : "非表示"}：${objectLabel(object)}`}
                        aria-pressed={object.visible !== false}
                        title={object.visible === false
                          ? "図面に再表示"
                          : "図面から非表示（表示プレビューにも反映）"}
                        disabled={menuBlocked}
                        onclick={() => toggleObjectVisibility(object.id)}
                        ><svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.7"
                          aria-hidden="true"
                          ><path
                            d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"
                          /><circle
                            cx="12"
                            cy="12"
                            r="3"
                          />{#if object.visible === false}<path
                              d="M3 3l18 18"
                            />{/if}</svg
                        ></button
                      >
                      <button
                        class="layer-lock"
                        class:locked={!!object.locked}
                        aria-label={`${object.locked ? "ロック解除" : "ロック"}：${objectLabel(object)}`}
                        aria-pressed={!!object.locked}
                        title={object.locked
                          ? "編集ロックを解除"
                          : "配置の直接編集をロック（共有定義の変更は反映）"}
                        disabled={menuBlocked}
                        onclick={() => toggleObjectLock(object.id)}
                        ><svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.7"
                          aria-hidden="true"
                          ><rect
                            x="5"
                            y="10"
                            width="14"
                            height="11"
                            rx="2"
                          /><path
                            d={object.locked
                              ? "M8 10V7a4 4 0 0 1 8 0v3"
                              : "M8 10V7a4 4 0 0 1 8 0"}
                          /><path d="M12 14v4" /></svg
                        ></button
                      >
                      <button
                        class="layer-more"
                        aria-label={`操作：${objectLabel(object)}`}
                        title={`${objectLabel(object)} の操作`}
                        aria-haspopup="menu"
                        onclick={(event) =>
                          layerContext(object.id, event.currentTarget)}
                        onkeydown={(event) => layerContextKey(event, object.id)}
                        >⋮</button
                      >
                    </div>
                  {/if}
                {/each}
              </nav>
              {#if !layerTreeView.rows.length}<p class="hint">
                  {layerQuery.trim()
                    ? "一致する配置はありません。"
                    : "配置はありません。"}
                </p>{/if}
            </TreeSection>
          </div>
        {/if}
      {/snippet}
      {#snippet partsPanel()}
        {#if mode === "edit"}
          <PartPalette
            {isFavorite}
            {positionPlacement}
            {isArmed}
            onarm={armPart}
            onimmediate={placeFavorite}
            ontoggleFavorite={toggleFavorite}
            contextKey={`${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}`}
            onedit={openDefinition}
            onduplicate={(id) =>
              edit({ type: "duplicate-symbol", symbolId: id })}
            definitions={project.symbols}
            allowSymbols={!activeDefinition}
            onadd={(kind) => choosePart({ type: "basic", kind })}
            onstartdrag={beginPartDrag}
            onenddrag={() => (paletteDrag = null)}
            onbuiltin={(template) => choosePart({ type: "builtin", template })}
            onplace={(id) => choosePart({ type: "symbol", symbolId: id })}
          />
        {/if}
      {/snippet}
    </DesignerSidebar>
  </aside>
  <section aria-label="画面プレビュー" bind:this={editorRegion}>
    {#if activeDefinition}
      <div class="definition-banner" role="note">
        <strong
          >Symbol 定義を編集中 · {symbolUsage(project, activeDefinition.id)} 配置で共有</strong
        >
        <p>
          確定した形状は全画面の参照配置へ反映されます。図形ごとの配色は「共有定義の色」の配置へ反映し、「配置の単色」は配置色を維持します。別の形にする場合は定義を複製してください。
        </p>
        {#if symbolStrokeOverflow > 0}<p role="status">
            枠線が表示領域外へ出ている図形が{symbolStrokeOverflow}件あります。配置では領域外が切れます。図形の位置・寸法または定義の表示領域を変更してください。
          </p>{/if}

        <button
          onclick={() =>
            transition(() => {
              editingSymbolId = null;
              selectedIds = [];
            })}>画面へ戻る</button
        >
      </div>
    {/if}
    <div class="toolbar" class:ruler-offset={mode === "edit" && showRulers}>
      <h2>{screen.name}</h2>
      <span
        >{activeDefinition ? "SYMBOL" : "SCREEN"} · {screen.width} × {screen.height}
        · {screen.objects.length} 図形 · rev {project.manifest
          .projectRevision}</span
      >
    </div>
    <div class="canvas-stack" bind:clientHeight={canvasStackHeight}>
      {#key workspaceGeneration}
        <CanvasWorkspace
          bind:this={canvasWorkspace}
          onviewchange={(view) => (canvasView = view)}
          oncontextrequest={requestSelectionContext}
          {screen}
          symbols={project.symbols}
          editable={mode === "edit"}
          {selectedIds}
          {showGrid}
          {showRulers}
          {snapEnabled}
          {gridSize}
          placing={positionPlacement}
          placeReady={!!armedPart}
          onplacepoint={placeArmed}
          oncancelplacement={() => stopPlacement(true)}
          {canDropPart}
          ondropPart={dropPalettePart}
          onresize={(id, geometry) =>
            edit({
              type: "update",
              screenId: screen.id,
              objectId: id,
              patch: geometry,
            })}
          onvertexmove={(id, index, point) =>
            edit({
              type: "move-vertex",
              screenId: screen.id,
              objectId: id,
              index,
              point,
            })}
          onbeforeedit={() => drafts.allow(() => {})}
          onselect={selectCanvasObjects}
          onrangeselect={selectRange}
          onnudge={nudgeSelection}
          onmove={(ids, dx, dy) =>
            edit({
              type: "move-many",
              screenId: screen.id,
              objectIds: ids,
              dx,
              dy,
            })}
        />
      {/key}
      {#if mode === "edit" && positionPlacement}
        <div class="placement-bar" role="status" aria-label="連続配置の状態">
          <span
            >{armedPart
              ? `${armedLabel}を連続配置 · キャンバスをクリック／Enterで中央へ配置`
              : "連続配置 · 部品を選んでください"}</span
          >
          <button onclick={() => stopPlacement(true)}
            >配置を終了 <kbd>Esc</kbd></button
          >
        </div>
      {/if}
      {#if mode === "edit" && (showSidebar || showInspector || showReferences)}
        <div class="canvas-navigation" class:has-map={showMinimap}>
          <FavoritesDock
            items={favoriteItems}
            {positionPlacement}
            {isArmed}
            onarm={armPart}
            onimmediate={placeFavorite}
            contextKey={`${contextScope}:${favoriteKeys.join(",")}`}
            onplace={choosePart}
            onremove={toggleFavorite}
            onbrowse={browseParts}
            onstartdrag={beginPartDrag}
            onenddrag={() => (paletteDrag = null)}
          />
          {#if showMinimap}
            {#key `${workspaceGeneration}:${screen.id}`}
              <Minimap
                {screen}
                symbols={project.symbols}
                view={canvasView}
                oncenter={(point) => canvasWorkspace?.centerOn(point)}
                onfit={() => canvasWorkspace?.zoom(null)}
              />
            {/key}
          {/if}
        </div>
      {/if}
      <p role="status" data-testid="project-status">{message}</p>
      {#if mode === "edit"}
        <div
          hidden={!showReferences}
          id="designer-references-panel"
          class="references-panel"
          style:height={canSizeReferences &&
          referencesExpanded &&
          references.length
            ? `${displayedReferenceHeight}px`
            : undefined}
          bind:this={referencesPanel}
          tabindex="-1"
          role="region"
          aria-label="タグ参照パネル"
        >
          {#if showReferences && references.length && referencesExpanded && canSizeReferences}
            <PanelResizeHandle
              bind:this={bottomResizer}
              side="bottom"
              value={displayedReferenceHeight}
              min={MIN_REFERENCE_HEIGHT}
              max={referenceMaximum}
              standard={DEFAULT_REFERENCE_HEIGHT}
              onstart={beginReferenceResize}
              onchange={(height) => (referenceHeight = height)}
              onend={finishReferenceResize}
              canCommit={() =>
                window.innerWidth >= 1100 &&
                (referencesPanel?.parentElement?.clientHeight ?? 0) >= 500}
            />
          {/if}
          {#key workspaceGeneration}
            <BindingReferences
              bind:expanded={referencesExpanded}
              sized={canSizeReferences && referencesExpanded}
              onbeforetoggle={() => canvasWorkspace?.preparePanelResize(true)}
              onaftertoggle={() => canvasWorkspace?.finishPanelResize()}
              {references}
              onopen={openBinding}
              onclose={() =>
                setAuxPanelVisibility({ references: false }, "references")}
            />
          {/key}
        </div>
      {/if}
    </div>
  </section>
  {#if mode === "edit"}
    <InspectorPanel
      bind:this={inspectorController}
      bind:element={inspectorPanel}
      generation={workspaceGeneration}
      {commitNumber}
      visible={showInspector}
      onclose={() => setInspectorVisibility(false, true)}
      {project}
      {selectedIds}
      {selected}
      {selectionLocked}
      {hiddenSelectionCount}
      ontogglevisibility={toggleObjectVisibility}
      ontogglelock={toggleObjectLock}
      activeDefinition={!!activeDefinition}
      {screen}
      {drafts}
      {properties}
      {moveSelection}
      {edit}
      {openDefinition}
    />
  {/if}
  {#if mode === "edit" && windowWidth >= 1100}
    {#if showSidebar}
      <PanelResizeHandle
        bind:this={leftResizer}
        side="left"
        value={leftWidth}
        min={PANEL_WIDTH_LIMITS.left.min}
        max={panelWidthMaximum("left", windowWidth)}
        standard={DEFAULT_PANEL_WIDTHS.left}
        onstart={beginPanelResize}
        onchange={(width) => changePanelWidth("left", width)}
        onend={finishPanelResize}
        canCommit={() => window.innerWidth >= 1100}
      />
    {/if}
    {#if showInspector}
      <PanelResizeHandle
        bind:this={rightResizer}
        side="right"
        value={rightWidth}
        min={PANEL_WIDTH_LIMITS.right.min}
        max={panelWidthMaximum("right", windowWidth)}
        standard={DEFAULT_PANEL_WIDTHS.right}
        onstart={beginPanelResize}
        onchange={(width) => changePanelWidth("right", width)}
        onend={finishPanelResize}
        canCommit={() => window.innerWidth >= 1100}
      />
    {/if}
  {/if}
</main>
<ContextActions
  floating
  bind:this={selectionMenu}
  label={selectionContextLabel}
  contextKey={contextScope}
  items={selectionContextItems}
/>
<ContextActions
  floating
  bind:this={folderMenu}
  label="フォルダー"
  contextKey={`${folderScope}:${contextFolderId}:${project.manifest.projectRevision}:${layerQuery}:${mode}:${activePanel}:${showSidebar}`}
  items={folderContextItems}
/>
{#if folderRequest}
  {#key folderRequest}
    <FolderDialog
      owner={screen}
      {project}
      request={folderRequest}
      onapply={applyFolderCommand}
      onclose={closeFolderRequest}
    />
  {/key}
{/if}
<DraftPrompt guard={drafts} />
<Modal
  open={helpOpen}
  title="操作ガイド・アプリ情報"
  onclose={() => (helpOpen = false)}
>
  <p>SCADA Designer 0.15.0 · Banto 基盤のローカル工程図エディタ</p>
  <p>
    左で画面・部品を選び、図形をクリックして右のプロパティで編集します。未適用の入力は「変更を適用」で確定し、Project
    JSON を保存してください。
  </p>
  <p>
    キャンバス本体にフォーカスがあるときは、方向キーで選択した配置を1 design
    unit、Shift併用で10
    unit動かします。スナップONでは次のグリッド線へ進み、Shift併用は10段階です。長押しは各キー入力が1回のUndoになります。未選択時はスクロールし、サイズ・頂点ハンドルでは専用のキー操作を使います。
  </p>
  <p>
    選択ツールで空白をドラッグすると、枠に完全に入る図形をまとめて選択します。Shiftで追加、Escで取消できます。パン・連続配置・表示プレビューでは範囲選択しません。
  </p>
  <p>
    キャンバスはホイールで縦スクロール、Shift＋ホイールで横スクロールします。編集キャンバス上のCtrl＋ホイールはポインタ位置を基準に拡大縮小します。Ctrl＋＋／－／0のキー操作はブラウザのページ倍率です。
  </p>
  <p>
    レイヤーのフォルダーは整理用で、座標・描画順・表示・ロックを継承しません。検索中は結果を一時展開し、解除すると開閉状態を戻します。配置の右クリック「配置の所属を変更」で移動先・ルートを選べます。新規配置と貼り付けは常にルートです。フォルダー行のF2は改名、Deleteは空削除の確認を開き、以前の配置選択を変更しません。
  </p>
  <p>
    「中心を水平方向／垂直方向に等間隔」は3件以上で使えます。両端の中心を固定し、中間の配置だけを動かします。図形間の隙間を揃える操作ではありません。スナップで丸めず、小数座標も保存します。サイズが違う配置では重なりが残る場合があります。
  </p>
  <p>
    レイヤーの錠アイコンで配置の編集をロックします。ロック中はキャンバスの選択・移動やプロパティ変更を防ぎ、レイヤーで選択してコピー・解除できます。ロックは権限ではなく、参照する共有定義の変更・Undo／Redo・画面全体の管理は引き続き反映されます。コピー・貼り付けはロック状態を保持します。
  </p>
  <p>
    レイヤーの目のアイコンは図面の静的な表示設定です。表示プレビュー・共有定義・ミニマップにも反映します。非表示の配置はレイヤーから選択・再表示できます。キャンバスから見えない配置の移動・削除・切り取りは防ぎ、プロパティやレイヤーで対象を確認した明示操作は許可します。
  </p>
  <p>
    Ctrl / Command + N：新しいProject、O：JSONを開く、S／Shift +
    S：JSON書き出し（ダウンロード）。ブラウザによってN／Oが予約されている場合は「ファイル」メニューを使ってください。保存先の選択・既存ファイルへの上書きには未対応です。
  </p>
  <p>
    F2：フォーカス中の画面行・画面タブ、レイヤー行、またはキャンバスの単一選択から名前欄へ移動します。変更は適用するまで未確定です。F1：この操作ガイドを開きます。Project名は「ファイル」→「プロジェクト名を変更」から編集できます。
  </p>
  <p>
    Ctrl / Command + Z：元に戻す、Shift +
    Z：やり直す、A：全選択、D：複製。キャンバス・レイヤーの配置一覧ではC：コピー、X：切り取り、V：貼り付け、Delete：削除も使えます。入力欄では文字編集を優先します。コピー操作はOSクリップボードを使い、ブラウザから許可を求められる場合があります。
  </p>
  <p>
    メニューバーは左右キー、項目は上下キー、Enter / Space で実行、Esc
    で閉じます。メニューバー・左パネル・プロパティ・タグ参照一覧は、上部の「メニュー」→「表示」から隠す／復元できます。
    「補助パネルをすべて隠す」からは直前の表示に戻せます。個別の表示切替を行うと、一時的な一括非表示を終了します。
    「標準レイアウトに戻す」は左右幅・タグ参照高さと各パネル・メニューバー・ミニマップ・ルーラーの表示を戻します。タブ・ツリーの開閉・検索・未適用入力・選択・テーマ・お気に入りは保持し、Projectや履歴を変更しません。
  </p>
  <p>
    表示プレビューは見た目の確認用です。Hub・設備との接続、認証、正式 Runtime
    は未実装です。
  </p>
  <button onclick={() => (helpOpen = false)}>閉じる</button>
</Modal>
<Modal
  open={replacement !== null}
  title="Project を置き換えますか"
  onclose={() => (replacement = null)}
>
  <p>
    {#if projectChanged}
      現在の Project に未書き出しの変更があります。
    {:else}
      現在の内容の書き出しを要求しました。
    {/if}
    「{replacement?.project.manifest
      .name}」を開く前に、書き出したファイルを確認してください。
  </p>
  <p>
    書き出しても自動では置き換えません。ファイルを確認してから「破棄して開く」を選んでください。
  </p>
  <div class="actions">
    <button onclick={writeJson}>JSON を書き出す</button><button
      onclick={replaceNow}>破棄して開く</button
    ><button onclick={() => (replacement = null)}>キャンセル</button>
  </div>
</Modal>
<ToastHost store={toastStore} />

<style>
  nav[aria-label="図形一覧"] {
    overflow-x: auto;
  }
  .layer-search-row {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-bottom: 6px;
  }
  .layer-search-row .layer-search {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .layer-search-row > button {
    display: grid;
    place-items: center;
    width: 30px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--banto-primary);
  }
  .layer-query-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    font-size: 11px;
    color: var(--banto-text-muted);
  }
  .layer-query-status button {
    padding: 2px 4px;
    margin: 0;
    border: 0;
    background: transparent;
    color: var(--banto-primary);
    font-size: inherit;
  }
  .layer-drag-guide {
    position: sticky;
    top: -10px;
    z-index: 2;
    background: var(--banto-surface);
    padding: 2px 0 6px;
  }
  .layer-drag-guide .layer-caption {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .layer-root-drop {
    padding: 9px 6px;
    border: 1px dashed var(--banto-border);
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  .layer-root-drop.drop-hover,
  .layer-folder.drop-hover {
    background: color-mix(
      in srgb,
      var(--banto-primary) 12%,
      var(--banto-surface)
    );
    outline: 2px solid var(--banto-primary);
    outline-offset: -2px;
  }
  .layer-folder {
    position: relative;
    min-width: 150px;
  }
  .layer-folder > button:first-child {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 36px;
    padding: 7px 28px 7px 0;
    margin: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
    text-align: left;
    font-size: 12px;
    font-weight: 600;
  }
  .layer-folder > button:first-child:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .layer-folder svg,
  .folder-chevron {
    flex-shrink: 0;
    color: var(--banto-text-muted);
  }
  .folder-chevron {
    width: 12px;
    text-align: center;
  }
  .folder-drag-source {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
    cursor: grab;
  }
  .folder-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder-more {
    position: absolute;
    right: 2px;
    top: 3px;
    width: 24px;
    height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    opacity: 0;
  }
  .layer-folder:hover .folder-more,
  .layer-folder:focus-within .folder-more {
    opacity: 1;
  }
  .layer-folder button:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  @media (hover: none) {
    .folder-more {
      opacity: 1;
    }
  }

  .canvas-navigation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    padding-right: 8px;
  }
  .canvas-navigation > :global(.favorites-dock) {
    margin-left: auto;
    margin-right: auto;
    max-width: calc(100% - 24px);
  }
  .canvas-navigation.has-map > :global(.favorites-dock) {
    max-width: calc(100% - 160px);
  }

  :global(#app) {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }
  :global(body) {
    margin: 0;
    background: var(--banto-bg);
    color: var(--banto-text);
    font-family: var(--banto-font-family);
  }
  :global(*) {
    box-sizing: border-box;
  }
  .project-sidebar {
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: hidden;
  }
  .project-root {
    padding: 14px 4px 8px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .project-root > span {
    color: var(--banto-primary);
    margin-right: 6px;
  }
  .layer-search {
    width: 100%;
    margin-bottom: 6px;
    padding: 8px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
    font-size: 12px;
  }
  .layer-search:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .screen-icon {
    color: var(--banto-text-muted);
    margin-right: 8px;
    vertical-align: middle;
  }
  .screen-row {
    width: 100%;
    padding-right: 24px;
    overflow-wrap: anywhere;
  }
  .layer-entry {
    position: relative;
  }
  .layer-entry > button:first-child {
    padding-right: 78px;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    min-height: 36px;
    width: 100%;
    overflow-wrap: anywhere;
  }
  .layer-entry > button:first-child span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-entry.hidden-placement > button:first-child {
    opacity: 0.6;
  }
  .layer-entry .layer-visible {
    display: grid;
    place-items: center;
    position: absolute;
    right: 52px;
    top: 4px;
    width: 24px;
    min-height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
  }
  .layer-entry .layer-lock {
    display: grid;
    place-items: center;
    position: absolute;
    right: 26px;
    top: 4px;
    width: 24px;
    min-height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    font-size: 12px;
    opacity: 0;
  }
  .layer-entry .layer-lock.locked,
  .layer-entry:hover .layer-lock,
  .layer-entry:focus-within .layer-lock {
    opacity: 1;
  }
  .layer-entry .layer-more {
    position: absolute;
    right: 3px;
    top: 3px;
    border: 0;
    background: transparent;
    width: 22px;
    height: 28px;
    padding: 0;
    margin: 0;
    opacity: 0;
  }
  .layer-entry:hover .layer-more,
  .layer-entry:focus-within .layer-more {
    opacity: 1;
  }
  @media (hover: none) {
    .layer-entry .layer-lock,
    .layer-entry .layer-more {
      opacity: 1;
    }
  }
  .screen-row,
  .layer-entry > button:first-child {
    margin: 0;
    padding: 7px 26px 7px 8px;
    min-height: 36px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
  }
  .layer-entry > button:first-child {
    padding-right: 78px;
  }
  .screen-row:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .screen-row.active {
    background: color-mix(in srgb, var(--banto-primary) 13%, transparent);
    color: var(--banto-text);
  }
  .layer-entry > button:first-child:hover {
    background: color-mix(in srgb, #14b8a6 8%, transparent);
  }
  .layer-entry > button:first-child.active {
    background: color-mix(in srgb, #14b8a6 18%, transparent);
  }
  .screen-row:focus-visible,
  .layer-entry > button:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
  }
  .layer-caption {
    margin: 4px 2px 10px;
    font-size: 11px;
  }
  .project-sidebar .reference-link {
    margin: 0;
    border: 0;
    background: transparent;
    padding: 7px 8px;
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .project-sidebar .reference-link:enabled:hover {
    color: var(--banto-primary);
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .placement-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 4px 12px;
    color: var(--banto-text);
    background: var(--studio-selection);
    font-size: 12px;
    flex-shrink: 0;
  }
  .placement-bar span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .placement-bar button {
    width: auto;
    margin: 0;
    padding: 3px 7px;
    font-size: 11px;
    background: transparent;
    border: 0;
  }
  .placement-bar kbd {
    margin-left: 4px;
    color: var(--banto-text-muted);
  }
  .save-state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--banto-text-muted);
    margin-left: auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .app-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 12px;
    min-height: 40px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--banto-border);
    background: var(--banto-surface);
  }
  .app-header h1 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .header-actions button {
    width: auto;
    margin: 0;
    min-height: 28px;
    padding: 4px 8px;
    font-size: 12px;
  }
  .header-actions .theme-icon {
    width: 30px;
    display: grid;
    place-items: center;
  }
  .theme-icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mode-tools {
    display: flex;
    align-items: center;
    gap: 2px;
    border-right: 1px solid var(--banto-border);
    padding-right: 6px;
    margin-right: 2px;
  }
  .mode-tools button {
    width: auto;
    margin: 0;
    padding: 5px 8px;
    height: 30px;
    font-size: 12px;
    white-space: nowrap;
  }
  .definition-banner {
    border: 1px solid var(--banto-primary);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    background: var(--banto-surface);
  }
  .definition-banner button {
    width: auto;
    margin-bottom: 0;
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  .actions {
    flex-wrap: wrap;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .actions button {
    width: auto;
    white-space: nowrap;
  }
  h2 {
    font-size: 15px;
    margin: 0;
  }
  main {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  main.sidebar-visible {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  [hidden] {
    display: none;
  }
  .sidebar-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    border-bottom: 1px solid var(--banto-border);
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .sidebar-heading button {
    width: 28px;
    margin: 0;
    padding: 2px;
    font-size: 18px;
  }
  aside {
    padding: 16px;
    border-right: 1px solid var(--banto-border);
  }
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    margin: 8px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .active {
    border-color: var(--banto-primary);
    color: var(--banto-primary);
  }
  .hint {
    margin-top: 12px;
  }
  section {
    padding: 24px;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .toolbar span {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  section p {
    overflow-wrap: anywhere;
  }
  .project-sidebar form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .project-sidebar form label {
    display: grid;
    gap: 5px;
    font-size: 12px;
    color: var(--banto-text-muted);
    min-width: 0;
  }
  .project-sidebar form label:first-child,
  .project-sidebar form button {
    grid-column: 1 / -1;
  }
  .project-sidebar form input {
    width: 100%;
    min-width: 0;
    padding: 7px;
    border-radius: 4px;
    border: 1px solid var(--banto-border);
    background: var(--banto-bg);
    color: var(--banto-text);
  }
  .references-panel {
    position: relative;
  }
  .toolbar {
    align-items: center;
    gap: 12px;
  }
  .toolbar span {
    text-align: right;
  }
  @media (min-width: 1100px) {
    :global(#app) {
      height: 100dvh;
      overflow: hidden;
    }
    main.editing.sidebar-visible {
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    }
    main.editing.inspector-visible {
      grid-template-columns: minmax(0, 1fr) var(--inspector-width);
    }
    main.editing.sidebar-visible.inspector-visible {
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(
          --inspector-width
        );
    }
    main > aside,
    main > section {
      overflow: auto;
      min-height: 0;
    }
    main > section {
      display: flex;
      flex-direction: column;
      padding: 12px 16px;
    }
    main > section > :not(.canvas-stack),
    .canvas-stack > :not(:global(.canvas-workspace)) {
      flex-shrink: 0;
    }
    .canvas-stack {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
  }
  @media (min-width: 701px) and (max-width: 1099px) {
    .project-sidebar {
      grid-row: span 2;
    }
  }
  @media (max-width: 700px) {
    main,
    main.sidebar-visible {
      grid-template-columns: 1fr;
    }
    aside {
      border-right: 0;
      border-bottom: 1px solid var(--banto-border);
    }
  }
</style>
