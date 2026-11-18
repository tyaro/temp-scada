import type { FloatingInspector } from "./floating-inspector.svelte";
import type { ContextAction } from "../ContextActions.svelte";
import type { ToolbarAction, ToolbarGroup } from "../EditToolbar.svelte";
import type { DesignerMenu } from "../DesignerMenubar.svelte";
import type { FolderOperation } from "../FolderDialog.svelte";
import type { EditCommand, AddKind } from "../../editor";
import type { ScreenObject, Point } from "../../project";
import { canFlip } from "../../flip";
import { BUILTIN_PARTS } from "../../builtin-symbols";
import type { WorkTabKind } from "./work-tabs.svelte";
import type { CommandSpec } from "@banto/ui";
const FLIP_LABELS = ["左右反転", "上下反転"];

/** キー・メニュー・toolbar が共有する操作の id（Banto #435 の `CommandSpec.id`）。 */
export type DesignerCommandId =
  | "project.new"
  | "project.open"
  | "project.save"
  | "project.saveAs"
  | "history.undo"
  | "history.redo"
  | "selection.all"
  | "selection.duplicate"
  | "selection.remove"
  | "selection.group"
  | "selection.ungroup"
  | "selection.show"
  | "help.open";

interface PanelVisibility {
  sidebar: boolean;
  inspector: boolean;
  references: boolean;
}
export interface DesignerActionsHost {
  groups?: {
    readonly groupId?: string;
    readonly containsGroups: boolean;
    readonly definition: boolean;
    readonly unitCount: number;
    readonly selectableIds: string[];
    rename(): void;
    create(): void;
    ungroup(): void;
  };
  editing: {
    readonly editBlocked: boolean;
    /**
     * 作業タブの表示中（`canvasActive` でない）。キャンバス・レイヤー・配置を
     * 対象にする操作を群ごと無効にする（作業タブ設計 W4）。Undo／Redo は除く。
     */
    readonly canvasBlocked: boolean;
    /** 警報の小札は警報の定義があるときだけ置ける。 */
    readonly hasAlarmDefinitions: boolean;
    readonly mutationBlocked: boolean;
    readonly undoCount: number;
    readonly redoCount: number;
    readonly objects: readonly ScreenObject[];
    readonly screenId: string;
    selectedIds: string[];
    travel(direction: "undo" | "redo"): void;
    transition(run: () => void): void;
    edit(command: EditCommand): boolean;
    duplicateSelection(): void;
    openArrayCopy(): void;
    removeSelection(): void;
    rotateSelection(delta: number): void;
    flipSelection(axis: "x" | "y"): void;
  };
  selection: {
    readonly selected: ScreenObject | undefined;
    readonly contextKind: "selection" | "blank";
    readonly contextPoint: Point | null;
    readonly origin: HTMLElement | null;
    readonly definition: boolean;
    readonly symbolCount: number;
    renamePlacement(id: string): void;
    toggleObjectVisibility(id: string): void;
    toggleObjectLock(id: string): void;
    openDefinition(id: string): void;
    openEquipment(id: string, destination: "read" | "settings"): void;
  };
  folders: {
    readonly count: number;
    readonly contextId: string;
    readonly origin: HTMLElement | null;
    readonly orderFiltered: boolean;
    canReorder(direction: "up" | "down"): boolean;
    reorder(direction: "up" | "down"): void;
    open(kind: FolderOperation, id?: string, origin?: HTMLElement): void;
  };
  clipboard: {
    readonly busy: boolean;
    action(kind: "cut" | "copy" | "paste"): void;
  };
  files: {
    readonly imageBusy: boolean;
    newProject(): void;
    openProjectFile(): void;
    save(): void;
    /** The desktop's "save as" (the browser has none). */
    readonly saveAs?: () => void;
    openPlacement(): void;
    /** 作業タブ「プロジェクト設定」を開き、プロジェクト名へフォーカスする（W12）。 */
    renameProject(): void;
    openProcessSample(): void;
    openSymbolSample(): void;
    openPaintSample(): void;
    openPolygonSample(): void;
    openScreenViewDialog(): void;
    openTrendDefinitions(): void;
    openRecordingPlan(): void;
    /** 警報の端末設定の窓（terminal settings design §7）。 */
    openAlarmSettings(): void;
    /** 端末設定を開けない理由（host の無いブラウザ版）。開けるときは null。 */
    readonly alarmSettingsReason: string | null;
    add(kind: AddKind): void;
  };
  view: {
    inspectorLayout?: FloatingInspector;
    sidebarLayout?: FloatingInspector;
    readonly mode: "edit" | "preview";
    readonly menuBlocked: boolean;
    readonly selectionViewReason: string | null;
    readonly showRulers: boolean;
    readonly showSidebar: boolean;
    readonly showReferences: boolean;
    readonly showInspector: boolean;
    readonly showMinimap: boolean;
    readonly showMenubar: boolean;
    readonly previousPanels: boolean;
    /** 作業タブを選んでいて作業画面を表示している（作業タブ設計 W9）。 */
    readonly workScreenShown: boolean;
    /** 作業タブを開けない理由（W8 の Symbol 定義の編集中など）。開けるときは null。 */
    readonly workTabReason: string | null;
    openWorkTab(kind: WorkTabKind): void;
    showGrid: boolean;
    snapEnabled: boolean;
    helpOpen: boolean;
    panelVisibility(): PanelVisibility;
    setAuxPanelVisibility(
      patch: Partial<PanelVisibility>,
      focus?: keyof PanelVisibility,
    ): void;
    setInspectorVisibility(value: boolean, focus: boolean): void;
    toggleAuxPanels(): void;
    zoomAll(): void;
    showSelection(): void;
    toggleRulers(): void;
    toggleMinimap(): void;
    resetFavorites(): void;
    resetPanelWidths(): void;
    restorePanelLayout(): void;
    resetReferenceHeight(): void;
    toggleMenubar(): void;
    openHistory(): void;
    openRecordingManagement(): void;
    openRecordingOperations(): void;
    changeMode(value: "edit" | "preview"): void;
    chooseTheme(value: "light" | "dark" | "system"): void;
  };
}

/** Pure action builders. Deferred run callbacks read current host values, never frozen IDs. */
export function createDesignerActions(host: DesignerActionsHost) {
  /** W4: 作業タブの表示中はキャンバス向けの群をまとめて無効にする。 */
  function canvasGate<T extends { disabled?: boolean }>(items: T[]): T[] {
    return host.editing.canvasBlocked
      ? items.map((item) => ({ ...item, disabled: true }))
      : items;
  }
  function folderContext(): ContextAction[] {
    return canvasGate(folderItems());
  }
  function folderItems(): ContextAction[] {
    return [
      {
        label: "子フォルダーを作成",
        disabled: host.editing.editBlocked || host.folders.count >= 256,
        run: () =>
          host.folders.open(
            "create",
            host.folders.contextId,
            host.folders.origin ?? undefined,
          ),
      },
      {
        label: "フォルダー名を変更",
        disabled: host.editing.editBlocked,
        run: () =>
          host.folders.open(
            "rename",
            host.folders.contextId,
            host.folders.origin ?? undefined,
          ),
      },
      {
        label: "親フォルダーを変更",
        disabled: host.editing.editBlocked,
        run: () =>
          host.folders.open(
            "move",
            host.folders.contextId,
            host.folders.origin ?? undefined,
          ),
      },
      ...(["up", "down"] as const).map((direction) => ({
        label: `${direction === "up" ? "同じ階層で一つ上へ" : "同じ階層で一つ下へ"}${host.folders.orderFiltered ? "（検索中は不可）" : ""}`,
        disabled: !host.folders.canReorder(direction),
        run: () => host.folders.reorder(direction),
      })),
      {
        label: "空のフォルダーを削除",
        disabled: host.editing.editBlocked,
        run: () =>
          host.folders.open(
            "remove",
            host.folders.contextId,
            host.folders.origin ?? undefined,
          ),
      },
    ];
  }
  /**
   * Unlocked mirrorable placements only. Any selected group member blocks the
   * flip (a group alone or mixed with others), since members would mirror
   * around their own pivots and change the group's artwork.
   */
  function flipBlocked(): boolean {
    const ids = host.editing.selectedIds;
    if (
      host.editing.mutationBlocked ||
      !ids.length ||
      host.groups?.groupId ||
      host.groups?.containsGroups
    )
      return true;
    const selected = host.editing.objects.filter((object) =>
      ids.includes(object.id),
    );
    return (
      selected.length !== ids.length ||
      selected.some((object) => object.locked || !canFlip(object))
    );
  }
  /** 選べる配置（ロック・非表示を除く）が一つでもある。 */
  function hasSelectable(): boolean {
    return host.editing.objects.some(
      (object) => !object.locked && object.visible !== false,
    );
  }
  /**
   * キー・メニュー・toolbar・コンテキストメニューが共有する操作（Banto #435 の
   * `CommandSpec`）。名前・実行・使える条件はここだけで決め、メニュー・toolbar は
   * `disabled = !enabled()`、キーは App の dispatcher がキー専用の保護（入力元・層・
   * キャンバス上の対象）を足して使う。`enabled` は表示時と実行の直前に呼ばれる。
   * `shortcut` はメニューに出すキー（Banto #671）で、App の dispatcher も既定で
   * これを登録する。やり直しの Mod+Shift+Z のような別のキーは App 側で足す。
   */
  const commands: Record<DesignerCommandId, CommandSpec> = {
    "project.new": {
      id: "project.new",
      shortcut: "Mod+N",
      title: "新しいProject",
      enabled: () => !host.view.menuBlocked,
      run: () => host.files.newProject(),
    },
    "project.open": {
      id: "project.open",
      shortcut: "Mod+O",
      title: "Project を開く",
      enabled: () => !host.view.menuBlocked,
      run: () => host.files.openProjectFile(),
    },
    "project.save": {
      id: "project.save",
      shortcut: "Mod+S",
      title: "Project を保存",
      enabled: () => !host.view.menuBlocked,
      run: () => host.files.save(),
    },
    "project.saveAs": {
      id: "project.saveAs",
      shortcut: "Mod+Shift+S",
      title: "名前を付けて保存",
      visible: () => !!host.files.saveAs,
      enabled: () => !host.view.menuBlocked,
      run: () => host.files.saveAs?.(),
    },
    "history.undo": {
      id: "history.undo",
      shortcut: "Mod+Z",
      title: "元に戻す",
      enabled: () => !host.editing.editBlocked && !!host.editing.undoCount,
      run: () => host.editing.travel("undo"),
    },
    "history.redo": {
      id: "history.redo",
      shortcut: "Mod+Y",
      title: "やり直す",
      enabled: () => !host.editing.editBlocked && !!host.editing.redoCount,
      run: () => host.editing.travel("redo"),
    },
    "selection.all": {
      id: "selection.all",
      shortcut: "Mod+A",
      title: "すべて選択",
      enabled: () =>
        !host.editing.editBlocked &&
        !host.editing.canvasBlocked &&
        hasSelectable(),
      run: () =>
        host.editing.transition(
          () =>
            (host.editing.selectedIds =
              host.groups?.selectableIds ??
              host.editing.objects
                .filter((o) => !o.locked && o.visible !== false)
                .map((o) => o.id)),
        ),
    },
    "selection.duplicate": {
      id: "selection.duplicate",
      shortcut: "Mod+D",
      title: "選択図形を複製",
      enabled: () =>
        !host.editing.mutationBlocked &&
        !host.editing.canvasBlocked &&
        !!host.editing.selectedIds.length,
      run: () => host.editing.duplicateSelection(),
    },
    "selection.remove": {
      id: "selection.remove",
      shortcut: "Delete",
      title: "選択図形を削除",
      enabled: () =>
        !host.editing.mutationBlocked &&
        !host.editing.canvasBlocked &&
        !!host.editing.selectedIds.length,
      run: () => host.editing.removeSelection(),
    },
    "selection.group": {
      id: "selection.group",
      shortcut: "Mod+G",
      title: "グループ化",
      visible: () => !!host.groups,
      enabled: () =>
        !!host.groups &&
        !host.editing.mutationBlocked &&
        !host.editing.canvasBlocked &&
        !host.groups.definition &&
        !host.groups.containsGroups &&
        host.editing.selectedIds.length >= 2,
      run: () => host.groups?.create(),
    },
    "selection.ungroup": {
      id: "selection.ungroup",
      shortcut: "Mod+Shift+G",
      title: "グループ解除",
      visible: () => !!host.groups,
      enabled: () =>
        !!host.groups &&
        !host.editing.mutationBlocked &&
        !host.editing.canvasBlocked &&
        !!host.groups.groupId,
      run: () => host.groups?.ungroup(),
    },
    "selection.show": {
      id: "selection.show",
      shortcut: "F",
      title: "選択範囲を表示",
      enabled: () => !host.view.selectionViewReason,
      run: () => host.view.showSelection(),
    },
    "help.open": {
      id: "help.open",
      shortcut: "F1",
      title: "操作ガイド・アプリ情報",
      run: () => {
        host.view.helpOpen = true;
      },
    },
  };
  function command(id: DesignerCommandId): CommandSpec {
    return commands[id];
  }
  /** 共有の操作から、メニュー・コンテキストメニューの項目を作る。 */
  function commandItem(id: DesignerCommandId): ContextAction {
    const spec = commands[id];
    return {
      label: spec.title,
      shortcut: spec.shortcut,
      disabled: spec.enabled ? !spec.enabled() : false,
      run: () => void spec.run(),
    };
  }
  /** 共有の操作から、toolbar の項目を作る。 */
  function commandTool(id: DesignerCommandId, icon: string): ToolbarAction {
    return { ...commandItem(id), icon };
  }
  function editGroups(): ToolbarGroup[] {
    return editGroupItems().map((group) =>
      group.id === "history"
        ? group
        : { ...group, items: canvasGate(group.items) },
    );
  }
  function editGroupItems(): ToolbarGroup[] {
    return [
      {
        id: "history",
        label: "編集履歴",
        items: [
          commandTool("history.undo", "M8 5L3 10L8 15M3 10H14A6 6 0 0 1 14 22"),
          commandTool(
            "history.redo",
            "M16 5L21 10L16 15M21 10H10A6 6 0 0 0 10 22",
          ),
        ],
      },
      {
        id: "selection",
        label: "選択と編集",
        items: [
          commandTool(
            "selection.all",
            "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M7 7H17V17H7Z",
          ),
          {
            label: "選択解除",
            icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M8 8L16 16M16 8L8 16",
            disabled:
              host.editing.mutationBlocked || !host.editing.selectedIds.length,
            run: () =>
              host.editing.transition(() => (host.editing.selectedIds = [])),
          },
          commandTool("selection.duplicate", "M9 9H21V21H9ZM15 5V3H3V15H5"),
          {
            label: "配列複製",
            icon: "M3 3H9V9H3ZM15 3H21V9H15ZM3 15H9V21H3ZM15 15H21V21H15Z",
            disabled:
              host.editing.mutationBlocked || !host.editing.selectedIds.length,
            run: host.editing.openArrayCopy,
          },
          commandTool(
            "selection.remove",
            "M3 6H21M9 6V3H15V6M6 6L7 21H17L18 6M10 10V17M14 10V17",
          ),
        ],
      },
      ...(host.groups
        ? [
            {
              id: "geometric-groups",
              label: "幾何グループ",
              items: [
                commandTool(
                  "selection.group",
                  "M3 3H10V10H3ZM14 14H21V21H14ZM1 1H23V23H1Z",
                ),
                commandTool(
                  "selection.ungroup",
                  "M3 3H10V10H3ZM14 14H21V21H14ZM1 8V1H8M16 1H23V8M23 16V23H16M8 23H1V16",
                ),
              ],
            },
          ]
        : []),
      {
        id: "rotation",
        label: "回転",
        items: [
          {
            label: "左へ90°回転",
            icon: "M3 10A9 9 0 1 1 5 18M3 3V10H10",
            disabled:
              host.editing.mutationBlocked ||
              (host.editing.selectedIds.length !== 1 && !host.groups?.groupId),
            run: () => host.editing.rotateSelection(-90),
          },
          {
            label: "右へ90°回転",
            icon: "M21 10A9 9 0 1 0 19 18M21 3V10H14",
            disabled:
              host.editing.mutationBlocked ||
              (host.editing.selectedIds.length !== 1 && !host.groups?.groupId),
            run: () => host.editing.rotateSelection(90),
          },
          {
            label: "左右反転",
            icon: "M12 2V22M9 6L3 18H9ZM15 6L21 18H15Z",
            disabled: flipBlocked(),
            menuOnly: true,
            run: () => host.editing.flipSelection("x"),
          },
          {
            label: "上下反転",
            icon: "M2 12H22M6 9L18 3V9ZM6 15L18 21V15Z",
            disabled: flipBlocked(),
            menuOnly: true,
            run: () => host.editing.flipSelection("y"),
          },
        ],
      },
      {
        id: "order",
        label: "重なり順",
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
          disabled:
            host.editing.mutationBlocked ||
            (host.editing.selectedIds.length !== 1 && !host.groups?.groupId),
          run: () => {
            if (host.groups?.groupId)
              host.editing.edit({
                type: "reorder-group",
                screenId: host.editing.screenId,
                groupId: host.groups.groupId,
                direction: item.direction,
              });
            else if (host.editing.selectedIds.length === 1)
              host.editing.edit({
                type: "reorder",
                screenId: host.editing.screenId,
                objectId: host.editing.selectedIds[0],
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
            disabled:
              host.editing.mutationBlocked ||
              (host.groups?.unitCount ?? host.editing.selectedIds.length) < 2,
            run: () =>
              host.editing.edit({
                type: "align",
                screenId: host.editing.screenId,
                objectIds: [...host.editing.selectedIds],
                alignment: item.alignment,
              }),
          })),
          ...[
            {
              type: "distribute" as const,
              axis: "x" as const,
              label: "中心を水平方向に等間隔",
              icon: "M3 3V21M21 3V21M4 9H6V15H4ZM11 6H13V18H11ZM18 9H20V15H18Z",
            },
            {
              type: "distribute" as const,
              axis: "y" as const,
              label: "中心を垂直方向に等間隔",
              icon: "M3 3H21M3 21H21M9 4H15V6H9ZM6 11H18V13H6ZM9 18H15V20H9Z",
            },
            {
              type: "distribute-gaps" as const,
              axis: "x" as const,
              label: "隙間を水平方向に均等化",
              icon: "M2 5H5V19H2ZM10 5H14V19H10ZM19 5H22V19H19ZM6 11H9M15 11H18M6 14H9M15 14H18",
            },
            {
              type: "distribute-gaps" as const,
              axis: "y" as const,
              label: "隙間を垂直方向に均等化",
              icon: "M5 2H19V5H5ZM5 10H19V14H5ZM5 19H19V22H5ZM11 6V9M11 15V18M14 6V9M14 15V18",
            },
          ].map((item) => ({
            ...item,
            disabled:
              host.editing.mutationBlocked ||
              (host.groups?.unitCount ?? host.editing.selectedIds.length) < 3,
            run: () =>
              host.editing.edit({
                type: item.type,
                screenId: host.editing.screenId,
                objectIds: [...host.editing.selectedIds],
                axis: item.axis,
              }),
          })),
        ],
      },
    ];
  }
  function clipboardItems(): ContextAction[] {
    return canvasGate([
      {
        label: "切り取り",
        // キーはブラウザの cut/copy/paste イベント（App の nativeClipboard）が受ける。
        shortcut: "Mod+X",
        disabled:
          host.editing.mutationBlocked ||
          host.clipboard.busy ||
          !host.editing.selectedIds.length,
        run: () => host.clipboard.action("cut"),
      },
      {
        label: "コピー",
        shortcut: "Mod+C",
        disabled:
          host.editing.editBlocked ||
          host.clipboard.busy ||
          !host.editing.selectedIds.length,
        run: () => host.clipboard.action("copy"),
      },
      {
        label: "貼り付け",
        shortcut: "Mod+V",
        disabled: host.editing.editBlocked || host.clipboard.busy,
        run: () => host.clipboard.action("paste"),
      },
    ]);
  }
  function selectionContext(
    editToolbarGroups: ToolbarGroup[],
    clipboardItems: ContextAction[],
  ): ContextAction[] {
    return canvasGate(selectionItems(editToolbarGroups, clipboardItems));
  }
  function selectionItems(
    editToolbarGroups: ToolbarGroup[],
    clipboardItems: ContextAction[],
  ): ContextAction[] {
    function editGroupItems(id: string) {
      return editToolbarGroups.find((group) => group.id === id)!.items;
    }

    const properties: ContextAction = {
      label: "プロパティを表示",
      run: () => host.view.setInspectorVisibility(true, true),
    };
    if (host.selection.contextKind === "blank")
      return [
        ...(host.selection.contextPoint
          ? (
              [
                { kind: "rectangle", label: "Rectangle を挿入" },
                { kind: "ellipse", label: "Ellipse を挿入" },
                { kind: "polygon", label: "多角形を挿入" },
                { kind: "trapezoid", label: "台形を挿入" },
                { kind: "diamond", label: "ひし形を挿入" },
                { kind: "arrowTag", label: "行き先の札を挿入" },
                { kind: "text", label: "Text を挿入" },
                { kind: "line", label: "線を挿入" },
                { kind: "pipe", label: "配管を挿入" },
                { kind: "level", label: "液位を挿入" },
                { kind: "table", label: "表を挿入" },
                { kind: "clock", label: "時計を挿入" },
                { kind: "navButton", label: "画面切替ボタンを挿入" },
                { kind: "alarmBadge", label: "警報の小札を挿入" },
                { kind: "alarmBanner", label: "最新の警報の帯を挿入" },
              ] as const
            ).map((part) => ({
              label: part.label,
              disabled:
                host.editing.editBlocked ||
                ((part.kind === "navButton" ||
                  part.kind === "alarmBadge" ||
                  part.kind === "alarmBanner") &&
                  !!host.selection.definition) ||
                (part.kind === "alarmBadge" &&
                  !host.editing.hasAlarmDefinitions),
              run: () =>
                host.editing.edit({
                  type: "add",
                  screenId: host.editing.screenId,
                  kind: part.kind,
                  center: host.selection.contextPoint!,
                }),
            }))
          : []),
        clipboardItems[2],
        editGroupItems("selection")[0],
        properties,
        { label: "全体表示", run: () => host.view.zoomAll() },
        {
          label: "補助パネルをすべて隠す",
          run: () => {
            if (
              host.view.showSidebar ||
              host.view.showInspector ||
              host.view.showReferences
            )
              host.view.toggleAuxPanels();
          },
        },
      ];
    return [
      properties,
      ...(!host.selection.definition &&
      host.selection.selected?.shape.type === "symbol"
        ? (
            [
              { label: "関連機器の台帳設定を開く", destination: "settings" },
              { label: "関連機器の読取詳細を開く", destination: "read" },
            ] as const
          ).map((item) => ({
            label: item.label,
            disabled:
              host.editing.editBlocked ||
              !(
                host.selection.selected?.shape.type === "symbol" &&
                host.selection.selected.shape.equipmentId
              ),
            run: () => {
              if (
                !host.selection.definition &&
                host.selection.selected?.shape.type === "symbol"
              )
                host.selection.openEquipment(
                  host.selection.selected.id,
                  item.destination,
                );
            },
          }))
        : []),
      {
        label: "配置の所属を変更",
        disabled:
          host.editing.mutationBlocked || !host.editing.selectedIds.length,
        run: () =>
          host.folders.open(
            "assign",
            undefined,
            host.selection.origin ?? undefined,
          ),
      },
      ...(host.groups?.groupId
        ? [
            {
              label: "グループ名を変更",
              disabled: host.editing.mutationBlocked,
              run: host.groups.rename,
            },
          ]
        : []),
      ...(host.selection.selected
        ? [
            {
              label: "配置名を変更",
              disabled: host.editing.mutationBlocked,
              run: () =>
                host.selection.selected &&
                host.selection.renamePlacement(host.selection.selected.id),
            },
          ]
        : []),
      ...(host.selection.selected
        ? [
            {
              label:
                host.selection.selected.visible === false
                  ? "配置を再表示"
                  : "配置を非表示（表示プレビューにも反映）",
              disabled: host.editing.editBlocked,
              run: () =>
                host.selection.selected &&
                host.selection.toggleObjectVisibility(
                  host.selection.selected.id,
                ),
            },
          ]
        : []),
      ...(host.selection.selected
        ? [
            {
              label: host.selection.selected.locked
                ? "ロックを解除"
                : "配置をロック",
              disabled: host.editing.editBlocked,
              run: () =>
                host.selection.selected &&
                host.selection.toggleObjectLock(host.selection.selected.id),
            },
          ]
        : []),
      ...clipboardItems,
      ...editGroupItems("selection").slice(2),
      ...(host.groups ? editGroupItems("geometric-groups") : []),
      ...(host.groups?.groupId
        ? [...editGroupItems("rotation"), ...editGroupItems("order")]
        : []),
      ...(host.editing.selectedIds.length > 1
        ? [
            ...editGroupItems("rotation").filter((item) =>
              FLIP_LABELS.includes(item.label),
            ),
            ...editGroupItems("align"),
          ]
        : [...editGroupItems("rotation"), ...editGroupItems("order")]),
      ...(host.selection.selected?.shape.type === "symbol"
        ? [
            {
              label: "参照する Symbol 定義を編集",
              run: () => {
                if (host.selection.selected?.shape.type === "symbol")
                  host.selection.openDefinition(
                    host.selection.selected.shape.symbolId,
                  );
              },
            },
            {
              label: "定義を複製してこの配置に適用",
              disabled:
                host.editing.mutationBlocked ||
                host.selection.symbolCount >= 100,
              run: () => {
                if (host.selection.selected)
                  host.editing.edit({
                    type: "make-symbol-unique",
                    screenId: host.editing.screenId,
                    objectId: host.selection.selected.id,
                  });
              },
            },
          ]
        : []),
    ];
  }
  function menus(
    editToolbarGroups: ToolbarGroup[],
    clipboardItems: ContextAction[],
  ): DesignerMenu[] {
    return [
      {
        label: "ファイル",
        items: [
          commandItem("project.new"),
          commandItem("project.open"),
          commandItem("project.save"),
          ...(host.files.saveAs ? [commandItem("project.saveAs")] : []),
          {
            label: "画像を配置",
            disabled:
              host.editing.editBlocked ||
              host.editing.canvasBlocked ||
              host.files.imageBusy,
            run: host.files.openPlacement,
          },
          {
            label: host.view.workTabReason
              ? `プロジェクト名を変更（${host.view.workTabReason}）`
              : "プロジェクト名を変更",
            disabled: host.editing.editBlocked || !!host.view.workTabReason,
            run: host.files.renameProject,
          },
          {
            label: host.files.alarmSettingsReason
              ? "警報の端末設定…（デスクトップ版のみ）"
              : "警報の端末設定…",
            disabled: host.view.menuBlocked || !!host.files.alarmSettingsReason,
            run: host.files.openAlarmSettings,
          },
          {
            label: "工程図サンプルを開く",
            disabled: host.view.menuBlocked,
            run: host.files.openProcessSample,
          },
          {
            label: "Symbol配色サンプルを開く",
            disabled: host.view.menuBlocked,
            run: host.files.openSymbolSample,
          },
          {
            label: "塗りと枠線サンプルを開く",
            disabled: host.view.menuBlocked,
            run: host.files.openPaintSample,
          },
          {
            label: "多角形の部品サンプルを開く",
            disabled: host.view.menuBlocked,
            run: host.files.openPolygonSample,
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
          commandItem("selection.show"),
          {
            label: host.view.workTabReason
              ? `プロジェクト設定（${host.view.workTabReason}）`
              : "プロジェクト設定",
            disabled: host.view.menuBlocked || !!host.view.workTabReason,
            run: () => host.view.openWorkTab("project-settings"),
          },
          {
            label: host.view.workTabReason
              ? `機器（${host.view.workTabReason}）`
              : "機器",
            disabled: host.view.menuBlocked || !!host.view.workTabReason,
            run: () => host.view.openWorkTab("equipment"),
          },
          {
            label: host.view.workTabReason
              ? `警報の定義（${host.view.workTabReason}）`
              : "警報の定義",
            disabled: host.view.menuBlocked || !!host.view.workTabReason,
            run: () => host.view.openWorkTab("alarm-definitions"),
          },
          {
            label: host.view.showRulers ? "ルーラーを隠す" : "ルーラーを表示",
            disabled: host.view.mode !== "edit" || host.view.workScreenShown,
            run: host.view.toggleRulers,
          },
          {
            label: host.view.showSidebar ? "左パネルを隠す" : "左パネルを表示",
            disabled: host.view.mode !== "edit",
            run: () =>
              host.view.setAuxPanelVisibility(
                { sidebar: !host.view.showSidebar },
                "sidebar",
              ),
          },
          {
            label: host.view.showReferences
              ? "タグ参照一覧を隠す"
              : "タグ参照一覧を表示",
            disabled: host.view.mode !== "edit" || host.view.workScreenShown,
            run: () =>
              host.view.setAuxPanelVisibility(
                { references: !host.view.showReferences },
                "references",
              ),
          },
          {
            // W9: 作業画面の表示中は左ペインだけに作用する。
            label: host.view.workScreenShown
              ? host.view.showSidebar
                ? "補助パネルをすべて隠す"
                : "補助パネルをすべて表示"
              : host.view.previousPanels
                ? "補助パネルを元の表示に戻す"
                : Object.values(host.view.panelVisibility()).some(Boolean)
                  ? "補助パネルをすべて隠す"
                  : "補助パネルをすべて表示",
            disabled: host.view.mode !== "edit",
            run: host.view.toggleAuxPanels,
          },
          {
            label: host.view.showInspector
              ? "プロパティを隠す"
              : "プロパティを表示",
            disabled: host.view.mode !== "edit" || host.view.workScreenShown,
            run: () =>
              host.view.setInspectorVisibility(!host.view.showInspector, true),
          },
          ...(host.view.sidebarLayout
            ? [
                {
                  label: "作業パネルを前面に表示",
                  disabled: host.editing.editBlocked,
                  run: () => {
                    host.view.setAuxPanelVisibility(
                      { sidebar: true },
                      "sidebar",
                    );
                    host.view.sidebarLayout?.front();
                  },
                },
                {
                  label: host.view.sidebarLayout.preferredFloating
                    ? "作業パネルを左へ戻す"
                    : "作業パネルを浮動にする",
                  disabled:
                    host.editing.editBlocked ||
                    (!host.view.sidebarLayout.preferredFloating &&
                      !host.view.sidebarLayout.supported),
                  run: () => host.view.sidebarLayout?.toggle(),
                },
                {
                  label: "作業パネル配置を保存",
                  disabled:
                    host.editing.editBlocked || host.view.sidebarLayout.saving,
                  run: () => {
                    void host.view.sidebarLayout?.save();
                  },
                },
                {
                  label: "保存した作業パネル配置に戻す",
                  disabled:
                    host.editing.editBlocked ||
                    !host.view.sidebarLayout.hasSaved,
                  run: () => {
                    host.view.sidebarLayout?.restore();
                    host.view.setAuxPanelVisibility(
                      { sidebar: true },
                      "sidebar",
                    );
                  },
                },
              ]
            : []),
          ...(host.view.inspectorLayout
            ? [
                {
                  label: "プロパティを前面に表示",
                  disabled:
                    host.editing.editBlocked || host.view.workScreenShown,
                  run: () => {
                    host.view.setInspectorVisibility(true, true);
                    host.view.inspectorLayout?.front();
                  },
                },
                {
                  label: host.view.inspectorLayout.preferredFloating
                    ? "プロパティを右へ戻す"
                    : "プロパティを浮動にする",
                  disabled:
                    host.editing.editBlocked ||
                    host.view.workScreenShown ||
                    (!host.view.inspectorLayout.preferredFloating &&
                      !host.view.inspectorLayout.supported),
                  run: () => host.view.inspectorLayout?.toggle(),
                },
                {
                  label: "プロパティ配置を保存",
                  disabled:
                    host.editing.editBlocked ||
                    host.view.workScreenShown ||
                    host.view.inspectorLayout.saving,
                  run: () => {
                    void host.view.inspectorLayout?.save();
                  },
                },
                {
                  label: "保存したプロパティ配置に戻す",
                  disabled:
                    host.editing.editBlocked ||
                    host.view.workScreenShown ||
                    !host.view.inspectorLayout.hasSaved,
                  run: () => {
                    host.view.inspectorLayout?.restore();
                    host.view.setInspectorVisibility(true, true);
                  },
                },
              ]
            : []),
          {
            label: host.view.showMinimap
              ? "ミニマップを隠す"
              : "ミニマップを表示",
            disabled: host.view.mode !== "edit",
            run: host.view.toggleMinimap,
          },
          {
            label: "お気に入りを標準に戻す",
            run: host.view.resetFavorites,
          },
          {
            label: "パネルの幅を標準に戻す",
            disabled: host.view.mode !== "edit",
            run: host.view.resetPanelWidths,
          },
          {
            label: "標準レイアウトに戻す",
            disabled: host.editing.editBlocked,
            run: host.view.restorePanelLayout,
          },
          {
            label: "タグ参照パネルの高さを標準に戻す",
            disabled: host.view.mode !== "edit" || host.view.workScreenShown,
            run: host.view.resetReferenceHeight,
          },
          {
            label: host.view.showMenubar
              ? "メニューバーを隠す"
              : "メニューバーを表示",
            run: host.view.toggleMenubar,
          },
          {
            label: "編集モード",
            disabled: host.view.menuBlocked,
            run: () => host.view.changeMode("edit"),
          },
          {
            label: "表示プレビュー",
            disabled: host.view.menuBlocked,
            run: () => host.view.changeMode("preview"),
          },
          {
            label: "テーマ：ライト",
            run: () => host.view.chooseTheme("light"),
          },
          { label: "テーマ：ダーク", run: () => host.view.chooseTheme("dark") },
          {
            label: "テーマ：OS に合わせる",
            run: () => host.view.chooseTheme("system"),
          },
        ],
      },
      {
        label: "挿入",
        items: canvasGate([
          {
            label: "トレンド定義・配置",
            disabled: host.editing.editBlocked || host.selection.definition,
            run: host.files.openTrendDefinitions,
          },
          {
            label: "画面を埋め込む",
            disabled: host.editing.editBlocked || !!host.selection.definition,
            run: host.files.openScreenViewDialog,
          },
          ...(
            [
              { kind: "rectangle", label: "Rectangle を追加" },
              { kind: "ellipse", label: "Ellipse を追加" },
              { kind: "polygon", label: "多角形を追加" },
              { kind: "trapezoid", label: "台形を追加" },
              { kind: "diamond", label: "ひし形を追加" },
              { kind: "arrowTag", label: "行き先の札を追加" },
              { kind: "text", label: "Text を追加" },
              { kind: "line", label: "線を追加" },
              { kind: "pipe", label: "配管を追加" },
              { kind: "level", label: "液位を追加" },
              { kind: "table", label: "表を追加" },
              { kind: "clock", label: "時計を追加" },
              { kind: "navButton", label: "画面切替ボタンを追加" },
              { kind: "alarmBadge", label: "警報の小札を追加" },
              { kind: "alarmBanner", label: "最新の警報の帯を追加" },
            ] as const
          ).map((part) => ({
            label: part.label,
            disabled:
              host.editing.editBlocked ||
              ((part.kind === "navButton" ||
                part.kind === "alarmBadge" ||
                part.kind === "alarmBanner") &&
                !!host.selection.definition) ||
              (part.kind === "alarmBadge" && !host.editing.hasAlarmDefinitions),
            run: () => host.files.add(part.kind),
          })),
          ...BUILTIN_PARTS.map(({ template, name }) => ({
            label: `${name}を追加`,
            disabled: host.editing.editBlocked || !!host.selection.definition,
            run: () => {
              host.editing.edit({
                type: "add-symbol",
                screenId: host.editing.screenId,
                template,
              });
            },
          })),
        ]),
      },
      {
        label: "ツール",
        items: [
          {
            label: host.view.showGrid ? "グリッドを隠す" : "グリッドを表示",
            disabled: host.editing.editBlocked,
            run: () => (host.view.showGrid = !host.view.showGrid),
          },
          {
            label: host.view.snapEnabled
              ? "スナップを無効にする"
              : "スナップを有効にする",
            disabled: host.editing.editBlocked,
            run: () => (host.view.snapEnabled = !host.view.snapEnabled),
          },
        ],
      },
      {
        label: "記録",
        items: [
          {
            label: "記録希望設定",
            disabled: host.view.menuBlocked || host.selection.definition,
            run: host.files.openRecordingPlan,
          },
          {
            label: "記録管理状態",
            disabled: host.view.menuBlocked,
            run: host.view.openRecordingManagement,
          },
          {
            label: "記録計画の操作",
            disabled: host.view.menuBlocked,
            run: host.view.openRecordingOperations,
          },
          {
            label: "履歴トレンド",
            disabled: host.view.menuBlocked,
            run: host.view.openHistory,
          },
        ],
      },
      {
        label: "ヘルプ",
        items: [commandItem("help.open")],
      },
    ];
  }
  return {
    command,
    folderContext,
    editGroups,
    clipboardItems,
    selectionContext,
    menus,
  };
}
