<script lang="ts">
  import {
    groupsOf,
    groupFor,
    selectedGroup as findSelectedGroup,
    expandGroupSelection,
    canvasSelectionIds,
    selectionUnits,
  } from "./lib/geometric-groups";
  import EquipmentLibrary from "./lib/designer/EquipmentLibrary.svelte";
  import SymbolSlots from "./lib/designer/SymbolSlots.svelte";
  import {
    symbolSlotFormCommand,
    acknowledgeSymbolSlotForm,
  } from "./lib/designer/forms/symbol-slot";
  import { equipmentTypeFormCommand } from "./lib/designer/forms/equipment-type";
  import { equipmentFormCommand } from "./lib/designer/forms/equipment";
  import { groupNameFormCommand } from "./lib/designer/forms/group-name";
  import { createDesignerActions } from "./lib/designer/controllers/designer-actions";
  import { createClipboardController } from "./lib/designer/controllers/clipboard.svelte";
  import { createImageImportController } from "./lib/designer/controllers/image-import.svelte";
  import { imageCropCommand } from "./lib/designer/forms/image-crop";
  import {
    selectionOutlineCommand,
    acknowledgeSelectionOutline,
  } from "./lib/designer/forms/selection-outline";
  import {
    selectionLineCommand,
    acknowledgeSelectionLine,
  } from "./lib/designer/forms/selection-line";
  import {
    selectionColorCommand,
    acknowledgeSelectionColor,
  } from "./lib/designer/forms/selection-color";
  import { stateColorCommand } from "./lib/designer/forms/state-color";
  import SlotReadStatus from "./lib/designer/SlotReadStatus.svelte";
  import { boolColorsCommand } from "./lib/designer/forms/bool-colors";
  import { symbolColorModeCommand } from "./lib/designer/forms/symbol-color-mode";
  import { backgroundImageCommand } from "./lib/designer/forms/background-image";
  import {
    objectFormCommand,
    acknowledgeObjectForm,
  } from "./lib/designer/forms/object-form";
  import { screenFormCommand } from "./lib/designer/forms/screen-form";
  import {
    projectFormCommand,
    acknowledgeProjectForm,
  } from "./lib/designer/forms/project-form";
  import { moveFormCommand } from "./lib/designer/forms/move-form";
  import { shapePaintCommand } from "./lib/designer/forms/shape-paint";
  import { initialImageFrame } from "./lib/image-frame";
  import { AssetStore } from "./lib/image-assets";
  import { createProjectFilesController } from "./lib/designer/controllers/project-files.svelte";
  import BackgroundImageSettings from "./lib/designer/BackgroundImageSettings.svelte";
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
  import DesignerMenubar from "./lib/designer/DesignerMenubar.svelte";
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
  import { normalizeRotation } from "./lib/rotation";
  import { parseNumericProperty } from "./lib/designer/numeric-properties";
  import { placementLabel } from "./lib/placement-label";
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
  import type { EquipmentUsage } from "./lib/equipment";
  import type { SymbolUsage } from "./lib/symbol-usages";
  import { selectionTarget } from "./lib/selection-view";
  import type { Project } from "./lib/project";
  import FolderDialog from "./lib/designer/FolderDialog.svelte";
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
  import { createLayerTreeController } from "./lib/designer/controllers/layer-tree.svelte";
  import LayerTree from "./lib/designer/LayerTree.svelte";
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
    if (
      ["screen", "project", "equipment", "equipment-type"].includes(
        form.dataset.editorForm ?? "",
      )
    ) {
      setAuxPanelVisibility({ sidebar: true });
      activePanel = "project";
    } else setInspectorVisibility(true);
  }
  import EditToolbar from "./lib/designer/EditToolbar.svelte";
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
  import PreviewFullscreen from "./lib/designer/PreviewFullscreen.svelte";
  import PreviewPopups from "./lib/designer/PreviewPopups.svelte";
  import ScreenViewDialog from "./lib/designer/ScreenViewDialog.svelte";
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
    type Point,
    type ScreenObject,
  } from "./lib/project";
  import {
    type EditCommand,
    applyCommand,
    newId,
    isObjectCommand,
    symbolUsage,
    type AddKind,
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
          '[role="dialog"]:not([aria-modal="false"]):not([data-layer-inactive="true"]),[popover]:popover-open',
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
        clipboard.busy ||
        drafts.pending ||
        replacement ||
        helpOpen ||
        inspectorController?.isTagPickerOpen() ||
        document.querySelector(
          '[role="dialog"]:not([aria-modal="false"]):not([data-layer-inactive="true"])',
        )
      )
        return;
      if (event.key === "F1") helpOpen = true;
      else if (mode === "edit" && !positionPlacement)
        renameFocused(event.target);
      return;
    }
    if (
      screenViewRequest !== null ||
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
          layerTreeBindings.openFolderRequest(
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
      !clipboard.busy &&
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
          '[role="dialog"]:not([aria-modal="false"]):not([data-layer-inactive="true"])',
        )
      )
        return;
      if (key === "n") projectFiles.newProject();
      else projectFiles.openProjectFile();
      return;
    }
    if (key === "s") {
      event.preventDefault();
      if (!busy && !event.repeat) projectFiles.save();
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
          (selectedIds = canvasSelectionIds(
            screen,
            screen.objects.map((object) => object.id),
          )),
      );
    } else if (key === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroupSelection();
      else groupSelection();
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
    const unit = expandGroupSelection(screen, [id]);
    selectedIds = additive
      ? unit.every((member) => selectedIds.includes(member))
        ? selectedIds.filter((member) => !unit.includes(member))
        : [...new Set([...selectedIds, ...unit])]
      : preserve && unit.every((member) => selectedIds.includes(member))
        ? selectedIds
        : unit;
    if (selectedIds.includes(id)) layerTreeBindings.revealLayerObject(id);
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
          expandGroupSelection(screen, [id]).includes(object.id) &&
          (object.locked || object.visible === false),
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
      const live = canvasSelectionIds(screen, ids);
      selectedIds = additive
        ? canvasSelectionIds(screen, [...new Set([...selectedIds, ...live])])
        : live;
      for (const id of live) layerTreeBindings.revealLayerObject(id);
    };
    if (drafts.allow(apply)) apply();
  }
  function groupSelection() {
    if (
      mutationBlocked ||
      activeDefinition ||
      containsGroups ||
      selectedIds.length < 2
    )
      return;
    transition(() =>
      edit({ type: "group", screenId: screen.id, objectIds: [...selectedIds] }),
    );
  }
  function ungroupSelection() {
    if (mutationBlocked || !activeGroup) return;
    transition(() => {
      if (activeGroup)
        edit({ type: "ungroup", screenId: screen.id, groupId: activeGroup.id });
    });
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
  const clipboard = createClipboardController({
    get owner() {
      return {
        generation: workspaceGeneration,
        screenId: screen.id,
        definitionId: activeDefinition?.id,
        mode,
        busy,
        replacing: !!replacement,
      };
    },
    get project() {
      return project;
    },
    get objects() {
      return screen.objects;
    },
    get selectedIds() {
      return selectedIds;
    },
    get draft() {
      return { pending: !!drafts.pending, dirty: drafts.dirty };
    },
    get viewport() {
      return {
        bounds: canvasView.bounds,
        size: { width: screen.width, height: screen.height },
        scale: canvasView.scale,
      };
    },
    get store() {
      return assetStore;
    },
    visibleCenter: () => canvasWorkspace?.visibleCenter(),
    hiddenCanvasMutation,
    allow: (run) => drafts.allow(run),
    edit,
    stopPlacement,
    collectAssets,
    prepareImage: (file, generation, owner, placement) =>
      imageImport.prepare(file, generation, owner, placement),
    report,
  });
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
  function nativeClipboard(event: ClipboardEvent) {
    if (clipboardScope(event.target))
      clipboard.action(event.type as "copy" | "cut" | "paste", event);
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
  let assetStore = $state.raw(new AssetStore());
  const assetImages = $derived(
    new Map(
      project.assets.map((asset) => [
        asset.id,
        {
          url: assetStore.url(asset.sha256),
          width: asset.width,
          height: asset.height,
        },
      ]),
    ),
  );
  function collectAssets() {
    const hashes = new Set(project.assets.map((asset) => asset.sha256));
    for (const snapshot of [...history.past, ...history.future])
      for (const asset of (JSON.parse(snapshot) as Project).assets)
        hashes.add(asset.sha256);
    assetStore.collect(hashes);
  }
  $effect(collectAssets);
  let replacementImageInput: HTMLInputElement;
  let placementFileInput: HTMLInputElement;
  const imageImport = createImageImportController({
    get owner() {
      return {
        generation: workspaceGeneration,
        screenId: screen.id,
        mode,
        definition: !!activeDefinition,
        busy,
        replacing: !!replacement,
      };
    },
    get selected() {
      return selected;
    },
    get selectedIds() {
      return selectedIds;
    },
    get viewport() {
      return {
        bounds: canvasView.bounds,
        size: { width: screen.width, height: screen.height },
      };
    },
    get store() {
      return assetStore;
    },
    assetByHash: (hash) =>
      project.assets.find((asset) => asset.sha256 === hash),
    background: (owner) =>
      project.screens.find((item) => item.id === owner)?.backgroundImage,
    chooseReplacement() {
      replacementImageInput.value = "";
      replacementImageInput.click();
    },
    choosePlacement() {
      placementFileInput.value = "";
      placementFileInput.click();
    },
    transition,
    allow: (run) => drafts.allow(run),
    edit,
    stopPlacement,
    collectAssets,
    revealObject: (id) => canvasWorkspace?.revealObject(id),
    report,
  });

  let editorRegion = $state<HTMLElement>();
  let previewFullscreenActive = $state(false);
  let previewPopups = $state<{
    showPicker: (origin: HTMLElement, kind?: "screen" | "equipment") => void;
    showEquipment: (id: string, origin: HTMLElement) => void;
  }>();
  let equipmentDetailsButton = $state<HTMLButtonElement>();
  let equipmentLibrary = $state<EquipmentLibrary>();
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
      selectedIds = expandGroupSelection(screen, [usage.objectId]);
      layerTreeBindings.revealLayerObject(usage.objectId);
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
  function openSymbolUsage(
    usage: SymbolUsage & { equipmentId?: string },
    sourceMode: "edit" | "preview" = "edit",
  ) {
    const generation = workspaceGeneration;
    const matchesUsage = () => {
      const target = project.screens
        .find((item) => item.id === usage.screenId)
        ?.objects.find((item) => item.id === usage.objectId);
      return (
        target?.shape.type === "symbol" &&
        target.shape.symbolId === usage.symbolId &&
        (usage.equipmentId === undefined ||
          target.shape.equipmentId === usage.equipmentId)
      );
    };
    const run = () => {
      if (generation !== workspaceGeneration || mode !== sourceMode) return;
      if (!drafts.allow(run)) return;
      if (!matchesUsage()) {
        report("info", "使用先が変更されたため移動を中止しました。");
        return;
      }
      mode = "edit";
      editingSymbolId = null;
      screenId = usage.screenId;
      const targetIds = expandGroupSelection(screen, [usage.objectId]);
      selectedIds = targetIds;
      libraryId = usage.symbolId;
      void tick().then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (
              generation !== workspaceGeneration ||
              mode !== "edit" ||
              !matchesUsage() ||
              screenId !== usage.screenId ||
              editingSymbolId ||
              selectedIds.length !== targetIds.length ||
              targetIds.some((id) => !selectedIds.includes(id))
            )
              return;
            editorRegion?.scrollTo({ top: 0 });
            layerTreeBindings.revealLayerObject(usage.objectId);
            canvasWorkspace?.revealObject(usage.objectId);
          }),
        ),
      );
    };
    run();
  }
  function openPreviewEquipmentUsage(usage: EquipmentUsage) {
    if (menuBlocked || mode !== "preview") return;
    openSymbolUsage(usage, "preview");
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
  const activeGroup = $derived(findSelectedGroup(screen, selectedIds));
  const containsGroups = $derived(
    selectedIds.some((id) => groupFor(screen, id)),
  );
  const backgroundScreen = $derived(
    project.screens.find((item) => item.id === screen.id),
  );
  let message = $state("サンプルを表示しています。Hub には接続していません。");
  const projectFiles = createProjectFilesController({
    get project() {
      return project;
    },
    get generation() {
      return workspaceGeneration;
    },
    get store() {
      return assetStore;
    },
    get draftPending() {
      return !!drafts.pending;
    },
    chooseFile: () => projectFileInput?.click(),
    allow: (run) => drafts.allow(run),
    adopt,
    report,
  });
  const busy = $derived(projectFiles.busy);
  const projectChanged = $derived(projectFiles.projectChanged);
  const replacement = $derived(projectFiles.replacement);
  const saveLabel = $derived(projectFiles.saveLabel);
  const lastExport = $derived(projectFiles.lastExport);
  function adopt(
    next: Project,
    source: "sample" | "file" | "new",
    store = new AssetStore(),
  ) {
    const previousStore = assetStore;
    assetStore = store;
    previousStore.dispose();
    project = next;
    projectFiles.adopted(next, source);
    history = emptyHistory();
    referencesExpanded = false;
    layerTreeBindings.resetPresentation();
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
  function showProcessSample() {
    projectFiles.requestReplacement(
      parseProject(JSON.stringify(processSample)),
      "sample",
    );
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
    if (mutationBlocked) return;
    if (activeGroup && (delta === 90 || delta === -90)) {
      transition(() =>
        edit({
          type: "rotate-groups",
          screenId: screen.id,
          objectIds: [...selectedIds],
          delta,
        }),
      );
      return;
    }
    if (!selectedId) return;
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
    if (form.dataset.editorForm === "symbol-slot")
      acknowledgeSymbolSlotForm(form);
    if (
      ["equipment", "equipment-type"].includes(form.dataset.editorForm ?? "")
    ) {
      for (const name of ["code", "name"]) {
        const input = form.querySelector<HTMLInputElement>(
          `input[name="${name}"]`,
        );
        if (input) input.value = input.value.trim();
      }
    }
    if (form.dataset.editorForm === "group-name") {
      const input = form.querySelector<HTMLInputElement>('input[name="name"]');
      if (input) input.value = activeGroup?.name ?? "";
    }
    if (form.dataset.editorForm === "selection-outline")
      acknowledgeSelectionOutline(form);

    if (form.dataset.editorForm === "selection-line")
      acknowledgeSelectionLine(form);
    if (form.dataset.editorForm === "selection-color")
      acknowledgeSelectionColor(form);
    if (form.dataset.editorForm === "project")
      acknowledgeProjectForm(form, project.manifest.name);
    if (form.dataset.editorForm === "object")
      acknowledgeObjectForm(form, selected?.name ?? "");
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
        command.type === "add-image" ||
        command.type === "add-screen-view" ||
        command.type === "duplicate" ||
        command.type === "duplicate-many" ||
        command.type === "paste"
      )
        selectedIds = canvasSelectionIds(
          screen,
          screen.objects
            .filter((object) => !oldIds.has(object.id))
            .map((object) => object.id),
        );
      if (command.type === "remove" || command.type === "remove-many")
        selectedIds = [];
      if (command.type === "set-visibility" && !command.visible) {
        const hiddenId = command.objectId;
        selectedIds = selectedIds.filter((id) => id !== hiddenId);
      }
      if (command.type === "set-group-state" && command.visible === false) {
        const groupId = command.groupId;
        const hiddenIds =
          groupsOf(screen).find((group) => group.id === groupId)?.memberIds ??
          [];
        selectedIds = selectedIds.filter((id) => !hiddenIds.includes(id));
      }
      if (form) acknowledgeForm(form);
      report(
        "success",
        "変更を適用しました。Project を保存するとファイルに残せます。",
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
      const group = groupFor(screen, id),
        ids = group ? [...group.memberIds] : [id];
      if (screen.objects.some((item) => ids.includes(item.id) && item.locked)) {
        report("info", "ロックを解除してから名前を変更してください。");
        return;
      }
      if (
        (selectedIds.length !== ids.length ||
          !ids.every((member) => selectedIds.includes(member))) &&
        !drafts.allow(run)
      )
        return;
      selectedIds = ids;
      setInspectorVisibility(true);
      void tick().then(() => {
        if (
          generation === workspaceGeneration &&
          screen.id === target &&
          selectedIds.length === ids.length &&
          ids.every((member) => selectedIds.includes(member)) &&
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
      layerTreeBindings.openFolderRequest(
        "rename",
        folder.dataset.layerFolder,
        folder,
      );
      return;
    }
    const layer = target.closest<HTMLElement>("[data-layer-id]");
    if (layer) renamePlacement(layer.dataset.layerId!);
    else if (target.matches('[aria-label="キャンバス操作領域"]')) {
      const id = selectedId ?? activeGroup?.memberIds[0];
      if (id) renamePlacement(id);
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
  let screenViewRequest = $state<{
    generation: number;
    ownerId: string;
  } | null>(null);
  function openScreenViewDialog() {
    if (mode !== "edit" || activeDefinition || busy || replacement) return;
    const ownerId = screen.id,
      generation = workspaceGeneration;
    withScreen(ownerId, () => {
      if (
        generation !== workspaceGeneration ||
        mode !== "edit" ||
        activeDefinition
      )
        return;
      stopPlacement();
      screenViewRequest = { generation, ownerId };
    });
  }
  function addScreenView(sourceId: string) {
    const request = screenViewRequest;
    if (
      !request ||
      request.generation !== workspaceGeneration ||
      request.ownerId !== screen.id ||
      activeDefinition ||
      mode !== "edit"
    ) {
      screenViewRequest = null;
      return;
    }
    const source = project.screens.find((s) => s.id === sourceId);
    if (!source) return;
    const frame = initialImageFrame(source, screen, canvasView.bounds);
    if (
      edit({
        type: "add-screen-view",
        screenId: screen.id,
        sourceScreenId: sourceId,
        frame,
      })
    )
      screenViewRequest = null;
  }
  $effect(() => {
    if (
      screenViewRequest &&
      (screenViewRequest.generation !== workspaceGeneration ||
        screenViewRequest.ownerId !== screen.id ||
        activeDefinition ||
        mode !== "edit")
    )
      screenViewRequest = null;
  });
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
    if (form.dataset.editorForm === "symbol-slot")
      return symbolSlotFormCommand(
        {
          connected: form.isConnected,
          targetKey: form.dataset.targetKey,
          symbolId: form.dataset.symbolId,
          slotName: form.dataset.slotName,
          action: form.dataset.slotAction,
          data,
        },
        {
          project,
          generation: workspaceGeneration,
          definitionId: activeDefinition?.id,
        },
      );
    if (form.dataset.editorForm === "equipment-type")
      return equipmentTypeFormCommand(
        {
          connected: form.isConnected,
          targetKey: form.dataset.targetKey,
          typeId: form.dataset.typeId,
          data,
        },
        project,
        workspaceGeneration,
      );
    if (form.dataset.editorForm === "equipment")
      return equipmentFormCommand(form, project, workspaceGeneration);
    if (form.dataset.editorForm === "background-image")
      return backgroundImageCommand(
        { data, targetKey: form.dataset.targetKey },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          image: backgroundScreen?.backgroundImage,
        },
      );
    if (form.dataset.editorForm === "image-crop")
      return imageCropCommand(
        {
          data,
          objectId: form.dataset.objectId,
          targetKey: form.dataset.targetKey,
          assetId: form.dataset.assetId,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selected,
          assets: project.assets,
        },
      );
    if (form.dataset.editorForm === "shape-paint")
      return shapePaintCommand(
        {
          data,
          objectId: form.dataset.objectId,
          targetKey: form.dataset.targetKey,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selected,
        },
      );
    if (form.dataset.editorForm === "state-color") {
      if (!activeDefinition) throw new Error("共有定義を選び直してください");
      return stateColorCommand(
        {
          data,
          objectId: form.dataset.objectId,
          targetKey: form.dataset.targetKey,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: true,
          selected,
          owner: activeDefinition,
        },
      );
    }
    if (form.dataset.editorForm === "bool-colors")
      return boolColorsCommand(
        {
          data,
          objectId: form.dataset.objectId,
          targetKey: form.dataset.targetKey,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selected,
          readSlots: ("readSlots" in screen ? screen.readSlots : []) ?? [],
        },
      );
    if (form.dataset.editorForm === "symbol-color-mode")
      return symbolColorModeCommand(
        {
          data,
          objectId: form.dataset.objectId,
          targetKey: form.dataset.targetKey,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selected,
        },
      );
    if (form.dataset.editorForm === "selection-outline")
      return selectionOutlineCommand(
        {
          data,
          targetKey: form.dataset.targetKey,
          objectIds: form.dataset.objectIds,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selectedIds,
        },
      );
    if (form.dataset.editorForm === "selection-line")
      return selectionLineCommand(
        {
          data,
          targetKey: form.dataset.targetKey,
          objectIds: form.dataset.objectIds,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selectedIds,
        },
      );
    if (form.dataset.editorForm === "selection-color")
      return selectionColorCommand(
        {
          data,
          targetKey: form.dataset.targetKey,
          objectIds: form.dataset.objectIds,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          definition: !!activeDefinition,
          selectedIds,
        },
      );
    if (form.dataset.editorForm === "project") return projectFormCommand(data);
    if (form.dataset.editorForm === "screen")
      return screenFormCommand(data, {
        screenId: screen.id,
        definitionId: activeDefinition?.id,
      });
    if (form.dataset.editorForm === "group-name")
      return groupNameFormCommand(
        {
          data,
          targetKey: form.dataset.targetKey,
          groupId: form.dataset.groupId,
        },
        {
          generation: workspaceGeneration,
          screenId: screen.id,
          groupId: activeGroup?.id,
        },
      );
    if (form.dataset.editorForm === "move")
      return moveFormCommand(data, { screenId: screen.id, selectedIds });
    return objectFormCommand(data, {
      readSlots: ("readSlots" in screen ? screen.readSlots : []) ?? [],
      screenId: screen.id,
      definition: !!activeDefinition,
      selected,
    });
  }

  function validateDrafts(forms: HTMLFormElement[]): boolean {
    let validatingForm: HTMLFormElement | undefined;
    try {
      // Applying a slot change can remove the color form before the next submit.
      // Reject both dirty forms together before creating any history entry.
      const colorDraft = forms.find(
        (form) => form.isConnected && form.dataset.editorForm === "bool-colors",
      );
      const objectDraft = forms.find(
        (form) => form.isConnected && form.dataset.editorForm === "object",
      );
      if (colorDraft && objectDraft) {
        const slotName = new FormData(objectDraft).get("slotName");
        const slots = ("readSlots" in screen ? screen.readSlots : []) ?? [];
        if (
          !slots.some((slot) => slot.name === slotName && slot.type === "bool")
        ) {
          validatingForm = objectDraft;
          throw new Error(
            "読取slotの解除・numberへの変更と状態別の文字色は同時に適用できません。文字色の入力を戻してからslotを変更してください。",
          );
        }
      }
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

  function load(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    void projectFiles.load(input.files?.[0], {
      get connected() {
        return input.isConnected;
      },
      clear() {
        input.value = "";
      },
    });
  }
  function changeMode(next: "edit" | "preview") {
    transition(() => {
      mode = next;
      if (next === "preview") editingSymbolId = null;
      selectedIds = [];
    });
  }
  function openSelectedEquipment(
    objectId: string,
    destination: "read" | "settings" = "read",
  ) {
    if (menuBlocked || mode !== "edit" || activeDefinition) return;
    const generation = workspaceGeneration,
      ownerId = screen.id;
    transition(() => {
      // Draft application may have changed the placement's equipment binding.
      if (
        workspaceGeneration !== generation ||
        screen.id !== ownerId ||
        mode !== "edit" ||
        activeDefinition
      )
        return;
      const object = screen.objects.find((item) => item.id === objectId);
      const id =
        object?.shape.type === "symbol" ? object.shape.equipmentId : undefined;
      if (!id || !project.equipment?.some((item) => item.id === id)) {
        report("error", "機器の関連付けを確認してください。");
        return;
      }
      if (destination === "settings") {
        setAuxPanelVisibility({ sidebar: true });
        activePanel = "project";
        const library = equipmentLibrary;
        void library?.showEquipment(id).then((form) => {
          if (
            workspaceGeneration !== generation ||
            screen.id !== ownerId ||
            mode !== "edit" ||
            activeDefinition ||
            equipmentLibrary !== library ||
            !form?.isConnected ||
            form.dataset.equipmentId !== id
          )
            return;
          expandTreeAncestors(form);
          form.scrollIntoView({ block: "nearest" });
          const input = form.elements.namedItem("code");
          if (input instanceof HTMLInputElement)
            input.focus({ preventScroll: true });
        });
        return;
      }
      mode = "preview";
      selectedIds = [];
      void tick().then(() => {
        if (
          workspaceGeneration === generation &&
          screen.id === ownerId &&
          mode === "preview" &&
          equipmentDetailsButton?.isConnected
        )
          previewPopups?.showEquipment(id, equipmentDetailsButton);
      });
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
  const layerTreeBindings = createLayerTreeController({
    get owner() {
      return {
        generation: workspaceGeneration,
        mode,
        editBlocked,
        menuBlocked,
        mutationBlocked,
      };
    },
    get dragContext() {
      return { mode, activePanel, showSidebar };
    },
    get screen() {
      return screen;
    },
    get symbols() {
      return project.symbols;
    },
    get selectedIds() {
      return selectedIds;
    },
    get hiddenSelectionCount() {
      return hiddenSelectionCount;
    },
    objectLabel,
    selectObjects,
    transition,
    edit: (command, onerror) => edit(command, undefined, onerror),
    report,
    layerContext,
    layerContextKey,
    toggleObjectVisibility,
    toggleObjectLock,
  });
  const folderScope = $derived(layerTreeBindings.folderScope);
  const layerQuery = $derived(layerTreeBindings.layerQuery);
  const folderRequest = $derived(layerTreeBindings.folderRequest);
  const contextFolderId = $derived(layerTreeBindings.contextFolderId);
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
      const group = groupFor(screen, id);
      if (group) {
        edit({
          type: "set-group-state",
          screenId: screen.id,
          groupId: group.id,
          visible: screen.objects.some(
            (item) =>
              group.memberIds.includes(item.id) && item.visible === false,
          ),
        });
        return;
      }
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
      const group = groupFor(screen, id);
      if (group) {
        edit({
          type: "set-group-state",
          screenId: screen.id,
          groupId: group.id,
          locked: !screen.objects.some(
            (item) => group.memberIds.includes(item.id) && item.locked,
          ),
        });
        return;
      }
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
        selectedIds = expandGroupSelection(screen, [request.objectId]);
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
      : menuBlocked || clipboard.busy
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
  const designerActions = createDesignerActions({
    groups: {
      get groupId() {
        return activeGroup?.id;
      },
      get containsGroups() {
        return containsGroups;
      },
      get definition() {
        return !!activeDefinition;
      },
      get unitCount() {
        return containsGroups
          ? selectionUnits(screen, selectedIds).length
          : selectedIds.length;
      },
      get selectableIds() {
        return canvasSelectionIds(
          screen,
          screen.objects.map((object) => object.id),
        );
      },
      rename: () => {
        if (activeGroup) renamePlacement(activeGroup.memberIds[0]);
      },
      create: groupSelection,
      ungroup: ungroupSelection,
    },
    editing: {
      get editBlocked() {
        return editBlocked;
      },
      get mutationBlocked() {
        return mutationBlocked;
      },
      get undoCount() {
        return history.past.length;
      },
      get redoCount() {
        return history.future.length;
      },
      get objects() {
        return screen.objects;
      },
      get screenId() {
        return screen.id;
      },
      get selectedIds() {
        return selectedIds;
      },
      set selectedIds(value) {
        selectedIds = canvasSelectionIds(screen, value);
      },
      travel,
      transition,
      edit,
      duplicateSelection,
      removeSelection,
      rotateSelection,
    },
    selection: {
      get selected() {
        return selected;
      },
      get contextKind() {
        return contextKind;
      },
      get contextPoint() {
        return contextPoint;
      },
      get origin() {
        return selectionOrigin;
      },
      get definition() {
        return !!activeDefinition;
      },
      get symbolCount() {
        return project.symbols.length;
      },
      renamePlacement,
      toggleObjectVisibility,
      toggleObjectLock,
      openDefinition,
      openEquipment: openSelectedEquipment,
    },
    folders: {
      get count() {
        return screen.folders.length;
      },
      get contextId() {
        return contextFolderId;
      },
      get origin() {
        return layerTreeBindings.folderOrigin;
      },
      open: layerTreeBindings.openFolderRequest,
    },
    clipboard: {
      get busy() {
        return clipboard.busy;
      },
      action: clipboard.action,
    },
    files: {
      get imageBusy() {
        return imageImport.busy;
      },
      newProject: projectFiles.newProject,
      openProjectFile: projectFiles.openProjectFile,
      save: projectFiles.save,
      openPlacement: imageImport.openPlacement,
      focusProjectName,
      openProcessSample: showProcessSample,
      openSymbolSample: () =>
        projectFiles.requestReplacement(
          parseProject(JSON.stringify(symbolColorSample)),
          "sample",
        ),
      openPaintSample: () =>
        projectFiles.requestReplacement(
          parseProject(JSON.stringify(shapePaintSample)),
          "sample",
        ),
      openScreenViewDialog,
      add,
    },
    view: {
      get mode() {
        return mode;
      },
      get menuBlocked() {
        return menuBlocked;
      },
      get selectionViewReason() {
        return selectionViewReason;
      },
      get showRulers() {
        return showRulers;
      },
      get showSidebar() {
        return showSidebar;
      },
      get showReferences() {
        return showReferences;
      },
      get showInspector() {
        return showInspector;
      },
      get showMinimap() {
        return showMinimap;
      },
      get showMenubar() {
        return showMenubar;
      },
      get previousPanels() {
        return !!previousPanels;
      },
      get showGrid() {
        return showGrid;
      },
      set showGrid(value) {
        showGrid = value;
      },
      get snapEnabled() {
        return snapEnabled;
      },
      set snapEnabled(value) {
        snapEnabled = value;
      },
      get helpOpen() {
        return helpOpen;
      },
      set helpOpen(value) {
        helpOpen = value;
      },
      panelVisibility,
      setAuxPanelVisibility,
      setInspectorVisibility,
      toggleAuxPanels,
      zoomAll: () => canvasWorkspace?.zoom(null),
      showSelection,
      toggleRulers,
      toggleMinimap,
      resetFavorites,
      resetPanelWidths,
      restorePanelLayout,
      resetReferenceHeight,
      toggleMenubar,
      changeMode,
      chooseTheme,
    },
  });
  const folderContextItems = $derived(designerActions.folderContext());
  const editToolbarGroups = $derived(designerActions.editGroups());
  const clipboardItems = $derived(designerActions.clipboardItems());
  const selectionContextItems = $derived(
    designerActions.selectionContext(editToolbarGroups, clipboardItems),
  );
  const menuGroups = $derived(
    designerActions.menus(editToolbarGroups, clipboardItems),
  );
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
<input
  hidden
  aria-label="差し替える画像を選択"
  bind:this={replacementImageInput}
  type="file"
  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
  onchange={(event) => imageImport.replaceFile(event.currentTarget.files?.[0])}
  oncancel={imageImport.cancelReplacementChoice}
/>
<input
  hidden
  aria-label="配置する画像を選択"
  bind:this={placementFileInput}
  type="file"
  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
  onchange={(event) => imageImport.placeFile(event.currentTarget.files?.[0])}
/>
{#key workspaceGeneration}
  <input
    hidden
    aria-label="Project を開く"
    bind:this={projectFileInput}
    type="file"
    accept=".json,.bantoscada,.zip,application/json,application/zip"
    disabled={busy}
    onchange={load}
  />
{/key}
<header
  class="app-header"
  class:fullscreen-preview={mode === "preview" && previewFullscreenActive}
>
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
      {#if mode === "preview"}<button
          disabled={menuBlocked}
          onclick={(event) => previewPopups?.showPicker(event.currentTarget)}
          >画面を小窓で表示確認</button
        >
        <button
          bind:this={equipmentDetailsButton}
          disabled={menuBlocked || !project.equipment?.length}
          onclick={(event) =>
            previewPopups?.showPicker(event.currentTarget, "equipment")}
          >機器の読取詳細</button
        >
      {/if}
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
    <PreviewFullscreen
      scope={mode === "preview" ? String(workspaceGeneration) : null}
      onactive={(active) => (previewFullscreenActive = active)}
      onmessage={(message) => report("error", message)}
    />
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
  class:fullscreen-preview={mode === "preview" && previewFullscreenActive}
  class:sidebar-visible={mode === "edit"
    ? showSidebar
    : !previewFullscreenActive}
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
          <TreeSection label="機器" count={project.equipment?.length ?? 0}>
            {#key workspaceGeneration}<EquipmentLibrary
                bind:this={equipmentLibrary}
                {project}
                generation={workspaceGeneration}
                {drafts}
                {transition}
                oncommand={edit}
                onsubmit={submitForm}
                onopenusage={openSymbolUsage}
              />{/key}
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
            {#if !activeDefinition}
              {#key `${workspaceGeneration}:${screen.id}`}
                <BackgroundImageSettings
                  image={backgroundScreen?.backgroundImage}
                  asset={project.assets.find(
                    (asset) =>
                      asset.id === backgroundScreen?.backgroundImage?.assetId,
                  )}
                  targetKey={`${workspaceGeneration}:${screen.id}`}
                  {drafts}
                  busy={imageImport.busy ||
                    busy ||
                    !!replacement ||
                    !!drafts.pending}
                  onimport={imageImport.importBackground}
                  onremove={imageImport.removeBackground}
                  onsubmit={properties}
                />
              {/key}
            {/if}
            {#if activeDefinition}
              {#key `${workspaceGeneration}:${activeDefinition.id}`}<SymbolSlots
                  definition={activeDefinition}
                  generation={workspaceGeneration}
                  {drafts}
                  onsubmit={submitForm}
                  oncommand={edit}
                />{/key}
            {/if}
            <p class="hint">
              サイズ変更は表示領域のみを変更します。図形の位置・サイズは変わりません。
            </p>
          </TreeSection>
        {/if}
      {/snippet}
      {#snippet layersPanel()}
        {#if mode === "edit"}
          <LayerTree tree={layerTreeBindings} />
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
          確定した形状は全画面の参照配置へ反映されます。図形ごとの配色は「共有定義の色」の配置へ反映し、「配置の単色」は配置色を維持します。bool状態別の文字色は両方の配置で優先します。別の形にする場合は定義を複製してください。
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
    {#key `${workspaceGeneration}:${screen.id}`}
      <SlotReadStatus
        {screen}
        screens={project.screens}
        symbols={project.symbols}
        equipmentContext={project}
      />
    {/key}
    <div class="canvas-stack" bind:clientHeight={canvasStackHeight}>
      {#key workspaceGeneration}
        <CanvasWorkspace
          equipmentContext={project}
          bind:this={canvasWorkspace}
          onviewchange={(view) => (canvasView = view)}
          oncontextrequest={requestSelectionContext}
          {screen}
          symbols={project.symbols}
          screens={project.screens}
          images={assetImages}
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
      {#if mode === "preview"}
        {#key `${workspaceGeneration}:${screen.id}:${mode}`}
          <PreviewPopups
            bind:this={previewPopups}
            {project}
            images={assetImages}
            onopenusage={openPreviewEquipmentUsage}
            onmessage={(message) => report("error", message)}
          />
        {/key}
      {/if}
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
                equipmentContext={project}
                {screen}
                symbols={project.symbols}
                screens={project.screens}
                images={assetImages}
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
      onselectsource={(id) => selectObjects(id)}
      onopenequipment={openSelectedEquipment}
      onopenequipmentsettings={(id) => openSelectedEquipment(id, "settings")}
      {openScreen}
      images={assetImages}
      onreplaceimage={imageImport.openReplacement}
      imageBusy={imageImport.busy || busy || !!replacement}
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
  bind:this={layerTreeBindings.folderMenu}
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
      onapply={layerTreeBindings.applyFolderCommand}
      onclose={layerTreeBindings.closeFolderRequest}
    />
  {/key}
{/if}
{#if screenViewRequest}
  <ScreenViewDialog
    {project}
    ownerId={screenViewRequest.ownerId}
    onapply={addScreenView}
    onclose={() => (screenViewRequest = null)}
  />
{/if}
<DraftPrompt guard={drafts} />
<Modal
  open={helpOpen}
  title="操作ガイド・アプリ情報"
  onclose={() => (helpOpen = false)}
>
  <p>SCADA Designer 0.27.0 · Banto 基盤のローカル工程図エディタ</p>
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
    Ctrl / Command + N：新しいProject、O：Projectを開く、S／Shift +
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
  onclose={projectFiles.cancelReplacement}
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
    <button onclick={projectFiles.write}
      >{project.assets.length
        ? "画像同梱で書き出す"
        : "JSON を書き出す"}</button
    ><button onclick={projectFiles.replaceNow}>破棄して開く</button><button
      onclick={projectFiles.cancelReplacement}>キャンセル</button
    >
  </div>
</Modal>
<ToastHost store={toastStore} />

<style>
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
  .screen-row {
    margin: 0;
    padding: 7px 26px 7px 8px;
    min-height: 36px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
  }
  .screen-row:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .screen-row.active {
    background: color-mix(in srgb, var(--banto-primary) 13%, transparent);
    color: var(--banto-text);
  }
  .screen-row:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
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
  :global(#app) .app-header.fullscreen-preview {
    display: none;
  }
  :global(#app) main.fullscreen-preview > .project-sidebar {
    display: none;
  }
  .canvas-stack {
    position: relative;
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
