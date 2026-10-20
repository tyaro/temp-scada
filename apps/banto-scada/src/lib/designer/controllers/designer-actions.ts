import type { ContextAction } from "../ContextActions.svelte";
import type { ToolbarGroup } from "../EditToolbar.svelte";
import type { DesignerMenu } from "../DesignerMenubar.svelte";
import type { FolderOperation } from "../FolderDialog.svelte";
import type { EditCommand, AddKind } from "../../editor";
import type { ScreenObject, Point } from "../../project";

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
    removeSelection(): void;
    rotateSelection(delta: number): void;
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
  };
  folders: {
    readonly count: number;
    readonly contextId: string;
    readonly origin: HTMLElement | null;
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
    openPlacement(): void;
    focusProjectName(): void;
    openProcessSample(): void;
    openSymbolSample(): void;
    openPaintSample(): void;
    openScreenViewDialog(): void;
    add(kind: AddKind): void;
  };
  view: {
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
    changeMode(value: "edit" | "preview"): void;
    chooseTheme(value: "light" | "dark" | "system"): void;
  };
}

/** Pure action builders. Deferred run callbacks read current host values, never frozen IDs. */
export function createDesignerActions(host: DesignerActionsHost) {
  function folderContext(): ContextAction[] {
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
  function editGroups(): ToolbarGroup[] {
    return [
      {
        id: "history",
        label: "編集履歴",
        items: [
          {
            label: "元に戻す",
            icon: "M8 5L3 10L8 15M3 10H14A6 6 0 0 1 14 22",
            disabled: host.editing.editBlocked || !host.editing.undoCount,
            run: () => host.editing.travel("undo"),
          },
          {
            label: "やり直す",
            icon: "M16 5L21 10L16 15M21 10H10A6 6 0 0 0 10 22",
            disabled: host.editing.editBlocked || !host.editing.redoCount,
            run: () => host.editing.travel("redo"),
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
              host.editing.editBlocked ||
              !host.editing.objects.some(
                (object) => !object.locked && object.visible !== false,
              ),
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
          {
            label: "選択解除",
            icon: "M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M8 8L16 16M16 8L8 16",
            disabled:
              host.editing.mutationBlocked || !host.editing.selectedIds.length,
            run: () =>
              host.editing.transition(() => (host.editing.selectedIds = [])),
          },
          {
            label: "選択図形を複製",
            icon: "M9 9H21V21H9ZM15 5V3H3V15H5",
            disabled:
              host.editing.mutationBlocked || !host.editing.selectedIds.length,
            run: host.editing.duplicateSelection,
          },
          {
            label: "選択図形を削除",
            icon: "M3 6H21M9 6V3H15V6M6 6L7 21H17L18 6M10 10V17M14 10V17",
            disabled:
              host.editing.mutationBlocked || !host.editing.selectedIds.length,
            run: host.editing.removeSelection,
          },
        ],
      },
      ...(host.groups
        ? [
            {
              id: "geometric-groups",
              label: "幾何グループ",
              items: [
                {
                  label: "グループ化",
                  icon: "M3 3H10V10H3ZM14 14H21V21H14ZM1 1H23V23H1Z",
                  disabled:
                    host.editing.mutationBlocked ||
                    host.groups.definition ||
                    host.groups.containsGroups ||
                    host.editing.selectedIds.length < 2,
                  run: host.groups.create,
                },
                {
                  label: "グループ解除",
                  icon: "M3 3H10V10H3ZM14 14H21V21H14ZM1 8V1H8M16 1H23V8M23 16V23H16M8 23H1V16",
                  disabled:
                    host.editing.mutationBlocked || !host.groups.groupId,
                  run: host.groups.ungroup,
                },
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
            disabled:
              host.editing.mutationBlocked ||
              (host.groups?.unitCount ?? host.editing.selectedIds.length) < 3,
            run: () =>
              host.editing.edit({
                type: "distribute",
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
    return [
      {
        label: "切り取り",
        disabled:
          host.editing.mutationBlocked ||
          host.clipboard.busy ||
          !host.editing.selectedIds.length,
        run: () => host.clipboard.action("cut"),
      },
      {
        label: "コピー",
        disabled:
          host.editing.editBlocked ||
          host.clipboard.busy ||
          !host.editing.selectedIds.length,
        run: () => host.clipboard.action("copy"),
      },
      {
        label: "貼り付け",
        disabled: host.editing.editBlocked || host.clipboard.busy,
        run: () => host.clipboard.action("paste"),
      },
    ];
  }
  function selectionContext(
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
                { kind: "text", label: "Text を挿入" },
                { kind: "line", label: "線を挿入" },
                { kind: "pipe", label: "配管を挿入" },
              ] as const
            ).map((part) => ({
              label: part.label,
              disabled: host.editing.editBlocked,
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
        ? editGroupItems("align")
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
          {
            label: "新しいProject",
            disabled: host.view.menuBlocked,
            run: host.files.newProject,
          },
          {
            label: "Project を開く",
            disabled: host.view.menuBlocked,
            run: host.files.openProjectFile,
          },
          {
            label: "Project を保存",
            disabled: host.view.menuBlocked,
            run: host.files.save,
          },
          {
            label: "画像を配置",
            disabled:
              host.editing.editBlocked ||
              !!host.selection.definition ||
              host.files.imageBusy,
            run: host.files.openPlacement,
          },
          {
            label: "プロジェクト名を変更",
            disabled: host.editing.editBlocked,
            run: host.files.focusProjectName,
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
            disabled: !!host.view.selectionViewReason,
            run: host.view.showSelection,
          },
          {
            label: host.view.showRulers ? "ルーラーを隠す" : "ルーラーを表示",
            disabled: host.view.mode !== "edit",
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
            disabled: host.view.mode !== "edit",
            run: () =>
              host.view.setAuxPanelVisibility(
                { references: !host.view.showReferences },
                "references",
              ),
          },
          {
            label: host.view.previousPanels
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
            disabled: host.view.mode !== "edit",
            run: () =>
              host.view.setInspectorVisibility(!host.view.showInspector, true),
          },
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
            disabled: host.view.mode !== "edit",
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
        items: [
          {
            label: "画面を埋め込む",
            disabled: host.editing.editBlocked || !!host.selection.definition,
            run: host.files.openScreenViewDialog,
          },
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
            disabled: host.editing.editBlocked,
            run: () => host.files.add(part.kind),
          })),
          ...(["pump", "valve"] as const).map((template) => ({
            label: template === "pump" ? "ポンプを追加" : "バルブを追加",
            disabled: host.editing.editBlocked || !!host.selection.definition,
            run: () => {
              host.editing.edit({
                type: "add-symbol",
                screenId: host.editing.screenId,
                template,
              });
            },
          })),
        ],
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
        label: "ヘルプ",
        items: [
          {
            label: "操作ガイド・アプリ情報",
            run: () => (host.view.helpOpen = true),
          },
        ],
      },
    ];
  }
  return { folderContext, editGroups, clipboardItems, selectionContext, menus };
}
