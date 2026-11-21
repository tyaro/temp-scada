<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    createReadPresentationController,
    type ReadSource,
  } from "./lib/designer/controllers/read-presentation.svelte";
  import {
    createCatalogController,
    type CatalogSource,
  } from "./lib/designer/controllers/catalog.svelte";
  import RecordingOperationsEntry from "./lib/recording-operations/RecordingOperationsEntry.svelte";
  import type { AsyncOperationsClient } from "./lib/recording-async/state";
  import type { RecordingOperationsService } from "./lib/recording-operations/service";
  import RecordingManagementWorkspace from "./lib/recording-management/RecordingManagementWorkspace.svelte";
  import type { RecordingManagementService } from "./lib/recording-management/service";
  import {
    inspectedAtLabel,
    type RecordingSummary,
  } from "./lib/recording-management/summary";
  import type { ExpectedRevisions } from "./lib/recording-management/expected";
  import HistoryWorkspace from "./lib/history/HistoryWorkspace.svelte";
  import TrendDefinitionsDialog from "./lib/designer/TrendDefinitionsDialog.svelte";
  import RecordingPlanDialog from "./lib/designer/RecordingPlanDialog.svelte";
  import type { HistoryService } from "./lib/history/workspace-model";
  let {
    readSource,
    catalogSource,
    historyService,
    recordingManagementService,
    recordingOperationsService,
    recordingAsyncOperations,
    headerExtension,
    connectionStatus,
    onprojectchange,
    projectFileService,
    alarmFeed: alarmFeedProp,
    startup,
  }: {
    readSource?: ReadSource;
    catalogSource?: CatalogSource;
    historyService?: HistoryService;
    recordingManagementService?: RecordingManagementService;
    recordingOperationsService?: RecordingOperationsService;
    recordingAsyncOperations?: AsyncOperationsClient;
    headerExtension?: Snippet;
    /** A read-only connection badge for the full-screen preview, where the
     * header (and `headerExtension`) is hidden (UX review L-3). */
    connectionStatus?: Snippet;
    /** Each replacement of the validated Project (the desktop shell keys its
     * History service on it). */
    onprojectchange?: (project: Project) => void;
    /** The desktop's Project file host (alarm design §5.2); the browser
     * downloads instead. */
    projectFileService?: ProjectFileService;
    /** The alarm host's snapshot and change events. Defaults to the
     * Project file host's feed; the browser e2e injects a mock (design §5.5). */
    alarmFeed?: AlarmFeed;
    /** 起動時に開く Project と表示（Pages のデモの入口）。起動時に一度だけ読む。
     * 無ければ最小サンプルを表示プレビューで開く。 */
    startup?: { project: Project; view?: "edit" | "preview" | "operator" };
  } = $props();
  import type {
    AlarmFeed,
    ProjectFileService,
  } from "./lib/project-file-service";
  import { setAlarmViewProject } from "./lib/alarm-view-state.svelte";
  import { createAlarmFeedController } from "./lib/alarm-list/alarm-feed-controller.svelte";
  import { createHistoryAssetCollector } from "./lib/history-assets";
  import {
    acknowledgeFormKind,
    formCommand as formCommandOf,
    isEditorForm,
    type FormCommandContext,
  } from "./lib/designer/form-commands";
  import {
    groupsOf,
    groupFor,
    selectedGroup as findSelectedGroup,
    expandGroupSelection,
    canvasSelectionIds,
    selectionUnits,
  } from "./lib/geometric-groups";
  import EquipmentLibrary from "./lib/designer/EquipmentLibrary.svelte";
  import EquipmentBindingTable from "./lib/designer/EquipmentBindingTable.svelte";
  import type { BindingTableChange } from "./lib/equipment-binding-table";
  import SymbolSlots from "./lib/designer/SymbolSlots.svelte";
  import { createDesignerActions } from "./lib/designer/controllers/designer-actions";
  import { createClipboardController } from "./lib/designer/controllers/clipboard.svelte";
  import { createImageImportController } from "./lib/designer/controllers/image-import.svelte";
  import { createRuntimeWindowsController } from "./lib/designer/controllers/runtime-windows.svelte";
  import { createRecordingTrendWindowsController } from "./lib/designer/controllers/recording-trend-windows.svelte";
  import { createDesignerShortcutsController } from "./lib/designer/controllers/designer-shortcuts.svelte";
  import SlotReadStatus from "./lib/designer/SlotReadStatus.svelte";
  import AlarmSettings from "./lib/designer/AlarmSettings.svelte";
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
    shouldShowToast,
    type ReportOptions,
  } from "./lib/designer/toast-policy";
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
  import { applyWindowTitle, windowTitle } from "./lib/window-title";
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
  let recordingOperationsOpen = $state.raw<object | null>(null);
  function openRecordingOperations() {
    if (!menuBlocked) recordingOperationsOpen = Object.freeze({});
  }
  let recordingManagementOpen = $state.raw<object | null>(null);
  function openRecordingManagement() {
    if (!menuBlocked) recordingManagementOpen = Object.freeze({});
  }
  // The last inspection's recording state, kept for the header (UX review
  // P0-1). There is no automatic inspection: the badge says when it was read,
  // and a different service (another Project or session) forgets it.
  let lastRecordingSummary = $state.raw<{
    service: RecordingManagementService;
    summary: RecordingSummary;
    inspectedAt: number;
    expected?: ExpectedRevisions;
  }>();
  const recordingIndicator = $derived(
    recordingManagementService
      ? lastRecordingSummary?.service === recordingManagementService
        ? {
            variant: lastRecordingSummary.summary.variant,
            label: `${lastRecordingSummary.summary.label} · 照会 ${inspectedAtLabel(lastRecordingSummary.inspectedAt)}`,
            title: `${lastRecordingSummary.summary.label}（${inspectedAtLabel(lastRecordingSummary.inspectedAt)} の照会時点）: ${lastRecordingSummary.summary.detail}。記録管理状態を開く`,
          }
        : {
            variant: "neutral" as const,
            label: "記録 未照会",
            title: "記録の状態は未照会です。記録管理状態を開く",
          }
      : undefined,
  );
  function toggleMenubar() {
    showMenubar = !showMenubar;
    void setMenubarVisible(showMenubar);
    // ☰ is shown only while the menubar is hidden, so both directions move
    // focus to whichever [data-permanent-menu] now exists.
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
  import { untrack, tick, flushSync, onDestroy, onMount } from "svelte";
  import { createHistoryController } from "./lib/history/presentation";
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
  import { isStateSlotType } from "./lib/equipment";
  import { selectionTarget } from "./lib/selection-view";
  import type { Project } from "./lib/project";
  import FolderDialog from "./lib/designer/FolderDialog.svelte";
  import sample from "../../../examples/minimal.project.json";
  import processSample from "../../../examples/process.project.json";
  import shapePaintSample from "../../../examples/shape-paint.project.json";
  import polygonSymbolSample from "../../../examples/polygon-symbols.project.json";
  import shapeLabelFlowSample from "../../../examples/shape-label-flow.project.json";
  import symbolColorSample from "../../../examples/symbol-color.project.json";
  import CanvasWorkspace, {
    type CanvasView,
    type CanvasContext,
  } from "./lib/designer/CanvasWorkspace.svelte";
  import Minimap from "./lib/designer/Minimap.svelte";
  import ScreenTabs from "./lib/designer/ScreenTabs.svelte";
  import WorkTabs from "./lib/designer/WorkTabs.svelte";
  import {
    createWorkTabsController,
    workTabLabel,
    type WorkTabKind,
  } from "./lib/designer/controllers/work-tabs.svelte";
  import { createEditViewController } from "./lib/designer/controllers/edit-view.svelte";
  import CanvasControls from "./lib/designer/CanvasControls.svelte";
  import { createLayerTreeController } from "./lib/designer/controllers/layer-tree.svelte";
  import LayersPanel from "./lib/designer/LayersPanel.svelte";
  import {
    ThreePaneDock,
    createDockState,
    type DockCapabilities,
    type DockGestureKind,
    type DockPanelChange,
  } from "@banto/dock-svelte";
  import {
    DESIGNER_NARROW_BREAKPOINT,
    DESIGNER_PANE_IDS,
    DESIGNER_PANE_TITLES,
    designerDockLayout,
    keepDesignerPaneWidths,
    withDesignerPaneWidths,
  } from "./lib/designer/dock-layout";
  import { createDesignerDock } from "./lib/designer/controllers/designer-dock.svelte";
  // Screen settings live in the unselected Inspector (UX §5.5(b)); a reveal
  // keeps them shown over the current selection until the selection changes.
  let revealScreenSettings = $state(false);
  $effect(() => {
    selectedIds;
    revealScreenSettings = false;
  });
  function expandTreeAncestors(element: Element) {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  function revealDraftForm(form: HTMLFormElement) {
    // W6: 作業画面のフォームはその作業タブを、Inspector・画面設定・タグの置換
    // （下部の帯）へ戻すときは先に画面タブを、ゲートなしで選ぶ（ゲートを通すと
    // allow→apply→reveal が繰り返す）。
    const workScreen = form.closest<HTMLElement>("[data-work-screen]");
    if (workScreen) {
      workTabs.selectNow(workScreen.dataset.workScreen as WorkTabKind);
      return;
    }
    editView.showCanvas();
    if (isEditorForm(form, "binding-replacement")) {
      setAuxPanelVisibility({ references: true });
      referencesExpanded = true;
      return;
    }
    expandTreeAncestors(form);
    if (form.closest("#designer-inspector-panel .screen-settings"))
      revealScreenSettings = true;
    // 狭い表示で端の帯にあるだけでは欄が見えないので、引き出しまで開く。
    void revealInspector();
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
    panelWidthMaximum,
    type PanelWidths,
  } from "./lib/designer/panel-widths";
  import { createFloatingPanelWorkspace } from "./lib/designer/controllers/floating-panel.svelte";
  import { createFloatingSidebar } from "./lib/designer/controllers/floating-sidebar.svelte";
  const floatingPanels = createFloatingPanelWorkspace();
  import { createFloatingInspector } from "./lib/designer/controllers/floating-inspector.svelte";
  let windowWidth = $state(window.innerWidth);
  let windowHeight = $state(window.innerHeight);
  let workspaceTop = $state(108);
  function measureWorkspace(node: HTMLElement) {
    const measure = () => {
      const top = node.getBoundingClientRect().top;
      if (top !== workspaceTop) {
        floatingInspector.cancel();
        floatingSidebar.cancel();
        workspaceTop = top;
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return { destroy: () => observer.disconnect() };
  }
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
  function resetPanelWidths() {
    beginPanelResize();
    panelWidths = { ...DEFAULT_PANEL_WIDTHS };
    if (!designerNarrow)
      designerDockState.layout = withDesignerPaneWidths(
        designerDockState.layout,
        {
          hostWidth: windowWidth,
          leftWidth: DEFAULT_PANEL_WIDTHS.left,
          rightWidth: DEFAULT_PANEL_WIDTHS.right,
        },
      );
    finishPanelResize(true);
  }
  let measuredStackHeight = $state(0);
  let canvasStackHeight = $state(0);
  // W5: 高さ0（隠れている間）では下部の帯の高さ上限を再計算しない。
  $effect(() => {
    if (measuredStackHeight > 0) canvasStackHeight = measuredStackHeight;
  });
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
  import OperatorView from "./lib/operator/OperatorView.svelte";
  import {
    createSimulatedOperationHost,
    emptySimulation,
    simulatedReadContext,
  } from "./lib/operation-simulation";
  import AlarmListWindow from "./lib/alarm-list/AlarmListWindow.svelte";
  import AlarmSettingsWindow from "./lib/alarm-list/AlarmSettingsWindow.svelte";
  import ArrayCopyDialog from "./lib/designer/ArrayCopyDialog.svelte";
  import { createArrayCopyController } from "./lib/designer/controllers/array-copy.svelte";
  import ScreenViewDialog from "./lib/designer/ScreenViewDialog.svelte";
  import InspectorPanel from "./lib/designer/InspectorPanel.svelte";
  let showInspector = $state(DEFAULT_PANEL_LAYOUT.panels.inspector);
  let showReferences = $state(DEFAULT_PANEL_LAYOUT.panels.references);
  // #331 D2: Designer の枠は ThreePaneDock。分割の幅は dock の divider が持ち、
  // 保存した幅（panel-widths）は最初の配置にだけ使う（外すのは D3）。配置は保存しない。
  const designerDockState = createDockState();
  const designerInitialLayout = designerDockLayout({
    hostWidth: untrack(() => windowWidth),
    leftWidth: untrack(() => leftWidth),
    rightWidth: untrack(() => rightWidth),
  });
  const designerDock = createDesignerDock(designerDockState, {
    get mode() {
      return mode;
    },
    get previewFullscreen() {
      return previewFullscreenActive;
    },
    get narrow() {
      return designerNarrow || window.innerWidth <= DESIGNER_NARROW_BREAKPOINT;
    },
    get narrowShown() {
      return designerNarrow;
    },
    get inspectorWanted() {
      return inspectorShown;
    },
    get inspectorAdoptable() {
      return canvasActive;
    },
    adoptInspector(visible) {
      showInspector = visible;
      // dock の ✕ で隠したとき: 今までの「プロパティを隠す」と同じく常設メニューへ戻す。
      if (!visible)
        void tick().then(() => {
          const active = document.activeElement;
          if (!active || active === document.body || active.closest("main"))
            document
              .querySelector<HTMLButtonElement>("[data-permanent-menu]")
              ?.focus();
        });
    },
  });
  const showSidebar = $derived(designerDock.showSidebar);
  const activePanel = $derived(designerDock.activePanel);
  let designerNarrow = $state(false);
  let designerThreePane = $state.raw<ReturnType<typeof ThreePaneDock>>();
  // 窓の幅が変わっても左右の pane の px を保つ（狭い表示の間は数えない）。
  let designerHostWidth = untrack(() => windowWidth);
  $effect(() => {
    const width = windowWidth;
    if (designerNarrow) return;
    untrack(() => {
      if (width !== designerHostWidth && !designerGesture)
        designerDockState.layout = keepDesignerPaneWidths(
          designerDockState.layout,
          designerHostWidth,
          width,
        );
      designerHostWidth = width;
    });
  });
  $effect(() => {
    designerDock.view = designerThreePane;
  });
  let inspectorPaneWidth = $state(0);
  /** 浮動は D2〜D4 のあいだ止める（2026-11-21 ユーザー決定）。中央の能力は dock が固定する。 */
  function designerPaneCapabilities(): DockCapabilities {
    return { undock: false, autoHide: false };
  }
  /** dock の操作（divider のドラッグなど）の途中。 */
  let designerGesture = false;
  /** false の間は利用者が組み替えられない。進行中の操作を取り消すのに一瞬だけ使う。 */
  let designerArrange = $state(true);
  async function cancelDesignerGesture() {
    if (!designerGesture) return;
    designerArrange = false;
    await tick();
    designerArrange = true;
    await tick();
  }
  function designerGestureStart(kind: DockGestureKind) {
    designerGesture = true;
    if (kind === "divider") canvasWorkspace?.preparePanelResize(true);
    else if (kind === "drag" || kind === "drag-candidate") {
      canvasWorkspace?.cancelInteractions();
      layerTreeBindings.endLayerDrag();
    }
    return true;
  }
  function designerGestureEnd(kind: DockGestureKind) {
    designerGesture = false;
    if (kind === "divider") canvasWorkspace?.finishPanelResize();
  }
  function designerPanelChange(change: DockPanelChange) {
    // どの pane も据え置き（persistent）なので、組み替えで中身は失われない。
    // 中央の大きさが変わりうる組み替えでは、キャンバスの表示の中心を保つ
    // （タブの切り替えは中央の大きさを変えないので触らない。アプリ自身の表示・非表示の
    // 依頼は、呼んだ側が必要なら先に整える。モードの切り替えでは今までどおり整えない）。
    if (change.kind !== "tab-switch" && !designerDock.requesting)
      canvasWorkspace?.preparePanelResize();
    return true;
  }
  let bottomResizer = $state<{ cancel: () => void }>();
  const floatingInspector = createFloatingInspector(
    {
      get viewport() {
        return {
          width: windowWidth,
          height: windowHeight,
          top: workspaceTop,
        };
      },
      get element() {
        return inspectorPanel;
      },
      get visible() {
        return inspectorShown;
      },
      get blocked() {
        return busy || !!drafts.pending || !!replacement || mode !== "edit";
      },
      beforePlacementChange() {
        bottomResizer?.cancel();
        canvasWorkspace?.preparePanelResize();
      },
      cancelWorkspaceInteraction() {
        bottomResizer?.cancel();
        stopPlacement();
        canvasWorkspace?.cancelInteractions();
        layerTreeBindings.endLayerDrag();
      },
      report(message) {
        report("success", message, { toast: true });
      },
    },
    floatingPanels,
  );
  const floatingSidebar = createFloatingSidebar(
    {
      get viewport() {
        return {
          width: windowWidth,
          height: windowHeight,
          top: workspaceTop,
        };
      },
      get element() {
        return sidebarPanel;
      },
      get floatingEnabled() {
        return mode === "edit";
      },
      get visible() {
        return mode === "edit" && showSidebar;
      },
      get blocked() {
        return busy || !!drafts.pending || !!replacement || mode !== "edit";
      },
      beforePlacementChange() {
        bottomResizer?.cancel();
        canvasWorkspace?.preparePanelResize();
      },
      cancelWorkspaceInteraction() {
        bottomResizer?.cancel();
        stopPlacement();
        canvasWorkspace?.cancelInteractions();
        layerTreeBindings.endLayerDrag();
      },
      report(message) {
        report("success", message, { toast: true });
      },
    },
    floatingPanels,
  );
  function restorePanelLayout() {
    if (mode !== "edit" || busy || drafts.pending || replacement) return;
    bottomResizer?.cancel();
    canvasWorkspace?.preparePanelResize();
    floatingInspector.standard();
    floatingSidebar.standard();
    panelWidths = { ...DEFAULT_PANEL_LAYOUT.widths };
    referenceHeight = DEFAULT_PANEL_LAYOUT.referenceHeight;
    void cancelDesignerGesture()
      .then(() =>
        designerDock.restore(
          designerDockLayout({
            hostWidth: windowWidth,
            leftWidth: DEFAULT_PANEL_LAYOUT.widths.left,
            rightWidth: DEFAULT_PANEL_LAYOUT.widths.right,
          }),
        ),
      )
      .then(() => designerDock.setSidebar(DEFAULT_PANEL_LAYOUT.panels.sidebar));
    showInspector = DEFAULT_PANEL_LAYOUT.panels.inspector;
    showReferences = DEFAULT_PANEL_LAYOUT.panels.references;
    showMenubar = DEFAULT_PANEL_LAYOUT.menubar;
    showMinimap = DEFAULT_PANEL_LAYOUT.minimap;
    showRulers = DEFAULT_PANEL_LAYOUT.rulers;
    previousPanels = null;
    void resetDesignerLayoutPreferences();
    report("success", "パネルの表示とサイズを標準に戻しました。", {
      toast: true,
    });
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
  /** 表に出ている左のパネル（Project を優先）。 */
  function frontSidebarPane(): HTMLElement | undefined {
    const panes = [
      ...document.querySelectorAll<HTMLElement>("[data-designer-left-pane]"),
    ].filter((pane) => pane.checkVisibility());
    return (
      panes.find((pane) => pane === sidebarPanel) ?? panes[0] ?? sidebarPanel
    );
  }
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
    const changes: Promise<unknown>[] = [];
    if (patch.sidebar !== undefined)
      changes.push(designerDock.setSidebar(patch.sidebar));
    if (patch.inspector !== undefined) {
      showInspector = patch.inspector;
      changes.push(designerDock.syncInspector());
    }
    if (patch.references !== undefined) showReferences = patch.references;
    if (focus)
      void Promise.all(changes)
        .then(tick)
        .then(() => {
          const visible = panelVisibility()[focus];
          const panel =
            focus === "sidebar"
              ? frontSidebarPane()
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
    if (visible && focus) {
      // 明示に出してフォーカスする（メニュー・文脈メニュー）。狭い表示で端の帯にあるだけ
      // なら引き出しを開いてから移す（帯にあることと中身が見えることは別）。
      void revealInspector().then(() => {
        if (showInspector) inspectorPanel?.focus({ preventScroll: true });
        else
          document
            .querySelector<HTMLButtonElement>("[data-permanent-menu]")
            ?.focus();
      });
      return;
    }
    if (showInspector === visible) return;
    setAuxPanelVisibility(
      { inspector: visible },
      focus ? "inspector" : undefined,
    );
  }
  /**
   * 明示の編集コマンド（画面名の変更・タグ参照からのジャンプ）で Inspector を開き、
   * 中の欄を探せるまで待つ。狭い表示では端の帯にあるだけでは中身が見えないので、
   * 引き出しを開く。
   */
  function revealInspector(): Promise<void> {
    setInspectorVisibility(true);
    return designerDock.revealInspector().then(() => tick());
  }
  function toggleAuxPanels() {
    if (workScreenShown) {
      // W9: 作業画面の表示中は Inspector・タグ参照を隠しているので左ペインだけに作用する。
      setAuxPanelVisibility({ sidebar: !showSidebar });
      void tick().then(() =>
        document
          .querySelector<HTMLButtonElement>("[data-permanent-menu]")
          ?.focus(),
      );
      return;
    }
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
  import { availableFavorites, favoriteKey } from "./lib/designer/favorites";
  import { getFavorites, setFavorites } from "./lib/banto/setup";
  import { createPartPlacementController } from "./lib/designer/controllers/part-placement.svelte";
  const placement = createPartPlacementController({
    get projectId() {
      return project.manifest.projectId;
    },
    get symbols() {
      return project.symbols;
    },
    get screenId() {
      return screen.id;
    },
    get generation() {
      return workspaceGeneration;
    },
    get mode() {
      return mode;
    },
    get definition() {
      return !!activeDefinition;
    },
    get busy() {
      return busy;
    },
    get draftPending() {
      return !!drafts.pending;
    },
    get replacing() {
      return !!replacement;
    },
    transition,
    edit,
    visibleCenter: () => canvasWorkspace?.visibleCenter(),
    setHand: (value) => canvasWorkspace?.setHand(value),
    focusCanvas: () =>
      editorRegion
        ?.querySelector<HTMLElement>('[aria-label="キャンバス操作領域"]')
        ?.focus({ preventScroll: true }),
    showPartsPanel: () => {
      void (showSidebar ? Promise.resolve() : designerDock.setSidebar(true))
        .then(() => designerDock.showLeftPane("parts"))
        .then(tick)
        .then(() => frontSidebarPane()?.focus({ preventScroll: true }));
    },
    loadFavorites: getFavorites,
    saveFavorites: setFavorites,
    report,
  });
  const {
    isFavorite,
    toggleFavorite,
    resetFavorites,
    stopPlacement,
    togglePlacement,
    armPart,
    isArmed,
    choosePart,
    placeArmed,
    placeFavorite,
    browseParts,
    beginPartDrag,
    canDropPart,
    dropPalettePart,
  } = placement;
  import PartsPanel from "./lib/designer/PartsPanel.svelte";
  $effect(() => {
    mode;
    screen.id;
    workspaceGeneration;
    placement.endPaletteDrag();
  });
  import DefinitionBanner from "./lib/designer/DefinitionBanner.svelte";
  import PlacementBar from "./lib/designer/PlacementBar.svelte";
  import StatusRow from "./lib/designer/StatusRow.svelte";
  import ProjectPanel from "./lib/designer/ProjectPanel.svelte";
  import {
    parseProject,
    strokeOverflowIds,
    type Point,
    type Screen,
    type ScreenObject,
    type SymbolDefinition,
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
    cancelInteractions: () => void;
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
  let mode = $state<"edit" | "preview">(
    untrack(() => startup?.view) === "edit" ? "edit" : "preview",
  );
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
      // W4: 作業画面の表示中はキャンバス・図形一覧へ向く操作をしない。
      canvasActive &&
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
    if (runtimeWindows.operatorStart === null && clipboardScope(event.target))
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
        placement.positionPlacement ||
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
  // Commands, history and file adoption replace the whole validated Project.
  // Track that boundary, not every field in the immutable document snapshot.
  let project = $state.raw(
    parseProject(JSON.stringify(untrack(() => startup?.project) ?? sample)),
  );
  $effect(() => {
    const next = project;
    untrack(() => onprojectchange?.(next));
  });
  const readPresentation = createReadPresentationController(
    () => project,
    () => readSource,
  );
  // 段階3 §8（O3c-2）: Editor の表示確認の書込みは模擬値を変えるだけ。模擬値は
  // 編集 session に持ち、実 Hub を購読していないときだけ表示に重ねる。
  let simulation = $state.raw(emptySimulation());
  const readContext = $derived(
    readSource
      ? readPresentation.context
      : simulatedReadContext(readPresentation.context, simulation, project),
  );
  const simulatedOperations = createSimulatedOperationHost({
    project: () => project,
    simulation: () => simulation,
    readsHub: () => !!readSource,
    update: (next) => (simulation = next),
  });
  const catalogController = createCatalogController(
    () => project,
    () => catalogSource,
  );
  const catalogSelection = $derived(catalogController.selection);
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
  const collectHistoryAssets = createHistoryAssetCollector();
  function collectAssets() {
    collectHistoryAssets(project.assets, history, assetStore);
  }
  $effect(collectAssets);
  $effect(() => {
    applyWindowTitle(windowTitle(project.manifest.name)).catch((error) =>
      console.warn("ウィンドウタイトルを更新できませんでした", error),
    );
  });
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
  // 運転表示・警報一覧・端末設定の窓の開閉と、閉じたときのフォーカスの戻り先（R7e1）。
  const runtimeWindows = createRuntimeWindowsController({
    get mode() {
      return mode;
    },
    get workspaceGeneration() {
      return workspaceGeneration;
    },
    get operatorFrame() {
      return project.operatorFrame;
    },
    get screens() {
      return project.screens;
    },
    get screenId() {
      return screen.id;
    },
    get alarmFeed() {
      return alarmFeed;
    },
    report,
  });
  const openOperatorView = runtimeWindows.openOperatorView;
  const openAlarmList = runtimeWindows.openAlarmList;
  const openAlarmSettings = runtimeWindows.openAlarmSettings;
  // 起動時の表示が運転表示なら、最初の描画の後に一度だけ開く。
  onMount(() => {
    if (startup?.view === "operator") openOperatorView();
  });
  $effect(() => runtimeWindows.closeAlarmListOutsidePreview());
  // 表示確認を離れたとき・Project を差し替えたときは閉じる。
  $effect(() => runtimeWindows.closeStaleOperatorView());
  let previewPopups = $state<{
    showPicker: (origin: HTMLElement, kind?: "screen" | "equipment") => void;
    showEquipment: (
      id: string,
      origin: HTMLElement | SVGElement,
      placement?: { screenId: string; objectId: string },
    ) => void;
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
  const referenceUsageCount = $derived(
    references.reduce((count, reference) => count + reference.usages.length, 0),
  );
  function openBinding(usage: BindingUsage) {
    transition(() => {
      editView.showCanvas();
      editingSymbolId = null;
      screenId = usage.screenId;
      selectedIds = expandGroupSelection(screen, [usage.objectId]);
      layerTreeBindings.revealLayerObject(usage.objectId);
      void revealInspector().then(() => {
        editorRegion?.scrollTo({ top: 0 });
        inspectorPanel
          ?.querySelector<HTMLInputElement>('input[name="externalName"]')
          ?.focus();
      });
    });
  }
  let screenId = $state(untrack(() => project.screens[0].id));
  let editingSymbolId = $state<string | null>(null);
  let libraryId = $state("");
  let activeDefinition = $derived(
    project.symbols.find((s) => s.id === editingSymbolId),
  );
  // 作業タブ（docs/design/editor/main-work-tabs-design.md §3）。並びと選択は
  // controller が持ち、App は表示の導出とモード・定義編集・draft の接続だけを持つ。
  const workTabs = createWorkTabsController({
    transition,
    changing: (change) => editView.workTabChanging(change),
  });
  /** 作業タブの並びと作業画面を出せる（編集モード、かつ Symbol 定義の編集中でない）。 */
  const workTabsShown = $derived(mode === "edit" && !activeDefinition);
  /** 作業タブを選んでいて、中央に作業画面を出している。 */
  const workScreenShown = $derived(workTabsShown && workTabs.selected !== null);
  /** キャンバスに向く操作の可否（W4）。 */
  const canvasActive = $derived(mode === "edit" && !workScreenShown);
  /** W9: `showInspector`（配置の保存が使う）は書き換えず、表示だけを導出する。 */
  const inspectorShown = $derived(showInspector && canvasActive);
  // 作業タブの出入り・定義の編集への出入り・表示位置の記憶と復元・Undo／Redo の
  // 画面遷移（R7g）。共通の edit／draft／history の境界は App に残し、callback で渡す。
  const editView = createEditViewController({
    get project() {
      return project;
    },
    get workspaceGeneration() {
      return workspaceGeneration;
    },
    get mode() {
      return mode;
    },
    set mode(value) {
      mode = value;
    },
    get screenId() {
      return screenId;
    },
    set screenId(value) {
      screenId = value;
    },
    get editingSymbolId() {
      return editingSymbolId;
    },
    set editingSymbolId(value) {
      editingSymbolId = value;
    },
    get selectedIds() {
      return selectedIds;
    },
    set selectedIds(value) {
      selectedIds = value;
    },
    get libraryId() {
      return libraryId;
    },
    set libraryId(value) {
      libraryId = value;
    },
    get screen() {
      return screen;
    },
    get activeDefinition() {
      return activeDefinition;
    },
    get canvasActive() {
      return canvasActive;
    },
    get workScreenShown() {
      return workScreenShown;
    },
    get selectedWorkTab() {
      return workTabs.selected;
    },
    get menuBlocked() {
      return menuBlocked;
    },
    get canvasZoom() {
      return canvasView.zoom;
    },
    get canvasWorkspace() {
      return canvasWorkspace;
    },
    get selectionViewReason() {
      return selectionViewReason;
    },
    get selectionViewTarget() {
      return selectionViewTarget;
    },
    transition,
    allow: (retry) => drafts.allow(retry),
    selectWorkTabNow: (kind) => workTabs.selectNow(kind),
    report,
    edit: (command) => edit(command),
    stopPlacement,
    showSidebar: () => setAuxPanelVisibility({ sidebar: true }),
    scrollEditorTop: () => editorRegion?.scrollTo({ top: 0 }),
    revealLayerObject: (id) => layerTreeBindings.revealLayerObject(id),
    travelHistory: (direction) =>
      travelHistory(project, history, direction, mode),
    commitHistory(result) {
      project = result.project;
      history = result.history;
    },
  });

  // 状態行のタグ参照ボタン: パネルの高さの基準を測り直してから開閉する。
  function toggleReferences() {
    canvasWorkspace?.preparePanelResize();
    referencesExpanded = !referencesExpanded;
  }

  // タグ参照パネルの「閉じる」。
  function closeReferences() {
    transition(() =>
      setAuxPanelVisibility({ references: false }, "references"),
    );
  }

  // 左ペインの「タグ参照一覧を開く」。W10: 作業画面の表示中は画面タブを選んでから下部の帯を開く。
  function openReferences() {
    transition(() => {
      const open = () => {
        canvasWorkspace?.preparePanelResize();
        referencesExpanded = true;
        setAuxPanelVisibility({ references: true }, "references");
      };
      if (workScreenShown) editView.afterCanvasReturn(open);
      else open();
    });
  }

  // W10 の安全網: 画面または定義の編集対象が変わったら画面タブを選ぶ。
  $effect(() => {
    screenId;
    editingSymbolId;
    untrack(editView.showCanvas);
  });
  const symbolStrokeOverflow = $derived(
    activeDefinition ? strokeOverflowIds(activeDefinition).length : 0,
  );
  const favoriteItems = $derived(
    availableFavorites(
      placement.favoriteKeys,
      project.manifest.projectId,
      project.symbols,
      !activeDefinition,
    ),
  );
  const armedLabel = $derived(
    placement.armedPart
      ? (availableFavorites(
          [favoriteKey(placement.armedPart, project.manifest.projectId)],
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
    const armedPart = placement.armedPart;
    if (
      armedPart?.type === "symbol" &&
      !project.symbols.some(
        (definition) => definition.id === armedPart.symbolId,
      )
    )
      stopPlacement();
  });
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
  let message = $state("サンプルを表示しています。");
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
    get fileService() {
      return projectFileService;
    },
    alarmRefresh: () => void refreshAlarm(),
    alarmUnavailable: (reason) => (alarms.unavailableReason = reason),
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
  // 警報の host の購読・snapshot・状態の文（Runtime の窓と共通）。
  const alarms = createAlarmFeedController({
    feed: () => alarmFeed,
    projectId: () => project.manifest.projectId,
    onerror: (message) => report("error", message),
  });
  const alarmSnapshot = $derived(alarms.snapshot);
  const refreshAlarm = alarms.refresh;
  const silenceBuzzer = alarms.silenceBuzzer;
  const alarmFeed = $derived(alarmFeedProp ?? projectFileService?.alarmFeed);
  $effect(() => setAlarmViewProject(project));
  function adopt(
    next: Project,
    source: "sample" | "file" | "new",
    store = new AssetStore(),
  ) {
    const previousStore = assetStore;
    assetStore = store;
    previousStore.dispose();
    project = next;
    recordingTrend.closeHistory();
    runtimeWindows.closeAlarmList();
    recordingManagementOpen = null;
    recordingOperationsOpen = null;
    recordingTrend.resetRecordingPlan();
    projectFiles.adopted(next, source);
    history = emptyHistory();
    referencesExpanded = false;
    layerTreeBindings.resetPresentation();
    workspaceGeneration++;
    screenId = project.screens[0].id;
    editingSymbolId = null;
    selectedIds = [];
    // W7: Project の採用では作業タブをすべて閉じる（読込の取消・失敗はここへ来ない）。
    workTabs.reset();
    if (source === "new") mode = "edit";
    report(
      "info",
      source === "sample"
        ? "工程図サンプルを開きました。設備や計測値には接続していません。"
        : source === "new"
          ? projectFiles.native
            ? "新しいProjectを作成しました。保存先を選んで保存してください。"
            : "新しいProjectを作成しました。JSONを書き出して保存してください。"
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
    if (projectChanged || drafts.dirty || bindingTableDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  function report(
    kind: NotificationKind,
    text: string,
    options?: ReportOptions,
  ) {
    message = text;
    if (shouldShowToast(kind, options)) notify(kind, text);
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
  /** Screen-space mirror of every selected placement around its own pivot. */
  function flipSelection(axis: "x" | "y") {
    if (mutationBlocked || !selectedIds.length) return;
    const ids = [...selectedIds],
      scope = folderScope;
    transition(() => {
      if (scope !== folderScope || mode !== "edit") return;
      edit({ type: "flip", screenId: screen.id, objectIds: ids, axis });
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
    acknowledgeFormKind(form, formCommandContext());
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
      const oldScreenId = screenId;
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
      editView.normalizeTargets();
      if (
        command.type === "create-symbol" ||
        command.type === "duplicate-symbol" ||
        command.type === "make-symbol-unique"
      ) {
        editView.openDefinition(
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
      // W10: 画面の追加・複製・削除で画面が変わったら画面タブを選ぶ（edit の中なのでゲートなし）。
      if (screenId !== oldScreenId) editView.showCanvas();
      if (
        command.type === "add" ||
        command.type === "add-polyline" ||
        command.type === "add-symbol" ||
        command.type === "place-symbol" ||
        command.type === "add-image" ||
        command.type === "add-screen-view" ||
        (command.type === "save-trend" && !!command.placement) ||
        command.type === "duplicate" ||
        command.type === "duplicate-many" ||
        command.type === "duplicate-array" ||
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
  let bindingTableOpen = $state(false);
  let bindingTableDirty = $state(false);
  function openBindingTable() {
    if (!editBlocked && !activeDefinition) bindingTableOpen = true;
  }
  function applyBindingTable(changes: BindingTableChange[]): string | null {
    let message: string | null = null;
    const applied = edit(
      { type: "assign-equipment-tags", changes },
      undefined,
      (error) => (message = error),
    );
    return applied ? null : (message ?? "未適用の入力を先に確定してください");
  }
  function screenProperties(event: SubmitEvent) {
    submitForm(event);
  }
  /**
   * W12: 作業タブ「プロジェクト設定」を選び、部品のマウント（`tick`）を待って
   * プロジェクト名へフォーカスする。ゲートは呼び出し側で通過済み（入力検証の
   * 失敗からの reveal、または `renameProject`）。
   */
  function focusProjectName() {
    if (!workTabsShown) return;
    const generation = workspaceGeneration;
    workTabs.selectNow("project-settings");
    void tick().then(() => {
      if (
        generation !== workspaceGeneration ||
        !workTabsShown ||
        workTabs.selected !== "project-settings"
      )
        return;
      const input = document.querySelector<HTMLInputElement>(
        '[data-work-screen="project-settings"] form[data-editor-form="project"] input[name="name"]',
      );
      input?.focus();
      input?.select();
    });
  }
  /** メニュー「プロジェクト名を変更」。表示が切り替わるときだけゲートを通す（W2）。 */
  function renameProject() {
    if (menuBlocked || !workTabsShown) return;
    if (workTabs.selected === "project-settings") focusProjectName();
    else transition(focusProjectName);
  }
  /**
   * 左の機器の「＋」: 作業タブ「機器」を新規登録の状態で開く（W12）。
   * ゲートを1回通し、タブを選んで部品のマウントを待ってから新規登録にする。
   */
  function newEquipment() {
    if (menuBlocked || !workTabsShown) return;
    const generation = workspaceGeneration;
    transition(() => {
      if (generation !== workspaceGeneration || !workTabsShown) return;
      workTabs.selectNow("equipment");
      void tick()
        .then(() =>
          generation === workspaceGeneration &&
          workTabs.selected === "equipment"
            ? (equipmentLibrary?.startNew() ?? null)
            : null,
        )
        .then((form) => {
          if (
            generation !== workspaceGeneration ||
            workTabs.selected !== "equipment" ||
            !form?.isConnected
          )
            return;
          form.querySelector<HTMLElement>("select, input")?.focus();
        });
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
      // 狭い表示で端の帯にあるだけなら引き出しを開いてから名前欄へ移す。
      void revealInspector().then(() => {
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
  const arrayCopy = createArrayCopyController({
    get scope() {
      return JSON.stringify([
        workspaceGeneration,
        screen.id,
        editingSymbolId,
        mode,
        [...selectedIds].sort(),
      ]);
    },
    get revision() {
      return project.manifest.projectRevision;
    },
    get blocked() {
      return mutationBlocked;
    },
    get owner() {
      return screen;
    },
    get ids() {
      return selectedIds;
    },
    transition,
    edit: (command, onerror) => edit(command, undefined, onerror),
    report: (message) => report("error", message),
    stopPlacement,
  });
  let screenViewRequest = $state<{
    generation: number;
    ownerId: string;
  } | null>(null);
  // 記録計画・トレンド定義・トレンド履歴の窓（R7e2）。要求と照合は controller が持つ。
  const recordingTrend = createRecordingTrendWindowsController({
    get project() {
      return project;
    },
    get workspaceGeneration() {
      return workspaceGeneration;
    },
    get screenId() {
      return screen.id;
    },
    get mode() {
      return mode;
    },
    get activeDefinition() {
      return activeDefinition;
    },
    get menuBlocked() {
      return menuBlocked;
    },
    get busy() {
      return busy;
    },
    get replacement() {
      return replacement;
    },
    withScreen,
    stopPlacement,
    edit: (command, onerror) => edit(command, undefined, onerror),
    trendFrame: () =>
      initialImageFrame({ width: 320, height: 120 }, screen, canvasView.bounds),
  });
  $effect(() => {
    recordingTrend.dropStaleRecordingRequest();
  });
  // 履歴の窓は運転表示の出入りで描き直すので、読取の枠（直列化）を持つ controller は App が持つ。
  const historyController = createHistoryController();
  onDestroy(() => historyController.dispose());
  $effect(() => {
    recordingTrend.closeStaleHistory();
  });
  $effect(() => {
    recordingTrend.dropStaleTrendRequest();
  });
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
      if (screenId === id) editView.returnToCanvas();
      else editView.showCanvas();
      if (screenId !== id || editingSymbolId) selectedIds = [];
      screenId = id;
      editingSymbolId = null;
      if (rename) {
        // 画面名は未選択時の Inspector にある（UX §5.5(b)）。
        revealScreenSettings = true;
        void revealInspector().then(() => {
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
    // W2: ゲートを迂回するのはキャンバスを表示しているときだけ。
    if (rename && screenId === id && !editingSymbolId && canvasActive) run();
    else withScreen(id, run);
  }
  function removeScreen(id: string) {
    withScreen(id, () => {
      const target = project.screens.find((s) => s.id === id)!;
      if (project.screens.length > 1)
        editView.askDelete({
          kind: "screen",
          id,
          name: target.name,
          count: target.objects.length,
        });
    });
  }
  /** 画面タブ・画面一覧の見出しの「＋」と⋮の「画面を追加」が共有する入口。 */
  function addScreen() {
    const generation = workspaceGeneration;
    const run = () => {
      if (generation !== workspaceGeneration || project.screens.length >= 100)
        return;
      // Symbol 定義の編集中に「＋」を押したら、openScreen と同じく未適用の入力を
      // 確かめてから定義の編集を抜け、新しい画面を開く。抜けないと `screen` が
      // 定義を指したままになり、以後の編集が共有の定義へ入る。
      if (editingSymbolId) {
        if (!drafts.allow(run)) return;
        editingSymbolId = null;
        selectedIds = [];
      }
      const base =
        project.screens.find((s) => s.id === screenId) ?? project.screens[0];
      if (
        !edit({
          type: "create-screen",
          name: `画面 ${project.screens.length + 1}`,
          width: base.width,
          height: base.height,
        })
      )
        return;
      const id = screenId;
      // 左の画面一覧が底までスクロールしていても、新しい画面の行を見せる。
      void tick().then(() =>
        document
          .querySelector(
            `.project-sidebar [data-screen-id="${CSS.escape(id)}"]`,
          )
          ?.scrollIntoView({ block: "nearest" }),
      );
    };
    run();
  }
  // 左ペインの ⋮ が開いたまま古い対象を指さないための文脈キー。画面一覧・SymbolLibrary 用と、部品パレット用とで中身が違う。
  const projectContextKey = $derived(
    `${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}:${mode}:${busy}:${!!drafts.pending}:${!!replacement}`,
  );
  const paletteContextKey = $derived(
    `${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}`,
  );
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
      {
        label: "画面を追加",
        disabled: project.screens.length >= 100,
        run: addScreen,
      },
    ];
  }
  function add(kind: AddKind) {
    edit({ type: "add", screenId: screen.id, kind });
  }
  // R7a: 種類ごとの振分けは lib/designer/form-commands.ts の登録表が持つ。
  // App は呼ぶたびに現在値を渡すだけで、状態はここに残す。
  function formCommandContext(): FormCommandContext {
    return {
      project,
      screen,
      activeDefinition,
      workspaceGeneration,
      selectedIds,
      selected,
      backgroundScreen,
      activeGroup,
      catalogSelection,
    };
  }
  function formCommand(form: HTMLFormElement): EditCommand {
    return formCommandOf(form, formCommandContext());
  }

  function validateDrafts(forms: HTMLFormElement[]): boolean {
    let validatingForm: HTMLFormElement | undefined;
    try {
      validatingForm = forms.find(
        (form) => form.isConnected && isEditorForm(form, "binding-replacement"),
      );
      if (validatingForm)
        throw new Error(
          "タグ参照名の置換は差分を確認して明示適用するか、置換を取消してください。",
        );
      // Applying a slot change can remove the color form before the next submit.
      // Reject both dirty forms together before creating any history entry.
      const colorDraft = forms.find(
        (form) => form.isConnected && isEditorForm(form, "state-text-color"),
      );
      const objectDraft = forms.find(
        (form) => form.isConnected && isEditorForm(form, "object"),
      );
      if (colorDraft && objectDraft) {
        const slotName = new FormData(objectDraft).get("slotName");
        const slots = ("readSlots" in screen ? screen.readSlots : []) ?? [];
        if (
          !slots.some(
            (slot) => slot.name === slotName && isStateSlotType(slot.type),
          )
        ) {
          validatingForm = objectDraft;
          throw new Error(
            "読取slotの解除・numberへの変更と状態の色に従う指定は同時に適用できません。指定の入力を戻してからslotを変更してください。",
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
      if (validatingForm && isEditorForm(validatingForm, "project"))
        focusProjectName();
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
      const switching = mode !== next;
      if (switching && next === "preview") editView.rememberEditView();
      mode = next;
      if (next === "preview") editingSymbolId = null;
      editView.clearDefinitionReturn();
      // W5・W7: 作業画面へ戻るときはキャンバスが隠れているので、画面タブを選んだ後に戻す。
      if (switching && next === "edit") {
        if (canvasActive) editView.restoreEditView();
      } else selectedIds = [];
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
        // W12: 作業タブ「機器」を開き、部品のマウントを待ってから対象を選ぶ。
        // ゲートは通過済みなので selectNow を使う（W2 の例外）。
        workTabs.selectNow("equipment");
        void tick()
          .then(() =>
            workspaceGeneration === generation &&
            workTabs.selected === "equipment"
              ? (equipmentLibrary?.showEquipment(id) ?? null)
              : null,
          )
          .then((form) => {
            if (
              workspaceGeneration !== generation ||
              mode !== "edit" ||
              activeDefinition ||
              workTabs.selected !== "equipment" ||
              !form?.isConnected ||
              form.dataset.equipmentId !== id
            )
              return;
            form.scrollIntoView({ block: "nearest" });
            const input = form.elements.namedItem("code");
            if (input instanceof HTMLInputElement)
              input.focus({ preventScroll: true });
          });
        return;
      }
      editView.rememberEditView();
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
  const menuBlocked = $derived(
    busy ||
      !!drafts.pending ||
      !!replacement ||
      floatingPanels.gesturing ||
      recordingTrend.historyOpen ||
      runtimeWindows.alarmListOpen ||
      runtimeWindows.alarmSettingsOpen ||
      !!recordingManagementOpen ||
      !!recordingOperationsOpen ||
      !!recordingTrend.trendRequest ||
      bindingTableOpen ||
      !!recordingTrend.recordingRequest,
  );
  const editBlocked = $derived(menuBlocked || mode !== "edit");
  const selectionViewTarget = $derived(selectionTarget(screen, selectedIds));
  const selectionViewReason = $derived(
    mode !== "edit"
      ? "編集モードで使用できます"
      : !canvasActive
        ? "画面タブを選ぶと使えます"
        : menuBlocked || clipboard.busy
          ? "確認中の操作を完了してください"
          : placement.positionPlacement
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
      get canvasBlocked() {
        return !canvasActive;
      },
      get hasAlarmDefinitions() {
        return !!project.alarms?.definitions.length;
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
      travel: editView.travel,
      transition,
      edit,
      duplicateSelection,
      openArrayCopy: arrayCopy.open,
      removeSelection,
      rotateSelection,
      flipSelection,
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
      openDefinition: editView.openDefinition,
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
      get orderFiltered() {
        return layerTreeBindings.orderFiltered;
      },
      canReorder: layerTreeBindings.canReorderFolder,
      reorder: layerTreeBindings.reorderFolder,
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
      saveAs: projectFiles.native ? projectFiles.saveAs : undefined,
      openPlacement: imageImport.openPlacement,
      renameProject,
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
      openPolygonSample: () =>
        projectFiles.requestReplacement(
          parseProject(JSON.stringify(polygonSymbolSample)),
          "sample",
        ),
      openFlowSample: () =>
        projectFiles.requestReplacement(
          parseProject(JSON.stringify(shapeLabelFlowSample)),
          "sample",
        ),
      openScreenViewDialog,
      openTrendDefinitions: recordingTrend.openTrendDefinitions,
      openRecordingPlan: recordingTrend.openRecordingPlan,
      openAlarmSettings,
      get alarmSettingsReason() {
        return runtimeWindows.alarmSettingsReason;
      },
      add,
    },
    view: {
      // 浮動の入口は D4 まで出さない（#331 D2、2026-11-21 ユーザー決定）。
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
      get workScreenShown() {
        return workScreenShown;
      },
      get workTabReason() {
        return mode !== "edit"
          ? "編集モードで使えます"
          : activeDefinition
            ? "Symbol 定義の編集中は使えません"
            : null;
      },
      openWorkTab: (kind) => {
        if (!menuBlocked && workTabsShown) workTabs.open(kind);
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
      showSelection: editView.showSelection,
      toggleRulers,
      toggleMinimap,
      resetFavorites,
      resetPanelWidths,
      restorePanelLayout,
      resetReferenceHeight,
      toggleMenubar,
      changeMode,
      chooseTheme,
      openRecordingManagement,
      openRecordingOperations,
      openHistory: () => {
        if (!menuBlocked) recordingTrend.openHistory();
      },
    },
  });
  // キー操作（R7f）。dispatcher への登録は designerActions の生成より後（register）。
  const designerShortcuts = createDesignerShortcutsController({
    get busy() {
      return busy;
    },
    get clipboardBusy() {
      return clipboard.busy;
    },
    get draftPending() {
      return !!drafts.pending;
    },
    get replacement() {
      return !!replacement;
    },
    get helpOpen() {
      return helpOpen;
    },
    get canvasActive() {
      return canvasActive;
    },
    get positionPlacement() {
      return placement.positionPlacement;
    },
    get runtimeWindowOpen() {
      return (
        runtimeWindows.operatorStart !== null ||
        recordingTrend.historyOpen ||
        runtimeWindows.alarmListOpen ||
        runtimeWindows.alarmSettingsOpen ||
        !!recordingManagementOpen ||
        !!recordingOperationsOpen ||
        !!recordingTrend.trendRequest ||
        !!recordingTrend.recordingRequest
      );
    },
    get dialogOpen() {
      return (
        screenViewRequest !== null ||
        bindingTableOpen ||
        arrayCopy.request !== null ||
        folderRequest !== null ||
        editView.deleteConfirm !== null
      );
    },
    isTagPickerOpen: () =>
      !!inspectorController?.isTagPickerOpen() ||
      !!equipmentLibrary?.isTagPickerOpen(),
    clipboardScope,
    hiddenCanvasMutation,
    renameFocused,
    removeSelection,
    save: () => projectFiles.save(),
    saveAs: () => projectFiles.saveAs(),
    stopPlacement,
    removeFolder: (folderId, origin) =>
      layerTreeBindings.openFolderRequest("remove", folderId, origin),
  });
  designerShortcuts.register(designerActions);
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
  bind:innerHeight={windowHeight}
  oncopy={nativeClipboard}
  oncut={nativeClipboard}
  onpaste={nativeClipboard}
  onkeydown={designerShortcuts.handle}
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
{#snippet browserHubStatus()}
  {#if !readSource}<StatusBadge
      variant={mode === "preview" ? "warning" : "neutral"}
      label="Hub 未接続"
    />{/if}
{/snippet}
{#snippet recordingStatus()}
  {#if recordingIndicator}<button
      type="button"
      class="recording-status"
      data-recording-status
      aria-label={recordingIndicator.title}
      title={recordingIndicator.title}
      disabled={menuBlocked}
      onclick={openRecordingManagement}
      ><StatusBadge
        variant={recordingIndicator.variant}
        label={recordingIndicator.label}
      /></button
    >{/if}
{/snippet}
{#snippet screenSettingsPanel()}
  {#key screen}
    <form
      use:drafts.track
      data-editor-form="screen"
      oncompositionstart={(event) => composingForms.add(event.currentTarget)}
      oncompositionend={(event) => composingForms.delete(event.currentTarget)}
      onsubmit={screenProperties}
      aria-label="画面設定"
    >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label"
          >{activeDefinition ? "Symbol 名" : "画面名"}</span
        ><input
          class="banto-field-control"
          onkeydown={nameFormKey}
          name="name"
          value={screen.name}
          required
          maxlength="200"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label"
          >{activeDefinition ? "定義の幅" : "画面の幅"}</span
        ><input
          class="banto-field-control"
          name="width"
          type="number"
          step="any"
          min="1"
          value={screen.width}
          required
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label"
          >{activeDefinition ? "定義の高さ" : "画面の高さ"}</span
        ><input
          class="banto-field-control"
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
            value={"background" in screen ? screen.background : "#ffffff"}
            required
          /></label
        >
        <p class="hint">アプリのテーマと図形の色は変わりません。</p>
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">交差のまたぎ</span><select
            class="banto-field-control"
            name="lineHops"
            aria-label="交差のまたぎ"
            >{#each [["", "なし"], ["arc", "弧でまたぐ"], ["cut", "下の線を切る"]] as [value, label]}<option
                {value}
                selected={("background" in screen && screen.lineHops
                  ? screen.lineHops
                  : "") === value}>{label}</option
              >{/each}</select
          ></label
        >
        <p class="hint">
          配管が交わる所で、後に描く配管を半円でまたがせます。「下の線を切る」では弧を描かず、またぐ配管は直線のまま、またがれる配管を交差点の前後で切ります。
        </p>
      {/if}
      <button type="submit"
        >{activeDefinition ? "Symbol 設定を適用" : "画面設定を適用"}</button
      >
    </form>
  {/key}
  {#if !activeDefinition}
    {#key `${workspaceGeneration}:${screen.id}`}
      <BackgroundImageSettings
        image={backgroundScreen?.backgroundImage}
        url={assetImages.get(backgroundScreen?.backgroundImage?.assetId ?? "")
          ?.url}
        asset={project.assets.find(
          (asset) => asset.id === backgroundScreen?.backgroundImage?.assetId,
        )}
        targetKey={`${workspaceGeneration}:${screen.id}`}
        {drafts}
        busy={imageImport.busy || busy || !!replacement || !!drafts.pending}
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
{/snippet}
<header
  class="app-header"
  class:fullscreen-preview={mode === "preview" && previewFullscreenActive}
>
  <h1 class="sr-only">{project.manifest.name}</h1>
  {#if headerExtension}<div class="header-extension">
      {@render headerExtension()}
    </div>{/if}
  {#if showMenubar}<DesignerMenubar groups={menuGroups} />{/if}
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
  </div>
  <div class="header-status">
    {#if mode === "edit"}<span
        class="selection-count"
        title="Ctrl / ⌘ / Shift + クリックで選択を追加・解除"
        >{selectedIds.length} 件選択{#if hiddenSelectionCount}（非表示 {hiddenSelectionCount}
          件）{/if}</span
      >{/if}
    <div
      class="save-state"
      data-testid="save-state"
      role="group"
      aria-label="保存状態"
      title={`${saveLabel}${drafts.dirty ? ` · 未適用の入力あり · ${drafts.count} フォーム` : ""}${lastExport ? ` · ${projectFiles.native ? "最終保存" : "最終書き出し要求"} ${lastExport}` : ""}`}
    >
      <div class="save-label">
        <StatusBadge
          variant={projectChanged ? "warning" : "neutral"}
          label={saveLabel}
        />
      </div>
      <span class="draft-state" aria-live="polite"
        >{drafts.dirty
          ? `未適用の入力あり · ${drafts.count} フォーム`
          : ""}</span
      >
      {#if lastExport}<span class="sr-only"
          >{projectFiles.native ? "最終保存" : "最終書き出し要求"}
          {lastExport}</span
        >{/if}
    </div>
    {#if recordingIndicator}{@render recordingStatus()}{/if}
    {#if alarmFeed}
      <StatusBadge
        variant={alarms.healthy ? "neutral" : "warning"}
        label={alarms.label}
      />
      {#if alarms.soundNotice}<span data-alarm-sound-fallback
          ><StatusBadge variant="warning" label={alarms.soundNotice} /></span
        >{/if}
    {/if}
    {#if !headerExtension}{@render browserHubStatus()}{/if}
  </div>
  <div class="header-actions">
    {#if projectFiles.native}
      <button
        type="button"
        onclick={() => void projectFiles.applyAlarm()}
        disabled={projectFiles.alarmApplying}
        aria-busy={projectFiles.alarmApplying}
        title="開いている保存済みProjectの警報定義を適用"
        >{projectFiles.alarmApplying ? "適用中…" : "警報を適用"}</button
      >
    {/if}
    <!-- メニューバー表示中は同じ項目の重複になるので、☰ は隠しているときだけ出す。 -->
    {#if !showMenubar}<Menu label="常設メニュー" placement="bottom-end">
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
        <MenuGroup label="記録">
          {#each menuGroups.find((g) => g.label === "記録")?.items ?? [] as item}
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
      </Menu>{/if}
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
  label={mode === "edit" ? "共通編集ツールバー" : "表示確認ツールバー"}
>
  {#snippet modes()}
    <div class="mode-tools" role="group" aria-label="表示の操作">
      {#if mode === "preview"}<button
          disabled={menuBlocked}
          onclick={(event) => previewPopups?.showPicker(event.currentTarget)}
          >画面を小窓で表示確認</button
        >
        <button
          bind:this={equipmentDetailsButton}
          disabled={menuBlocked || !project.equipment?.length}
          title="一覧から機器を選んで開きます。図面上の機器を押しても開けます。"
          onclick={(event) =>
            previewPopups?.showPicker(event.currentTarget, "equipment")}
          >機器の読取詳細</button
        >
        <button
          bind:this={runtimeWindows.operatorEntryButton}
          disabled={menuBlocked}
          title="ヘッダー・フッターの枠と主画面だけを出し、画面切替ボタンで画面を移ります。Escで戻ります。"
          onclick={openOperatorView}>運転表示</button
        >
        <button disabled={menuBlocked} onclick={openAlarmList}
          >アラーム一覧</button
        >
      {/if}
      {#if mode === "edit"}<button
          aria-label="キャンバスの操作"
          title="キャンバスの操作（Shift+F10）"
          aria-haspopup="menu"
          disabled={menuBlocked || !canvasActive}
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
      scope={mode === "preview" && runtimeWindows.operatorStart === null
        ? String(workspaceGeneration)
        : null}
      onactive={(active) => (previewFullscreenActive = active)}
      onmessage={(message) => report("error", message)}
    />
    {#if mode === "preview" && previewFullscreenActive}<div
        class="fullscreen-status"
        role="group"
        aria-label="接続と記録の状態"
      >
        {#if connectionStatus}{@render connectionStatus()}{:else}{@render browserHubStatus()}{/if}
        {@render recordingStatus()}
      </div>{/if}
    {#if mode === "edit"}
      <CanvasControls
        disabled={!canvasActive}
        view={canvasView}
        selectionReason={selectionViewReason}
        onselection={editView.showSelection}
        bind:showGrid
        bind:snapEnabled
        bind:gridSize
        placing={placement.positionPlacement}
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
</EditToolbar>
<div class="tab-strip">
  <ScreenTabs
    screens={project.screens}
    activeId={activeDefinition || workScreenShown ? null : screen.id}
    editable={mode === "edit"}
    contextKey={contextScope}
    onopen={openScreen}
    actions={screenContextItems}
    onadd={addScreen}
    canAdd={project.screens.length < 100}
  />
  {#if workTabsShown && workTabs.tabs.length}
    <WorkTabs
      tabs={workTabs.tabs}
      selected={workTabs.selected}
      onselect={workTabs.select}
      onclose={workTabs.close}
    />
  {/if}
</div>
<main
  data-project-revision={project.manifest.projectRevision}
  class:editing={mode === "edit"}
  class:fullscreen-preview={mode === "preview" && previewFullscreenActive}
>
  <!-- #331 D2: 左 = Project（レイヤー・部品は追加パネル）、中央 = 画面プレビュー、右 = Inspector。
       どの pane も据え置き（persistent）。浮動は D4 まで止める（undock: false）。 -->
  <ThreePaneDock
    bind:this={designerThreePane}
    bind:narrow={designerNarrow}
    dock={designerDockState}
    initialLayout={designerInitialLayout}
    {leftWidth}
    {rightWidth}
    narrowBreakpoint={DESIGNER_NARROW_BREAKPOINT}
    panels={[
      {
        id: DESIGNER_PANE_IDS.layers,
        title: DESIGNER_PANE_TITLES.layers,
        content: layersPane,
        initial: { edge: "left" },
      },
      {
        id: DESIGNER_PANE_IDS.parts,
        title: DESIGNER_PANE_TITLES.parts,
        content: partsPane,
        initial: { edge: "left" },
      },
    ]}
    persistent={() => true}
    arrange={designerArrange}
    capabilities={designerPaneCapabilities}
    canStartGesture={designerGestureStart}
    onGestureEnd={designerGestureEnd}
    beforePanelChange={designerPanelChange}
    messages={{
      threePaneLeft: () => DESIGNER_PANE_TITLES.project,
      threePaneCenter: () => DESIGNER_PANE_TITLES.center,
      threePaneRight: () => DESIGNER_PANE_TITLES.inspector,
      close: (title) => `${title}を隠す`,
    }}
  >
    {#snippet left()}
      <div
        class="project-sidebar sidebar-pane"
        id="designer-project-panel"
        data-designer-left-pane="project"
        bind:this={sidebarPanel}
        tabindex="-1"
      >
        <ProjectPanel
          {project}
          editing={mode === "edit"}
          editingDefinition={!!activeDefinition}
          {editBlocked}
          screenId={screen.id}
          contextKey={projectContextKey}
          referenceCount={references.length}
          images={assetImages}
          {libraryId}
          workspaceKey={workspaceGeneration}
          {screenContextItems}
          onopenscreen={(id) => openScreen(id)}
          onaddscreen={addScreen}
          onopenreferences={openReferences}
          onopenusage={editView.openSymbolUsage}
          onchooseSymbol={(id) => (libraryId = id)}
          oneditSymbol={editView.openDefinition}
          ondeleteSymbol={editView.deleteDefinition}
          onsymbolCommand={editView.symbolLibraryCommand}
          onnewEquipment={newEquipment}
          onopenwork={(kind) => workTabs.open(kind)}
          onopenRecordingPlan={recordingTrend.openRecordingPlan}
        />
      </div>
    {/snippet}
    {#snippet right()}
      <div class="inspector-pane" bind:clientWidth={inspectorPaneWidth}>
        {#if mode === "edit"}
          <InspectorPanel
            {catalogSelection}
            bind:this={inspectorController}
            bind:element={inspectorPanel}
            generation={workspaceGeneration}
            {commitNumber}
            visible={inspectorShown}
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
            openDefinition={editView.openDefinition}
            onselectsource={(id) => selectObjects(id)}
            onopenequipment={openSelectedEquipment}
            onopenequipmentsettings={(id) =>
              openSelectedEquipment(id, "settings")}
            onmanagetrend={recordingTrend.openTrendDefinitions}
            onopentrend={(objectId) =>
              recordingTrend.openTrendHistory(screen.id, objectId)}
            {openScreen}
            images={assetImages}
            onreplaceimage={imageImport.openReplacement}
            imageBusy={imageImport.busy || busy || !!replacement}
            screenSettings={screenSettingsPanel}
            showScreenSettings={revealScreenSettings}
          />
        {/if}
      </div>
    {/snippet}
    <section
      class="designer-center"
      use:measureWorkspace
      aria-label="画面プレビュー"
      bind:this={editorRegion}
    >
      {#if activeDefinition}
        <DefinitionBanner
          usageCount={symbolUsage(project, activeDefinition.id)}
          strokeOverflow={symbolStrokeOverflow}
          onreturn={editView.returnFromDefinition}
        />
      {/if}
      {#if mode === "preview"}
        {#key `${workspaceGeneration}:${screen.id}`}
          <SlotReadStatus
            {screen}
            screens={project.screens}
            symbols={project.symbols}
            equipmentContext={readContext.equipmentContext}
          />
        {/key}
      {/if}
      <div class="canvas-stack" bind:clientHeight={measuredStackHeight}>
        {#each workTabs.tabs as kind (kind)}
          <!-- W3: 開いている作業画面は非選択中も破棄せず hidden で保持する。 -->
          <div
            class="work-screen"
            data-work-screen={kind}
            role="region"
            aria-labelledby={`work-screen-title-${kind}`}
            hidden={!workScreenShown || workTabs.selected !== kind}
          >
            <h2 id={`work-screen-title-${kind}`} tabindex="-1">
              {workTabLabel(kind)}
            </h2>
            {#if kind === "equipment"}
              <div class="equipment-work">
                {#key workspaceGeneration}<EquipmentLibrary
                    {catalogSelection}
                    bind:this={equipmentLibrary}
                    {project}
                    generation={workspaceGeneration}
                    {drafts}
                    {transition}
                    oncommand={edit}
                    onsubmit={submitForm}
                    onopenusage={editView.openSymbolUsage}
                    onopentable={openBindingTable}
                    tableDisabled={editBlocked && !bindingTableOpen}
                  />{/key}
              </div>
            {:else if kind === "alarm-definitions"}
              <div class="alarm-definitions-work">
                <AlarmSettings
                  {project}
                  generation={workspaceGeneration}
                  {drafts}
                  disabled={editBlocked}
                  tagNames={catalogSelection.available
                    ? catalogSelection.catalog.tags.map(
                        (tag) => tag.externalName,
                      )
                    : []}
                  oncommand={(command) => edit(command)}
                  onsubmit={submitForm}
                />
              </div>
            {:else if kind === "project-settings"}
              <div class="project-settings-work">
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
                    <label class="banto-field banto-field--stacked"
                      ><span class="banto-field-label">プロジェクト名</span
                      ><input
                        class="banto-field-control"
                        onkeydown={nameFormKey}
                        name="name"
                        required
                        maxlength="200"
                      /></label
                    >
                    <button type="submit">プロジェクト名を適用</button>
                  </form>
                {/key}
                <h3>運転表示の設定</h3>
                <!-- 確定値は drafts.track の update で同期し、関係のない編集で未適用の選択を消さない。 -->
                {#key `${workspaceGeneration}:${project.manifest.projectId}`}
                  <form
                    use:drafts.track={{
                      startScreenId: project.operatorFrame?.startScreenId ?? "",
                      headerScreenId:
                        project.operatorFrame?.headerScreenId ?? "",
                      footerScreenId:
                        project.operatorFrame?.footerScreenId ?? "",
                    }}
                    data-editor-form="operator-frame"
                    aria-label="運転表示の設定"
                    onsubmit={submitForm}
                  >
                    {#each [["startScreenId", "開始画面"], ["headerScreenId", "ヘッダー画面"], ["footerScreenId", "フッター画面"]] as [key, label]}
                      <label class="banto-field banto-field--stacked"
                        ><span class="banto-field-label">{label}</span><select
                          class="banto-field-control"
                          name={key}
                          aria-label={label}
                          disabled={editBlocked}
                          ><option value="">なし</option>
                          {#each project.screens as target (target.id)}<option
                              value={target.id}>{target.name}</option
                            >{/each}</select
                        ></label
                      >
                    {/each}
                    <p class="hint">
                      開始・ヘッダー・フッターは別の画面にします。ヘッダー・フッターの画面は画面切替ボタンの行き先にできません。
                    </p>
                    <button type="submit" disabled={editBlocked}
                      >運転表示の設定を適用</button
                    >
                  </form>
                {/key}
                <h3>記録希望設定</h3>
                <button
                  class="open-recording-plan"
                  disabled={editBlocked}
                  onclick={recordingTrend.openRecordingPlan}
                  >記録希望設定を開く</button
                >
              </div>
            {/if}
          </div>
        {/each}
        <div class="canvas-area" class:covered={workScreenShown}>
          {#key workspaceGeneration}
            <CanvasWorkspace
              onopentrend={(objectId) =>
                recordingTrend.openTrendHistory(screen.id, objectId)}
              onopenequipment={mode === "preview" && !menuBlocked
                ? (id, origin, placement) =>
                    previewPopups?.showEquipment(id, origin, placement)
                : undefined}
              onnavigate={mode === "preview" && !menuBlocked
                ? (target) => {
                    if (target.kind === "screen") openScreen(target.screenId);
                    else if (target.kind === "alarmList") openAlarmList();
                    // operationList は Runtime だけの窓（O4c）。Editor では何もしない。
                    else if (target.kind === "silenceBuzzer") silenceBuzzer();
                  }
                : undefined}
              buzzerAvailable={!!alarmFeed?.silenceBuzzer}
              equipmentContext={readContext.equipmentContext}
              readings={readContext.readings}
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
              placing={placement.positionPlacement}
              placeReady={!!placement.armedPart}
              onplacepoint={placeArmed}
              drawLine={placement.drawKind}
              ondrawline={placement.drawArmed}
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
              onvertexconnect={(id, endpoint, connection) =>
                edit({
                  type: "set-line-connection",
                  screenId: screen.id,
                  objectId: id,
                  endpoint,
                  connection,
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
              trends={project.trends}
            />
          {/key}
          {#if mode === "preview"}
            {#key `${workspaceGeneration}:${screen.id}:${mode}`}
              <PreviewPopups
                onopentrend={recordingTrend.openTrendHistory}
                onretiretrend={recordingTrend.retirePopupTrend}
                bind:this={previewPopups}
                equipmentContext={readContext.equipmentContext}
                readings={readContext.readings}
                {project}
                images={assetImages}
                onopenusage={editView.openPreviewEquipmentUsage}
                onmessage={(message) => report("error", message)}
                operations={simulatedOperations}
              />
            {/key}
          {/if}
          {#if mode === "edit" && (showSidebar || showInspector || showReferences)}
            <div class="canvas-navigation" class:has-map={showMinimap}>
              <FavoritesDock
                images={assetImages}
                items={favoriteItems}
                positionPlacement={placement.positionPlacement}
                {isArmed}
                onarm={armPart}
                onimmediate={placeFavorite}
                contextKey={`${contextScope}:${placement.favoriteKeys.join(",")}`}
                onplace={choosePart}
                onremove={toggleFavorite}
                onbrowse={browseParts}
                onstartdrag={beginPartDrag}
                onenddrag={placement.endPaletteDrag}
              />
              {#if showMinimap}
                {#key `${workspaceGeneration}:${screen.id}`}
                  <Minimap
                    equipmentContext={readContext.equipmentContext}
                    readings={readContext.readings}
                    {screen}
                    symbols={project.symbols}
                    screens={project.screens}
                    images={assetImages}
                    view={canvasView}
                    oncenter={(point) => canvasWorkspace?.centerOn(point)}
                    onfit={() => canvasWorkspace?.zoom(null)}
                    trends={project.trends}
                  />
                {/key}
              {/if}
            </div>
          {/if}
        </div>
        {#if mode === "edit" && placement.positionPlacement}
          <PlacementBar
            armedLabel={placement.armedPart ? armedLabel : null}
            drawing={!!placement.drawKind}
            onstop={() => stopPlacement(true)}
          />
        {/if}
        <StatusRow
          {message}
          editing={mode === "edit"}
          readStatusKey={`${workspaceGeneration}:${screen.id}`}
          {screen}
          screens={project.screens}
          symbols={project.symbols}
          equipmentContext={readContext.equipmentContext}
          showReferencesToggle={mode === "edit" &&
            showReferences &&
            references.length > 0 &&
            !workScreenShown}
          referenceCount={references.length}
          {referenceUsageCount}
          {referencesExpanded}
          ontogglereferences={toggleReferences}
        />
        {#if mode === "edit"}
          <div
            hidden={!showReferences || workScreenShown}
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
                {project}
                scope={`${workspaceGeneration}:${mode}:${screenId}:${editingSymbolId ?? ""}`}
                editable={mode === "edit"}
                {drafts}
                onedit={edit}
                expanded={referencesExpanded}
                sized={canSizeReferences && referencesExpanded}
                {references}
                onopen={openBinding}
                onclose={closeReferences}
              />
            {/key}
          </div>
        {/if}
      </div>
    </section>
  </ThreePaneDock>
</main>
{#snippet layersPane()}
  <div
    class="sidebar-pane"
    id="designer-layers-panel"
    data-designer-left-pane="layers"
    tabindex="-1"
  >
    <LayersPanel
      editing={mode === "edit"}
      {canvasActive}
      images={assetImages}
      tree={layerTreeBindings}
    />
  </div>
{/snippet}
{#snippet partsPane()}
  <div
    class="sidebar-pane"
    id="designer-parts-panel"
    data-designer-left-pane="parts"
    tabindex="-1"
  >
    <PartsPanel
      editing={mode === "edit"}
      {canvasActive}
      images={assetImages}
      definitions={project.symbols}
      allowSymbols={!activeDefinition}
      hasAlarmDefinitions={!!project.alarms?.definitions.length}
      contextKey={paletteContextKey}
      positionPlacement={placement.positionPlacement}
      {isFavorite}
      {isArmed}
      onarm={armPart}
      onimmediate={placeFavorite}
      ontoggleFavorite={toggleFavorite}
      onedit={editView.openDefinition}
      onduplicate={(id) => edit({ type: "duplicate-symbol", symbolId: id })}
      onadd={(kind) => choosePart({ type: "basic", kind })}
      onstartdrag={beginPartDrag}
      onenddrag={placement.endPaletteDrag}
      onbuiltin={(template) => choosePart({ type: "builtin", template })}
      onplace={(id) => choosePart({ type: "symbol", symbolId: id })}
    />
  </div>
{/snippet}
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
{#if arrayCopy.request}
  {#key arrayCopy.request}
    <ArrayCopyDialog
      sourceCount={arrayCopy.request.ids.length}
      existingCount={screen.objects.length}
      limit={activeDefinition ? 100 : 1000}
      stepX={arrayCopy.request.stepX}
      stepY={arrayCopy.request.stepY}
      onapply={arrayCopy.apply}
      onclose={arrayCopy.close}
    />
  {/key}
{/if}
<DraftPrompt guard={drafts} />
{#if recordingTrend.recordingView}
  {@const request = recordingTrend.recordingView}
  {#key request}
    <RecordingPlanDialog
      open={recordingTrend.currentRecordingRequest === request}
      project={request.project}
      readonly={request.readonly}
      error={recordingTrend.recordingError}
      onsave={(plan) => recordingTrend.saveRecordingPlan(request, plan)}
      onremove={() => recordingTrend.removeRecordingPlan(request)}
      onclose={() => recordingTrend.closeRecordingPlan(request)}
    />
  {/key}
{/if}
{#key workspaceGeneration}
  <EquipmentBindingTable
    open={bindingTableOpen && mode === "edit"}
    bind:dirty={bindingTableDirty}
    {project}
    {catalogSelection}
    onapply={applyBindingTable}
    onclose={() => (bindingTableOpen = false)}
  />
{/key}
{#if recordingTrend.currentTrendRequest}
  <TrendDefinitionsDialog
    {project}
    initialId={recordingTrend.currentTrendRequest.definitionId}
    error={recordingTrend.trendError}
    onsave={recordingTrend.saveTrend}
    onremove={recordingTrend.removeTrend}
    onclose={recordingTrend.closeTrendDefinitions}
  />
{/if}
<RecordingOperationsEntry
  openOwner={recordingOperationsOpen}
  {project}
  generation={workspaceGeneration}
  service={recordingOperationsService}
  asyncClient={recordingAsyncOperations}
  expectedRevisions={lastRecordingSummary?.service ===
  recordingManagementService
    ? lastRecordingSummary?.expected
    : undefined}
  onopenmanagement={() => {
    recordingOperationsOpen = null;
    openRecordingManagement();
  }}
  onclose={() => (recordingOperationsOpen = null)}
/>
<RecordingManagementWorkspace
  openOwner={recordingManagementOpen}
  {project}
  generation={workspaceGeneration}
  service={recordingManagementService}
  onclose={() => (recordingManagementOpen = null)}
  onopenplan={() => {
    recordingManagementOpen = null;
    recordingTrend.openRecordingPlan();
  }}
  onsummary={({ summary, inspectedAt, expected }) => {
    if (recordingManagementService)
      lastRecordingSummary = {
        service: recordingManagementService,
        summary,
        inspectedAt,
        expected,
      };
  }}
/>
<!-- 履歴トレンドの窓。運転表示の間はその中に描く（裏の UI は inert で、重なりも運転表示が上）。 -->
{#snippet historyWorkspace()}
  <HistoryWorkspace
    open={recordingTrend.historyOpen &&
      (!recordingTrend.historyPreset || !!recordingTrend.currentHistoryPreset)}
    preset={recordingTrend.currentHistoryPreset}
    onrelease={recordingTrend.releaseHistoryPreset}
    {project}
    generation={workspaceGeneration}
    service={historyService}
    controller={historyController}
    onclose={recordingTrend.closeHistory}
    focusFallback={() => {
      // Banto captures HTML openers. Its public fallback may restore SVG focus.
      const opener = recordingTrend.takeHistorySvgOpener();
      if (
        opener?.isConnected &&
        !opener.closest("[inert]") &&
        opener.getClientRects().length
      ) {
        opener.focus();
        return;
      }
      return document.querySelector<HTMLButtonElement>("[data-permanent-menu]");
    }}
  />
{/snippet}
<!-- アラーム一覧の窓。履歴トレンドと同じく運転表示の間はその中に描く。 -->
{#snippet overlays()}
  {@render historyWorkspace()}
  <AlarmListWindow
    open={runtimeWindows.alarmListOpen}
    snapshot={alarmSnapshot}
    feed={alarmFeed}
    readError={alarms.readError}
    projectId={project.manifest.projectId}
    projectRevision={project.manifest.projectRevision}
    onclose={runtimeWindows.closeAlarmList}
    onrefresh={refreshAlarm}
    onopensettings={openAlarmSettings}
    focusFallback={() => {
      const opener = runtimeWindows.takeAlarmListOpener();
      if (
        opener instanceof SVGElement &&
        opener.isConnected &&
        !opener.closest("[inert]") &&
        opener.getClientRects().length
      ) {
        opener.focus();
        return;
      }
      return document.querySelector<HTMLButtonElement>("[data-permanent-menu]");
    }}
  />
  <AlarmSettingsWindow
    open={runtimeWindows.alarmSettingsOpen}
    feed={alarmFeed}
    snapshot={alarmSnapshot}
    onclose={runtimeWindows.closeAlarmSettings}
    onrefresh={refreshAlarm}
    focusFallback={() => {
      const opener = runtimeWindows.takeAlarmSettingsOpener();
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !opener.closest("[inert]") &&
        opener.getClientRects().length
      )
        return opener;
      return document.querySelector<HTMLButtonElement>("[data-permanent-menu]");
    }}
  />
{/snippet}
{#if runtimeWindows.operatorStart === null}{@render overlays()}{/if}
<Modal
  open={helpOpen}
  title="操作ガイド・アプリ情報"
  onclose={() => (helpOpen = false)}
>
  <p>SCADA Designer 0.37.0 · Banto 基盤のローカル工程図エディタ</p>
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
    選択ツールで空白をドラッグすると、枠に完全に入る図形をまとめて選択します。Ctrl／⌘／Shiftで追加、Escで取消できます。パン・連続配置・表示プレビューでは範囲選択しません。
  </p>
  <p>
    キャンバスはホイールで縦スクロール、Shift＋ホイールで横スクロールします。編集キャンバス上のCtrl＋ホイールはポインタ位置を基準に拡大縮小します。Ctrl＋＋／－／0のキー操作はブラウザのページ倍率です。
  </p>
  <p>
    レイヤーのフォルダーは整理用で、座標・描画順・表示・ロックを継承しません。検索中は結果を一時展開し、解除すると開閉状態を戻します。配置の右クリック「配置の所属を変更」で移動先・ルートを選べます。新規配置と貼り付けは常にルートです。フォルダー行のF2は改名、Deleteは空削除の確認を開き、以前の配置選択を変更しません。
  </p>
  <p>
    「中心を水平方向／垂直方向に等間隔」は3単位以上で使えます。両端の中心を固定し、中間の配置だけを動かします。「隙間を水平方向／垂直方向に均等化」は回転後の外形間の隙間を揃え、両端を固定します。グループは一単位です。両端の間に収まらない場合は変更しません。どちらもスナップで丸めず、小数座標も保存します。中心等間隔では、サイズが違う配置の重なりが残る場合があります。
  </p>
  <p>
    「配列複製」は選択した配置を一組として、指定した行数・列数と間隔で複製します。行数・列数には元の組を含み、全体を一回のUndoで戻せます。グループは組ごとに独立します。機器・タグ・画像原本は同じ参照を使い、別の機器登録や名称の連番は行いません。
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
  open={editView.deleteConfirm !== null}
  title={editView.deleteConfirm?.kind === "symbol"
    ? "Symbol 定義を削除しますか"
    : "画面を削除しますか"}
  width="480px"
  onclose={editView.cancelDelete}
>
  {#if editView.deleteConfirm}
    <div data-delete-confirm>
      <p>
        {#if editView.deleteConfirm.kind === "screen"}
          「{editView.deleteConfirm.name}」と図形 {editView.deleteConfirm.count} 個を削除します。
        {:else}
          Symbol 定義「{editView.deleteConfirm.name}」（図形 {editView
            .deleteConfirm.count}
          個）を削除します。この定義を使う配置はありません。
        {/if}
        元に戻す（Ctrl+Z）で復元できます。
      </p>
      <div class="delete-confirm-actions">
        <button type="button" class="danger" onclick={editView.confirmDelete}
          >削除</button
        >
        <button type="button" onclick={editView.cancelDelete}>キャンセル</button
        >
      </div>
    </div>
  {/if}
</Modal>
<Modal
  open={replacement !== null}
  title="Project を置き換えますか"
  onclose={projectFiles.cancelReplacement}
>
  {#if projectFiles.native}
    <p>
      {#if projectChanged}
        現在の Project に未保存の変更があります。
      {:else}
        現在の内容を保存しました。
      {/if}
      「{replacement?.project.manifest.name}」を開く前に保存できます。
    </p>
    <p>保存しても自動では置き換えません。「破棄して開く」を選ぶと開きます。</p>
  {:else}
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
  {/if}
  <div class="actions">
    <button onclick={projectFiles.write}
      >{projectFiles.native
        ? "保存する"
        : project.assets.length
          ? "画像同梱で書き出す"
          : "JSON を書き出す"}</button
    ><button onclick={projectFiles.replaceNow}>破棄して開く</button><button
      onclick={projectFiles.cancelReplacement}>キャンセル</button
    >
  </div>
</Modal>
{#if runtimeWindows.operatorStart !== null}
  <OperatorView
    {project}
    startScreenId={runtimeWindows.operatorStart}
    images={assetImages}
    readings={readContext.readings}
    equipmentContext={readContext.equipmentContext}
    onclose={runtimeWindows.closeOperatorView}
    onmessage={(message) => report("error", message)}
    operations={simulatedOperations}
    onopentrend={recordingTrend.openTrendHistory}
    onretiretrend={recordingTrend.retirePopupTrend}
    onopenalarms={openAlarmList}
    onsilencebuzzer={alarmFeed?.silenceBuzzer ? silenceBuzzer : undefined}
    overlay={overlays}
  />
{/if}
<div
  class="toast-anchor"
  style:--banto-toast-right={inspectorShown &&
  !designerNarrow &&
  inspectorPaneWidth > 0
    ? `${inspectorPaneWidth + 16}px`
    : undefined}
  style:--banto-toast-bottom={mode === "edit" ? "40px" : undefined}
>
  <ToastHost store={toastStore} />
</div>

<style>
  .delete-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .delete-confirm-actions button.danger {
    border: 1px solid var(--banto-danger-solid);
    border-radius: 4px;
    background: var(--banto-danger-solid);
    color: #fff;
  }
  .canvas-area {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* ドックとミニマップは専用帯を持たず図面の上に重ねる。空いた所は図面へ素通しにする。 */
  .canvas-navigation {
    position: absolute;
    left: 0;
    right: 14px;
    bottom: 14px;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    padding-right: 8px;
    pointer-events: none;
  }
  .canvas-navigation > :global(*) {
    pointer-events: auto;
  }
  .canvas-navigation > :global(.minimap) {
    margin-left: auto;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--banto-surface) 92%, transparent);
    box-shadow: 0 3px 12px #316e8414;
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
  /* 左の pane の中身（#331 D2）。スクロールは dock の pane の本体が持つ。 */
  .sidebar-pane {
    min-height: 100%;
    padding: 6px 8px;
    outline: none;
  }
  .sidebar-pane:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
  }
  .inspector-pane {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  .save-state {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 340px;
    min-width: 0;
    height: 28px;
    font-size: 11px;
    color: var(--banto-text-muted);
  }
  .header-status {
    display: flex;
    flex: 0 1 auto;
    /* 幅が足りないとき、中身を左へこぼして表示モードやメニューに重ねない。 */
    justify-content: safe flex-end;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-left: auto;
  }
  .fullscreen-status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
  }
  .recording-status {
    display: inline-flex;
    flex-shrink: 0;
    /* 全体の button の幅指定で状態表示の幅いっぱいに伸び、警報の札を押し出していた。 */
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    cursor: pointer;
    font: inherit;
  }
  .recording-status:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .recording-status:disabled {
    cursor: default;
  }
  .selection-count {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--banto-text-muted);
    white-space: nowrap;
  }
  .save-label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .save-label :global(.status-badge) {
    box-sizing: border-box;
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .save-label :global(.status-badge svg) {
    display: inline-block;
    vertical-align: -2px;
    margin-right: 4px;
  }
  .draft-state {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 14px;
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
    /* Tauri の認証・Hub・記録・警報の札で1行に入らないときは、状態表示を2行目へ回す。 */
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    padding: 4px 12px;
    min-height: 40px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--banto-border);
    background: var(--banto-surface);
  }
  .header-extension {
    flex-shrink: 0;
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
    display: flex;
    flex: 1;
    min-height: 0;
  }
  main > :global(*) {
    flex: 1;
    min-width: 0;
  }
  [hidden] {
    display: none;
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
  :global(#app) .app-header.fullscreen-preview {
    display: none;
  }
  .canvas-stack {
    position: relative;
  }
  .canvas-area.covered {
    display: none;
  }
  /* 作業画面（作業タブ設計 §2.1）。 */
  .work-screen {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
  }
  .work-screen[hidden] {
    display: none;
  }
  .work-screen h2 {
    margin: 0 0 12px;
    font-size: 16px;
  }
  /* 作業タブ「警報の定義」（§2.2）。2列の切替は AlarmSettings の container query。 */
  .alarm-definitions-work,
  .equipment-work {
    container-type: inline-size;
  }
  /* 作業タブ「プロジェクト設定」（§2.2）。設定を縦に並べ、幅は入力に合わせて抑える。 */
  .project-settings-work {
    max-width: 520px;
  }
  .project-settings-work h3 {
    margin: 20px 0 4px;
    font-size: 14px;
  }
  .project-settings-work form {
    display: grid;
    gap: 8px;
    margin: 8px 0 12px;
  }
  .project-settings-work form label {
    display: grid;
    gap: 5px;
    font-size: 12px;
    color: var(--banto-text-muted);
    min-width: 0;
  }
  .project-settings-work form button,
  .project-settings-work .open-recording-plan {
    width: auto;
    justify-self: start;
  }
  .tab-strip {
    display: flex;
    flex-shrink: 0;
    min-width: 0;
    background: var(--studio-chrome);
  }
  .tab-strip > :global(nav[aria-label="画面タブ"]) {
    flex: 1 1 auto;
  }
  .tab-strip > :global(nav[aria-label="作業タブ"]) {
    border-bottom: 1px solid var(--banto-border);
  }
  .references-panel {
    position: relative;
  }
  /* dock が高さを決めるので、どの幅でも画面の高さに収める（#331 D2）。 */
  :global(#app) {
    height: 100dvh;
    overflow: hidden;
  }
  .designer-center {
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
  }
  @media (min-width: 1100px) {
    .designer-center {
      display: flex;
      flex-direction: column;
      padding: 12px 16px;
    }
    .designer-center > :not(.canvas-stack),
    .canvas-stack > :not(.canvas-area),
    .canvas-area > :not(:global(.canvas-workspace)) {
      flex-shrink: 0;
    }
    .canvas-area {
      flex: 1;
      min-height: 0;
    }
    .canvas-stack {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
  }
</style>
