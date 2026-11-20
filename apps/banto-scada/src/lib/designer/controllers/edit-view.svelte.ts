import { tick } from "svelte";
import { symbolUsage, type EditCommand } from "../../editor";
import type { EquipmentUsage } from "../../equipment";
import { expandGroupSelection } from "../../geometric-groups";
import type { EditHistory } from "../../history";
import type { Point, Project, Screen, SymbolDefinition } from "../../project";
import type { SelectionTarget } from "../../selection-view";
import type { SymbolUsage } from "../../symbol-usages";
import type { ReportOptions } from "../toast-policy";
import {
  rememberReturnView,
  restoredSelection,
  type ReturnViews,
} from "../return-view";
import type { WorkTabChange, WorkTabKind } from "./work-tabs.svelte";

/** 削除確認（Banto の Modal）の対象。 */
export type DeleteConfirm = {
  kind: "screen" | "symbol";
  id: string;
  name: string;
  count: number;
};

/** controller が使うキャンバスの操作（`CanvasWorkspace` の一部）。 */
export interface EditViewCanvas {
  centerOn(point: Point): void;
  visibleCenter(): Point;
  revealObject(id: string): void;
  cancelInteractions(): void;
  showSelection(): boolean;
  zoom(value: number | null): void;
}

/**
 * 作業タブの出入り・定義の編集への出入り・表示位置の記憶と復元・Undo／Redo の
 * 画面遷移（R7g）。作業タブの並びと選択は `work-tabs.svelte.ts` が持ち、ここは
 * その切替（`workTabChanging`）に表示位置の控えと復元を結ぶ。
 *
 * 状態は host の getter／setter、draft の確認（`allow`）・作業タブの選択・履歴の
 * 計算と確定・`edit` などは host の callback で受ける。共通の edit／draft／history
 * の境界（`transition`・`drafts`・`history`）は App に残す。`transition` は draft の
 * ゲートで、作業タブ・記録計画などほかの controller も同じものを受けるため。
 * 画面・定義が変わったら画面タブを選ぶ `$effect`（W10 の安全網）は App に残し、
 * `showCanvas` を呼ぶ。
 */
export interface EditViewHost {
  readonly project: Project;
  readonly workspaceGeneration: number;
  mode: "edit" | "preview";
  screenId: string;
  editingSymbolId: string | null;
  selectedIds: string[];
  libraryId: string;
  /** 表示中の画面か、編集中の Symbol 定義。 */
  readonly screen: Screen | SymbolDefinition;
  readonly activeDefinition: SymbolDefinition | undefined;
  readonly canvasActive: boolean;
  readonly workScreenShown: boolean;
  readonly selectedWorkTab: WorkTabKind | null;
  readonly menuBlocked: boolean;
  /** `canvasView.zoom`。 */
  readonly canvasZoom: number | null;
  readonly canvasWorkspace: EditViewCanvas | undefined;
  readonly selectionViewReason: string;
  readonly selectionViewTarget: Pick<
    SelectionTarget,
    "clippedCount" | "outsideCount"
  >;
  /** draft の確認を経て `action` を呼ぶ（App の `transition`）。 */
  transition(action: () => void): void;
  /** draft の確認（`drafts.allow`）。保留したときは確定後に `retry` を呼ぶ。 */
  allow(retry: () => void): boolean;
  /** 作業タブをゲートなしで選ぶ（`workTabs.selectNow`）。 */
  selectWorkTabNow(kind: WorkTabKind | null): void;
  report(kind: "info" | "error", text: string, options?: ReportOptions): void;
  edit(command: EditCommand): boolean;
  stopPlacement(): void;
  /** 左のサイドバーを表示する（`setAuxPanelVisibility({ sidebar: true })`）。 */
  showSidebar(): void;
  scrollEditorTop(): void;
  revealLayerObject(id: string): void;
  /** 今の Project と履歴で Undo／Redo を計算する（確定はしない）。 */
  travelHistory(direction: "undo" | "redo"): {
    project: Project;
    history: EditHistory;
  };
  /** 計算した Project と履歴を確定する。 */
  commitHistory(result: { project: Project; history: EditHistory }): void;
}

export function createEditViewController(host: EditViewHost) {
  let deleteConfirm = $state<DeleteConfirm | null>(null);

  function travel(direction: "undo" | "redo") {
    if (!host.allow(() => travel(direction))) return;
    try {
      const result = host.travelHistory(direction);
      if (result.project === host.project) return;
      // W11: 画面または Symbol が変わる Undo／Redo は画面タブへ戻す（travel は allow 済み）。
      // 履歴はスナップショットから復元するので、配列の同一性ではなく内容で比べる。
      if (
        host.workScreenShown &&
        (JSON.stringify(result.project.screens) !==
          JSON.stringify(host.project.screens) ||
          JSON.stringify(result.project.symbols) !==
            JSON.stringify(host.project.symbols))
      )
        returnToCanvas();
      host.commitHistory(result);
      if (!host.project.screens.some((s) => s.id === host.screenId))
        host.screenId = host.project.screens[0].id;
      normalizeTargets();
      host.selectedIds = host.selectedIds.filter((id) =>
        host.screen.objects.some((o) => o.id === id),
      );
      host.report(
        "info",
        direction === "undo" ? "元に戻しました。" : "やり直しました。",
        { toast: false },
      );
    } catch (e) {
      host.report(
        "error",
        `履歴エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function showSelection() {
    if (host.selectionViewReason) return;
    try {
      if (!host.canvasWorkspace?.showSelection()) return;
      const { clippedCount, outsideCount } = host.selectionViewTarget;
      if (clippedCount || outsideCount)
        host.report(
          "info",
          `画面外の部分は表示していません。完全に画面外の配置 ${outsideCount} 件。選択は保持しています。`,
        );
    } catch (error) {
      host.report(
        "error",
        error instanceof Error ? error.message : "選択範囲を表示できません。",
      );
    }
  }

  // 作業タブを開く前のキャンバス（W5）。画面タブへ戻ったとき同じ画面なら表示位置を戻す。
  let canvasReturn: { generation: number; screenId: string } | null = null;
  function workTabChanging({ previous, next, cause }: WorkTabChange) {
    if (cause === "reset") {
      canvasReturn = null;
      return;
    }
    if (previous === null && next !== null && host.canvasActive) {
      // キャンバスを隠す直前（ゲート通過後の action 内）に控える。
      host.stopPlacement();
      host.canvasWorkspace?.cancelInteractions();
      rememberEditView();
      canvasReturn = {
        generation: host.workspaceGeneration,
        screenId: host.screen.id,
      };
    } else if (previous !== null && next === null) {
      // 使用先へ移動などの遷移は自分で表示位置を決めるので、画面タブを選び直す
      // 操作（タブの選択・閉じる・画面を開く・Undo）のときだけ戻す。
      const target = cause === "now" && !restoringCanvas ? null : canvasReturn;
      canvasReturn = null;
      void tick().then(() => {
        if (
          !target ||
          target.generation !== host.workspaceGeneration ||
          target.screenId !== host.screen.id ||
          !host.canvasActive ||
          host.activeDefinition
        )
          return;
        restoreEditView();
      });
    }
    if (cause === "open" && next)
      void tick().then(() =>
        document
          .querySelector<HTMLElement>(`[data-work-screen="${next}"] h2`)
          ?.focus(),
      );
    else if (cause === "close")
      void tick().then(() => {
        const selected = host.selectedWorkTab;
        document
          .querySelector<HTMLElement>(
            selected
              ? `[data-work-tab="${selected}"]`
              : 'nav[aria-label="画面タブ"] [aria-current="page"]',
          )
          ?.focus({ preventScroll: true });
      });
  }
  /** W6・W10: キャンバス・Inspector・下部の帯へ向かう処理の前に画面タブを選ぶ（ゲートなし）。 */
  function showCanvas() {
    host.selectWorkTabNow(null);
  }
  let restoringCanvas = false;
  /** 画面タブを選び直す（同じ画面なら、作業タブを開く前の表示位置と選択を戻す）。 */
  function returnToCanvas() {
    restoringCanvas = true;
    try {
      host.selectWorkTabNow(null);
    } finally {
      restoringCanvas = false;
    }
  }
  /**
   * W10: 画面タブを選び直し（ゲート通過済みの action の中で呼ぶ）、キャンバスが表示されて
   * 表示位置の復元（`workTabChanging` の tick 後の `restoreEditView`、さらに tick と
   * rAF 2回）が終わってから `action` を呼ぶ。rAF を1回多く待って復元の後に並べる。
   */
  function afterCanvasReturn(action: () => void) {
    const generation = host.workspaceGeneration;
    returnToCanvas();
    void tick().then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (generation !== host.workspaceGeneration || !host.canvasActive)
              return;
            action();
          }),
        ),
      ),
    );
  }

  // 中央の「画面へ戻る」（Symbol 定義の編集から戻る）。
  function returnFromDefinition() {
    host.transition(() => {
      const definitionId = host.editingSymbolId ?? undefined;
      const returning = definitionReturn === host.screenId;
      host.editingSymbolId = null;
      definitionReturn = null;
      if (returning) restoreEditView(definitionId);
      else host.selectedIds = [];
    });
  }

  function normalizeTargets() {
    if (
      host.editingSymbolId &&
      !host.project.symbols.some((s) => s.id === host.editingSymbolId)
    )
      host.editingSymbolId = null;
  }
  function withDefinition(id: string, action: () => void) {
    const generation = host.workspaceGeneration;
    const run = () => {
      if (
        generation !== host.workspaceGeneration ||
        !host.project.symbols.some((s) => s.id === id)
      )
        return;
      if (host.allow(run)) action();
    };
    run();
  }
  // F-1: 編集 → 表示プレビュー → 編集、画面 → Symbol 定義 → 画面 の往復で戻す画面ごとの状態。
  // 選択と表示位置は Project の変更ではないので Undo 履歴に入れない。
  let returnViews: { generation: number; views: ReturnViews } = {
    generation: -1,
    views: {},
  };
  let definitionReturn: string | null = null;
  function rememberEditView() {
    // W5: 隠れたキャンバスの中心で上書きしない。
    if (!host.canvasActive || host.activeDefinition) return;
    const zoom = host.canvasZoom;
    returnViews = {
      generation: host.workspaceGeneration,
      views: rememberReturnView(
        returnViews.generation === host.workspaceGeneration
          ? returnViews.views
          : {},
        host.screen.id,
        {
          selectedIds: host.selectedIds,
          zoom,
          center:
            zoom === null
              ? null
              : (host.canvasWorkspace?.visibleCenter() ?? null),
        },
      ),
    };
  }
  function restoreEditView(definitionId?: string) {
    const saved =
      returnViews.generation === host.workspaceGeneration
        ? returnViews.views[host.screen.id]
        : undefined;
    if (!saved || host.mode !== "edit" || host.activeDefinition) {
      host.selectedIds = [];
      return;
    }
    host.selectedIds = restoredSelection(
      host.screen,
      saved.selectedIds,
      definitionId,
    );
    const { zoom, center } = saved;
    if (zoom === null || !center) return;
    const generation = host.workspaceGeneration,
      ownerId = host.screen.id;
    // 図面の再描画と CanvasWorkspace のスクロール復元が落ち着いてから表示中心を戻す。
    void tick().then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (
            generation !== host.workspaceGeneration ||
            host.mode !== "edit" ||
            host.activeDefinition ||
            host.screen.id !== ownerId
          )
            return;
          if (host.canvasZoom !== zoom) host.canvasWorkspace?.zoom(zoom);
          host.canvasWorkspace?.centerOn(center);
        }),
      ),
    );
  }
  function openDefinition(id: string) {
    withDefinition(id, () => {
      host.showSidebar();
      // F-1: 左タブは切り替えない。画面から入るときは戻る先の選択と表示位置を控える。
      if (!host.activeDefinition) {
        rememberEditView();
        definitionReturn = host.mode === "edit" ? host.screen.id : null;
      }
      // W8・W10: 定義の編集へは画面タブを選んでから入る（控えた表示位置は上書きしない）。
      showCanvas();
      host.editingSymbolId = id;
      host.libraryId = id;
      host.selectedIds = [];
    });
  }
  function deleteDefinition(id: string) {
    withDefinition(id, () => {
      const definition = host.project.symbols.find((s) => s.id === id)!;
      if (symbolUsage(host.project, id) === 0)
        deleteConfirm = {
          kind: "symbol",
          id,
          name: definition.name,
          count: definition.objects.length,
        };
    });
  }
  function confirmDelete() {
    const target = deleteConfirm;
    deleteConfirm = null;
    if (!target) return;
    if (target.kind === "screen") {
      host.edit({ type: "remove-screen", screenId: target.id });
      return;
    }
    if (host.edit({ type: "remove-symbol", symbolId: target.id }))
      void tick().then(() => {
        const next =
          document.querySelector<HTMLButtonElement>(
            'nav[aria-label="共有 Symbol 一覧"] button[aria-pressed="true"]',
          ) ??
          document.querySelector<HTMLButtonElement>("[data-create-symbol]");
        next?.focus({ preventScroll: true });
      });
  }
  function openSymbolUsage(
    usage: SymbolUsage & { equipmentId?: string },
    sourceMode: "edit" | "preview" = "edit",
  ) {
    const generation = host.workspaceGeneration;
    const matchesUsage = () => {
      const target = host.project.screens
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
      if (generation !== host.workspaceGeneration || host.mode !== sourceMode)
        return;
      if (!host.allow(run)) return;
      if (!matchesUsage()) {
        host.report("info", "使用先が変更されたため移動を中止しました。");
        return;
      }
      showCanvas();
      host.mode = "edit";
      host.editingSymbolId = null;
      host.screenId = usage.screenId;
      const targetIds = expandGroupSelection(host.screen, [usage.objectId]);
      host.selectedIds = targetIds;
      host.libraryId = usage.symbolId;
      void tick().then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const selectedIds = host.selectedIds;
            if (
              generation !== host.workspaceGeneration ||
              host.mode !== "edit" ||
              !matchesUsage() ||
              host.screenId !== usage.screenId ||
              host.editingSymbolId ||
              selectedIds.length !== targetIds.length ||
              targetIds.some((id) => !selectedIds.includes(id))
            )
              return;
            host.scrollEditorTop();
            host.revealLayerObject(usage.objectId);
            host.canvasWorkspace?.revealObject(usage.objectId);
          }),
        ),
      );
    };
    run();
  }
  function openPreviewEquipmentUsage(usage: EquipmentUsage) {
    if (host.menuBlocked || host.mode !== "preview") return;
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
          (host.editingSymbolId || host.screenId !== command.screenId)
        )
          return;
        // W10: 作業画面の表示中は画面タブを選び、キャンバスの表示位置が戻ってから
        // 表示中心へ配置する（隠れたキャンバスの中心は使わない）。
        if (command.type === "place-symbol" && host.workScreenShown) {
          afterCanvasReturn(() => {
            if (!host.editingSymbolId && host.screenId === command.screenId)
              host.edit(command);
          });
          return;
        }
        host.edit(command);
      });
    } else host.edit(command);
  }
  return {
    /** 画面・Symbol 定義の削除確認（Banto の Modal）。 */
    get deleteConfirm() {
      return deleteConfirm;
    },
    /** 画面の削除確認を出す（Symbol 定義は `deleteDefinition`）。 */
    askDelete(target: DeleteConfirm) {
      deleteConfirm = target;
    },
    cancelDelete() {
      deleteConfirm = null;
    },
    /** 編集 ↔ 表示プレビューの切替で、定義の編集から戻る先を忘れる。 */
    clearDefinitionReturn() {
      definitionReturn = null;
    },
    travel,
    showSelection,
    workTabChanging,
    showCanvas,
    returnToCanvas,
    afterCanvasReturn,
    returnFromDefinition,
    normalizeTargets,
    withDefinition,
    rememberEditView,
    restoreEditView,
    openDefinition,
    deleteDefinition,
    confirmDelete,
    openSymbolUsage,
    openPreviewEquipmentUsage,
    symbolLibraryCommand,
  };
}

export type EditViewController = ReturnType<typeof createEditViewController>;
