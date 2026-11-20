import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditCommand } from "../../editor";
import type { Point, Project } from "../../project";
import {
  createEditViewController,
  type EditViewHost,
} from "./edit-view.svelte";
import type { WorkTabKind } from "./work-tabs.svelte";

function setup() {
  const definition = { id: "sym-1", name: "弁", objects: [] };
  const unused = { id: "sym-2", name: "未使用", objects: [{ id: "x" }] };
  const project = {
    screens: [
      {
        id: "screen-1",
        objects: [
          { id: "a", shape: { type: "symbol", symbolId: "sym-1" } },
          { id: "b", shape: { type: "rect" } },
        ],
      },
    ],
    symbols: [definition, unused],
  } as unknown as Project;
  const state = {
    project,
    workspaceGeneration: 0,
    mode: "edit" as "edit" | "preview",
    screenId: "screen-1",
    editingSymbolId: null as string | null,
    selectedIds: [] as string[],
    libraryId: "",
    selectedWorkTab: null as WorkTabKind | null,
    canvasZoom: 2 as number | null,
    center: { x: 10, y: 20 } as Point,
  };
  const calls: string[] = [];
  const edits: EditCommand[] = [];
  const canvas = {
    centerOn: (point: Point) =>
      void calls.push(`centerOn ${point.x},${point.y}`),
    visibleCenter: () => state.center,
    revealObject: () => void calls.push("revealObject"),
    cancelInteractions: () => void calls.push("cancelInteractions"),
    showSelection: () => true,
    zoom: (value: number | null) => {
      calls.push(`zoom ${value}`);
      state.canvasZoom = value;
    },
  };
  const activeDefinition = () =>
    state.project.symbols.find((s) => s.id === state.editingSymbolId);
  const host: EditViewHost = {
    get project() {
      return state.project;
    },
    get workspaceGeneration() {
      return state.workspaceGeneration;
    },
    get mode() {
      return state.mode;
    },
    set mode(value) {
      state.mode = value;
    },
    get screenId() {
      return state.screenId;
    },
    set screenId(value) {
      state.screenId = value;
    },
    get editingSymbolId() {
      return state.editingSymbolId;
    },
    set editingSymbolId(value) {
      state.editingSymbolId = value;
    },
    get selectedIds() {
      return state.selectedIds;
    },
    set selectedIds(value) {
      state.selectedIds = value;
    },
    get libraryId() {
      return state.libraryId;
    },
    set libraryId(value) {
      state.libraryId = value;
    },
    get screen() {
      return (
        activeDefinition() ??
        state.project.screens.find((s) => s.id === state.screenId)!
      );
    },
    get activeDefinition() {
      return activeDefinition();
    },
    get canvasActive() {
      return state.mode === "edit" && state.selectedWorkTab === null;
    },
    get workScreenShown() {
      return (
        state.mode === "edit" &&
        !activeDefinition() &&
        state.selectedWorkTab !== null
      );
    },
    get selectedWorkTab() {
      return state.selectedWorkTab;
    },
    menuBlocked: false,
    get canvasZoom() {
      return state.canvasZoom;
    },
    canvasWorkspace: canvas,
    selectionViewReason: "",
    selectionViewTarget: { clippedCount: 0, outsideCount: 0 },
    transition: (action) => action(),
    allow: () => true,
    selectWorkTabNow(kind) {
      calls.push(`selectWorkTabNow ${kind}`);
      state.selectedWorkTab = kind;
    },
    report: (kind, text) => void calls.push(`${kind} ${text}`),
    edit(command) {
      edits.push(command);
      return true;
    },
    stopPlacement: () => void calls.push("stopPlacement"),
    showSidebar: () => void calls.push("showSidebar"),
    scrollEditorTop: () => void calls.push("scrollEditorTop"),
    revealLayerObject: () => void calls.push("revealLayerObject"),
    travelHistory: () => {
      throw new Error("not used");
    },
    commitHistory: () => {
      throw new Error("not used");
    },
  };
  const view = createEditViewController(host);
  return { view, state, calls, edits, project };
}

/** `restoreEditView` は tick の後に rAF を 2 回待ってから表示中心を戻す。 */
async function settle() {
  await tick();
  await Promise.resolve();
}

describe("edit view controller", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("表示位置と選択を控え、復元は描画の後に倍率と中心を戻す", async () => {
    const { view, state, calls } = setup();
    state.selectedIds = ["b"];
    view.rememberEditView();

    state.selectedIds = [];
    state.canvasZoom = 1;
    state.center = { x: 99, y: 99 };
    view.restoreEditView();
    expect(state.selectedIds).toEqual(["b"]);
    // スクロールの復元は描画の後（tick → rAF 2 回）。
    expect(calls).toEqual([]);
    await settle();
    expect(calls).toEqual(["zoom 2", "centerOn 10,20"]);
  });

  it("W5: キャンバスが隠れているときは控えを上書きしない", () => {
    const { view, state } = setup();
    state.selectedIds = ["b"];
    view.rememberEditView();

    state.selectedWorkTab = "equipment";
    state.selectedIds = ["a"];
    view.rememberEditView();
    state.selectedWorkTab = null;
    state.selectedIds = [];
    view.restoreEditView();
    expect(state.selectedIds).toEqual(["b"]);
  });

  it("定義の編集へは画面タブを選んでから入り、戻ると元の画面と選択に戻る", async () => {
    const { view, state, calls } = setup();
    state.selectedIds = ["a", "b"];
    view.openDefinition("sym-1");
    expect(calls).toEqual(["showSidebar", "selectWorkTabNow null"]);
    expect(state.editingSymbolId).toBe("sym-1");
    expect(state.libraryId).toBe("sym-1");
    expect(state.selectedIds).toEqual([]);

    view.returnFromDefinition();
    expect(state.editingSymbolId).toBeNull();
    expect(state.screenId).toBe("screen-1");
    // 入口になった配置（その定義を参照する配置）だけを選び直す。
    expect(state.selectedIds).toEqual(["a"]);
    await settle();
    expect(calls).toContain("centerOn 10,20");
  });

  it("表示プレビューから入った定義の編集は、戻っても選択を戻さない", () => {
    const { view, state } = setup();
    state.mode = "preview";
    state.selectedIds = ["b"];
    view.openDefinition("sym-1");
    view.returnFromDefinition();
    expect(state.editingSymbolId).toBeNull();
    expect(state.selectedIds).toEqual([]);
  });

  it("削除確認を取り消すと何も変わらない", () => {
    const { view, state, edits, project } = setup();
    view.deleteDefinition("sym-1");
    // 使用中の定義は確認を出さない。
    expect(view.deleteConfirm).toBeNull();

    view.deleteDefinition("sym-2");
    expect(view.deleteConfirm).toEqual({
      kind: "symbol",
      id: "sym-2",
      name: "未使用",
      count: 1,
    });
    view.cancelDelete();
    expect(view.deleteConfirm).toBeNull();
    view.confirmDelete();
    expect(edits).toEqual([]);
    expect(state.project).toBe(project);

    view.askDelete({ kind: "screen", id: "screen-1", name: "画面", count: 2 });
    view.cancelDelete();
    view.confirmDelete();
    expect(edits).toEqual([]);
  });

  it("確認した削除だけを 1 回の編集コマンドにする", () => {
    const { view, edits } = setup();
    view.askDelete({ kind: "screen", id: "screen-1", name: "画面", count: 2 });
    view.confirmDelete();
    view.confirmDelete();
    expect(edits).toEqual([{ type: "remove-screen", screenId: "screen-1" }]);
  });
});
