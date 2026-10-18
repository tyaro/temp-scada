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
    setThemeMode,
    getMenubarVisible,
    setMenubarVisible,
    toastStore,
  } from "./lib/banto/setup";
  import DesignerMenubar, {
    type DesignerMenu,
  } from "./lib/designer/DesignerMenubar.svelte";
  import { settleMenuFocus } from "./lib/designer/settle-menu-focus";
  let theme = $state(getThemeMode());
  let showMenubar = $state(getMenubarVisible());
  let projectFileInput: HTMLInputElement;
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
  import { untrack, tick } from "svelte";
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
  import type { Project } from "./lib/project";
  import sample from "../../../examples/minimal.project.json";
  import processSample from "../../../examples/process.project.json";
  import CanvasWorkspace, {
    type CanvasView,
    type CanvasContext,
  } from "./lib/designer/CanvasWorkspace.svelte";
  import CanvasControls from "./lib/designer/CanvasControls.svelte";
  import DesignerSidebar, {
    type DesignerPanel,
  } from "./lib/designer/DesignerSidebar.svelte";
  let activePanel = $state<DesignerPanel>("project");
  function revealDraftForm(form: HTMLFormElement) {
    if (form.dataset.editorForm === "screen") {
      setAuxPanelVisibility({ sidebar: true });
      activePanel = "project";
    } else setInspectorVisibility(true);
  }
  import EditToolbar, {
    type ToolbarGroup,
  } from "./lib/designer/EditToolbar.svelte";
  import InspectorPanel from "./lib/designer/InspectorPanel.svelte";
  let showInspector = $state(true);
  let showSidebar = $state(true);
  let showReferences = $state(true);
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
  function dropPalettePart(token: string, center: Point) {
    const drag = paletteDrag;
    if (!drag || drag.token !== token || !canDropPart()) return;
    paletteDrag = null;
    // Capture the target and point before the draft prompt; never retarget a deferred drop.
    transition(() => {
      if (
        mode !== "edit" ||
        drag.generation !== workspaceGeneration ||
        drag.target !== screen.id
      ) {
        report(
          "error",
          "配置先が変わったため、部品をもう一度ドラッグしてください。",
        );
        return;
      }
      const part = drag.part;
      if (activeDefinition && part.type !== "basic") return;
      if (part.type === "basic")
        edit({ type: "add", screenId: screen.id, kind: part.kind, center });
      else if (part.type === "builtin")
        edit({
          type: "add-symbol",
          screenId: screen.id,
          template: part.template,
          center,
        });
      else
        edit({
          type: "place-symbol",
          screenId: screen.id,
          symbolId: part.symbolId,
          center,
        });
    });
  }
  import SymbolLibrary from "./lib/designer/SymbolLibrary.svelte";
  import {
    parseProject,
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
  );
  function transition(action: () => void) {
    if (drafts.allow(action)) action();
  }
  let history = $state<EditHistory>(emptyHistory());
  let workspaceGeneration = $state(0);
  let canvasWorkspace = $state<{
    visibleCenter: () => Point;
    preparePanelResize: () => void;
    zoom: (value: number | null) => void;
    stepZoom: (direction: number) => void;
    setHand: (value: boolean) => void;
  }>();
  let canvasView = $state<CanvasView>({
    hand: false,
    zoom: null,
    scale: 1,
    fit: 1,
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
  function shortcut(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey))
      return;
    const key = event.key.toLowerCase();
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      if (!busy) save();
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
      transition(() => (selectedIds = screen.objects.map((o) => o.id)));
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
    return [...selectedIds];
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
  function moveSelection(event: SubmitEvent) {
    submitForm(event);
  }
  let project = $state(parseProject(JSON.stringify(sample)));
  let editorRegion = $state<HTMLElement>();
  let inspectorPanel = $state<HTMLElement>();
  const references = $derived(bindingReferences(project));
  function openBinding(usage: BindingUsage) {
    transition(() => {
      setInspectorVisibility(true);
      editingSymbolId = null;
      screenId = usage.screenId;
      selectedIds = [usage.objectId];
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
  function normalizeTargets() {
    if (
      editingSymbolId &&
      !project.symbols.some((s) => s.id === editingSymbolId)
    )
      editingSymbolId = null;
  }
  function openDefinition(id: string) {
    if (!drafts.allow(() => openDefinition(id))) return;
    setAuxPanelVisibility({ sidebar: true });
    editingSymbolId = id;
    activePanel = "project";
    libraryId = id;
    selectedIds = [];
  }
  function deleteDefinition(id: string) {
    if (!drafts.allow(() => deleteDefinition(id))) return;
    const definition = project.symbols.find((s) => s.id === id);
    if (
      definition &&
      window.confirm(`「${definition.name}」の Symbol 定義を削除しますか？`)
    )
      edit({ type: "remove-symbol", symbolId: id });
  }
  let screen = $derived(
    activeDefinition ??
      project.screens.find((s) => s.id === screenId) ??
      project.screens[0],
  );
  let message = $state("サンプルを表示しています。Hub には接続していません。");
  let busy = $state(false);
  let baseline = $state(untrack(() => projectContent(project)));
  let baselineSource = $state<"sample" | "file" | "download">("sample");
  let lastExport = $state<string | null>(null);
  let projectChanged = $derived(projectContent(project) !== baseline);
  let replacement = $state<{
    project: Project;
    source: "sample" | "file";
  } | null>(null);
  const saveLabel = $derived(
    projectChanged
      ? "未書き出しの変更あり"
      : baselineSource === "download"
        ? "書き出し要求後の変更なし"
        : baselineSource === "file"
          ? "読込後の変更なし"
          : "サンプルからの変更なし",
  );
  function adopt(next: Project, source: "sample" | "file") {
    project = next;
    baseline = projectContent(next);
    baselineSource = source;
    lastExport = null;
    history = emptyHistory();
    workspaceGeneration++;
    screenId = project.screens[0].id;
    editingSymbolId = null;
    selectedIds = [];
    report(
      "info",
      source === "sample"
        ? "工程図サンプルを開きました。設備や計測値には接続していません。"
        : "Project を読み込みました。",
    );
  }
  function requestReplacement(next: Project, source: "sample" | "file") {
    if (!drafts.allow(() => requestReplacement(next, source))) return;
    if (projectChanged) replacement = { project: next, source };
    else adopt(next, source);
  }
  function replaceNow() {
    const next = replacement;
    replacement = null;
    if (next) adopt(next.project, next.source);
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
  function edit(command: EditCommand, form?: HTMLFormElement): boolean {
    if (form ? !drafts.beforeSubmit(form) : !drafts.allow(() => edit(command)))
      return false;
    try {
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
        if (form) drafts.submitted(form);
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
      } else if (command.type === "remove-symbol") selectedIds = [];
      if (
        command.type === "create-screen" ||
        command.type === "duplicate-screen"
      ) {
        screenId = project.screens.find((s) => !oldScreens.has(s.id))!.id;
        selectedIds = [];
      } else if (command.type === "remove-screen") {
        screenId = project.screens[0].id;
        selectedIds = [];
      }
      if (
        command.type === "add" ||
        command.type === "add-symbol" ||
        command.type === "place-symbol" ||
        command.type === "duplicate" ||
        command.type === "duplicate-many"
      )
        selectedIds = screen.objects
          .filter((o) => !oldIds.has(o.id))
          .map((o) => o.id);
      if (command.type === "remove" || command.type === "remove-many")
        selectedIds = [];
      if (form) drafts.submitted(form);
      report(
        "success",
        "変更を適用しました。JSON を保存するとファイルに残せます。",
      );
      return true;
    } catch (e) {
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
  function removeScreen() {
    if (!drafts.allow(removeScreen)) return;
    if (window.confirm(`「${screen.name}」と画面内の図形を削除しますか？`))
      edit({ type: "remove-screen", screenId: screen.id });
  }
  function add(kind: AddKind) {
    edit({ type: "add", screenId: screen.id, kind });
  }
  function formCommand(form: HTMLFormElement): EditCommand {
    const data = new FormData(form);
    if (form.dataset.editorForm === "screen")
      return {
        ...(activeDefinition
          ? { type: "update-symbol" as const, symbolId: activeDefinition.id }
          : { type: "update-screen" as const, screenId: screen.id }),
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
      x: Number(data.get("x")),
      y: Number(data.get("y")),
      fill: String(data.get("fill")),
    };
    if ("width" in selected) {
      patch.width = Number(data.get("width"));
      patch.height = Number(data.get("height"));
    }
    if (selected.shape.type === "text") {
      patch.text = String(data.get("text"));
      if (!activeDefinition) {
        const externalName = String(data.get("externalName") ?? "");
        patch.binding = externalName === "" ? null : { externalName };
      }
    }
    if (selected.shape.type === "symbol")
      patch.symbolId = String(data.get("symbolId"));
    if (selected.shape.type === "polyline") {
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
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
  function submitForm(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
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

  async function load(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    busy = true;
    try {
      if (file.size > 1024 * 1024)
        throw new Error("ファイルは 1 MiB 以下にしてください");
      const next = parseProject(await file.text());
      requestReplacement(next, "file");
    } catch (e) {
      report(
        "error",
        `読込エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      busy = false;
      input.value = "";
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
  let contextKind = $state<"selection" | "blank">("blank");
  let contextRequest = $state(0);
  let contextPoint = $state<Point | null>(null);
  const contextScope = $derived(
    `${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${mode}:${selectedIds.join(",")}:${activePanel}:${showSidebar}:${showInspector}:${snapEnabled}:${gridSize}:${contextKind}:${busy}:${!!drafts.pending}:${!!replacement}:${contextRequest}`,
  );
  function objectLabel(object: ScreenObject) {
    return `${object.shape.type === "symbol" ? (project.symbols.find((d) => object.shape.type === "symbol" && d.id === object.shape.symbolId)?.name ?? "Symbol") : object.shape.type} · ${object.order}`;
  }
  const selectionContextLabel = $derived(
    contextKind === "blank"
      ? "キャンバス"
      : selectedIds.length > 1
        ? `選択図形（${selectedIds.length} 件）`
        : selected
          ? objectLabel(selected)
          : "選択図形",
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
  const editToolbarGroups: ToolbarGroup[] = $derived([
    {
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
      label: "選択と編集",
      items: [
        {
          label: "すべて選択",
          icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M7 7H17V17H7Z",
          disabled: editBlocked || !screen.objects.length,
          run: () =>
            transition(() => (selectedIds = screen.objects.map((o) => o.id))),
        },
        {
          label: "選択解除",
          icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M8 8L16 16M16 8L8 16",
          disabled: editBlocked || !selectedIds.length,
          run: () => transition(() => (selectedIds = [])),
        },
        {
          label: "選択図形を複製",
          icon: "M9 9H21V21H9ZM15 5V3H3V15H5",
          disabled: editBlocked || !selectedIds.length,
          run: duplicateSelection,
        },
        {
          label: "選択図形を削除",
          icon: "M3 6H21M9 6V3H15V6M6 6L7 21H17L18 6M10 10V17M14 10V17",
          disabled: editBlocked || !selectedIds.length,
          run: removeSelection,
        },
      ],
    },
    {
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
        disabled: editBlocked || selectedIds.length !== 1,
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
      label: "整列（複数選択）",
      items: [
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
        disabled: editBlocked || selectedIds.length < 2,
        run: () =>
          edit({
            type: "align",
            screenId: screen.id,
            objectIds: [...selectedIds],
            alignment: item.alignment,
          }),
      })),
    },
  ]);
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
        editToolbarGroups[1].items[0],
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
      ...editToolbarGroups[1].items.slice(2),
      ...(selectedIds.length > 1
        ? editToolbarGroups[3].items
        : editToolbarGroups[2].items),
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
              disabled: editBlocked || project.symbols.length >= 100,
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
  const menuGroups: DesignerMenu[] = $derived([
    {
      label: "ファイル",
      items: [
        {
          label: "Project JSON を開く",
          disabled: menuBlocked,
          run: () => projectFileInput.click(),
        },
        { label: "Project JSON を保存", disabled: menuBlocked, run: save },
        {
          label: "工程図サンプルを開く",
          disabled: menuBlocked,
          run: showProcessSample,
        },
      ],
    },
    {
      label: "編集",
      items: editToolbarGroups.flatMap((group) => group.items),
    },
    {
      label: "表示",
      items: [
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

<svelte:window onkeydown={shortcut} onbeforeunload={beforeLeave} />

<svelte:head
  ><meta
    name="description"
    content="Banto SCADA の初期 Project エディタ"
  /></svelte:head
>
<header class="app-header">
  <h1 title={project.manifest.name}>{project.manifest.name}</h1>
  <div class="header-actions" use:settleMenuFocus>
    <Menu label="常設メニュー" placement="bottom-end">
      {#snippet trigger(props)}
        <button {...props} data-permanent-menu>メニュー</button>
      {/snippet}
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
{#if showMenubar}<DesignerMenubar groups={menuGroups} />{/if}
<EditToolbar
  groups={mode === "edit" ? editToolbarGroups : []}
  selectionCount={selectedIds.length}
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
        bind:showGrid
        bind:snapEnabled
        bind:gridSize
        onhand={(value) => canvasWorkspace?.setHand(value)}
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
<main
  class:editing={mode === "edit"}
  class:sidebar-visible={mode !== "edit" || showSidebar}
  class:inspector-visible={showInspector && mode === "edit"}
>
  <aside
    class="project-sidebar"
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
        <button onclick={showProcessSample} disabled={busy}
          >工程図サンプルを開く</button
        >
        <p>画面を選んで表示します。</p>
        <nav aria-label="画面一覧">
          {#each project.screens as item}<button
              class:active={screen.id === item.id}
              aria-pressed={screen.id === item.id}
              onclick={() =>
                transition(() => {
                  screenId = item.id;
                  editingSymbolId = null;
                  selectedIds = [];
                })}>{item.name}</button
            >{/each}
        </nav>
        {#if mode === "edit"}
          <SymbolLibrary
            {project}
            selectedId={libraryId}
            screenId={screen.id}
            editingDefinition={!!activeDefinition}
            onchoose={(id) => (libraryId = id)}
            onedit={openDefinition}
            ondelete={deleteDefinition}
            oncommand={edit}
          />
          <hr />
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
              onclick={removeScreen}>画面を削除</button
            >
          {/if}
          {#key screen}
            <form
              use:drafts.track
              data-editor-form="screen"
              onsubmit={screenProperties}
              aria-label="画面設定"
            >
              <label
                >{activeDefinition ? "Symbol 名" : "画面名"}<input
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
        {/if}
      {/snippet}
      {#snippet layersPanel()}
        {#if mode === "edit"}
          <h2>レイヤー（配置一覧）</h2>
          <p>
            {screen.name} · {selectedIds.length} 件選択。下の配置ほど前面です。
          </p>
          <nav aria-label="図形一覧">
            {#each [...screen.objects].sort((a, b) => a.order - b.order) as object (object.id)}
              <div class="layer-entry">
                <button
                  class:active={selectedIds.includes(object.id)}
                  aria-pressed={selectedIds.includes(object.id)}
                  data-layer-id={object.id}
                  onclick={(event) => selectObjects(object.id, event.shiftKey)}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    layerContext(object.id, event.currentTarget);
                  }}
                  onkeydown={(event) => layerContextKey(event, object.id)}
                  >{objectLabel(object)}</button
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
            {/each}
          </nav>
        {/if}
      {/snippet}
      {#snippet partsPanel()}
        {#if mode === "edit"}
          <PartPalette
            contextKey={`${workspaceGeneration}:${project.manifest.projectRevision}:${screen.id}:${selectedIds.join(",")}:${activePanel}:${showSidebar}`}
            onedit={openDefinition}
            onduplicate={(id) =>
              edit({ type: "duplicate-symbol", symbolId: id })}
            definitions={project.symbols}
            allowSymbols={!activeDefinition}
            onadd={add}
            onstartdrag={startPaletteDrag}
            onenddrag={() => (paletteDrag = null)}
            onbuiltin={(template) =>
              edit({ type: "add-symbol", screenId: screen.id, template })}
            onplace={(id) =>
              edit({ type: "place-symbol", screenId: screen.id, symbolId: id })}
          />
        {/if}
      {/snippet}
    </DesignerSidebar>
    <div class="sidebar-files">
      <label class="file"
        >Project JSON を開く<input
          aria-label="Project JSON を開く"
          bind:this={projectFileInput}
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onchange={load}
        /></label
      ><button onclick={save} disabled={busy}>Project JSON を保存</button>
      <p class="hint">
        編集した Project は JSON
        を保存してください。表示プレビューは見た目の確認用です。設備接続や正式な
        Runtime の権限分離は未実装です。
      </p>
    </div>
  </aside>
  <section aria-label="画面プレビュー" bind:this={editorRegion}>
    {#if activeDefinition}
      <div class="definition-banner" role="note">
        <strong
          >Symbol 定義を編集中 · {symbolUsage(project, activeDefinition.id)} 配置で共有</strong
        >
        <p>
          確定した変更は全画面の参照配置へ反映されます。配置時は配置側の単色を使います。別の形にする場合は定義を複製してください。
        </p>
        <button
          onclick={() =>
            transition(() => {
              editingSymbolId = null;
              selectedIds = [];
            })}>画面へ戻る</button
        >
      </div>
    {/if}
    <div class="toolbar">
      <h2>{screen.name}</h2>
      <span
        >{activeDefinition ? "SYMBOL" : "SCREEN"} · {screen.width} × {screen.height}
        · {screen.objects.length} 図形 · rev {project.manifest
          .projectRevision}</span
      >
    </div>
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
        {snapEnabled}
        {gridSize}
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
        onselect={selectObjects}
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
    <p role="status" data-testid="project-status">{message}</p>
    {#if mode === "edit"}
      <div
        hidden={!showReferences}
        bind:this={referencesPanel}
        tabindex="-1"
        role="region"
        aria-label="タグ参照パネル"
      >
        {#key workspaceGeneration}
          <BindingReferences
            {references}
            onopen={openBinding}
            onclose={() =>
              setAuxPanelVisibility({ references: false }, "references")}
          />
        {/key}
      </div>
    {/if}
  </section>
  {#if mode === "edit"}
    <InspectorPanel
      bind:element={inspectorPanel}
      visible={showInspector}
      onclose={() => setInspectorVisibility(false, true)}
      {project}
      {selectedIds}
      {selected}
      activeDefinition={!!activeDefinition}
      {screen}
      {drafts}
      {properties}
      {moveSelection}
      {edit}
      {openDefinition}
    />
  {/if}
</main>
<ContextActions
  floating
  bind:this={selectionMenu}
  label={selectionContextLabel}
  contextKey={contextScope}
  items={selectionContextItems}
/>
<DraftPrompt guard={drafts} />
<Modal
  open={helpOpen}
  title="操作ガイド・アプリ情報"
  onclose={() => (helpOpen = false)}
>
  <p>SCADA Designer 0.3.0 · Banto 基盤のローカル工程図エディタ</p>
  <p>
    左で画面・部品を選び、図形をクリックして右のプロパティで編集します。未適用の入力は「変更を適用」で確定し、Project
    JSON を保存してください。
  </p>
  <p>
    Ctrl / Command + S：JSON 保存、Z：元に戻す、Shift +
    Z：やり直す、A：全選択、D：複製。入力欄では保存以外の編集ショートカットを実行しません。
  </p>
  <p>
    メニューバーは左右キー、項目は上下キー、Enter / Space で実行、Esc
    で閉じます。メニューバー・左パネル・プロパティ・タグ参照一覧は、上部の「メニュー」→「表示」から隠す／復元できます。
    「補助パネルをすべて隠す」からは直前の表示に戻せます。個別の表示切替を行うと、一時的な一括非表示を終了します。
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
  .layer-entry {
    position: relative;
  }
  .layer-entry > button:first-child {
    padding-right: 26px;
  }
  .layer-entry .layer-more {
    position: absolute;
    right: 3px;
    top: 5px;
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
    .layer-entry .layer-more {
      opacity: 1;
    }
  }
  .sidebar-files {
    padding: 8px 14px;
    border-top: 1px solid var(--banto-border);
    flex-shrink: 0;
  }
  .sidebar-files .hint {
    display: none;
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
  button,
  .file {
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
  .file input {
    display: block;
    width: 100%;
    margin-top: 10px;
    font-size: 11px;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--banto-border);
    margin: 18px 0;
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
    main.editing.inspector-visible {
      grid-template-columns: minmax(0, 1fr) 288px;
    }
    main.editing.sidebar-visible.inspector-visible {
      grid-template-columns: 240px minmax(0, 1fr) 288px;
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
    main > section > :not(:global(.viewport)) {
      flex-shrink: 0;
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
