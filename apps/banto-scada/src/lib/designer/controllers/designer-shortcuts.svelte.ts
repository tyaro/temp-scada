import {
  createShortcutDispatcher,
  matchShortcut,
  type CommandSpec,
} from "@banto/ui";
import type {
  createDesignerActions,
  DesignerCommandId,
} from "./designer-actions";

/**
 * Designer のキー操作（R7f）。dispatcher への登録・保存キー・ブラウザの予約キー・
 * ダイアログ／配置／フォルダが先に取るキーの順を持つ。状態は host の getter、
 * 処理は host の callback で受ける。`<svelte:window onkeydown>` の受付は App に
 * 残し、`handle` を呼ぶ。メニュー・toolbar と共有する操作は App が作る
 * `designerActions` から受け、App が生成の後に `register` を呼ぶ。
 */
export interface DesignerShortcutsHost {
  readonly busy: boolean;
  readonly clipboardBusy: boolean;
  /** draft の確認（`drafts.pending`）の表示中。 */
  readonly draftPending: boolean;
  /** 「Project を置き換えますか」の表示中（`projectFiles.replacement`）。 */
  readonly replacement: boolean;
  readonly helpOpen: boolean;
  /** 編集中でキャンバスを表示している（W4: 作業画面の表示中は false）。 */
  readonly canvasActive: boolean;
  /** 位置を決める配置（`placement.positionPlacement`）の途中。 */
  readonly positionPlacement: boolean;
  /**
   * 運転表示・履歴・警報一覧・端末設定・記録の管理／運用・トレンド定義・記録計画の
   * 窓のどれかが開いている。開いている間は Designer のキーを取らない。
   */
  readonly runtimeWindowOpen: boolean;
  /**
   * 画面の表示設定・割付表・配列コピー・フォルダ・削除確認のダイアログのどれかが
   * 開いている。
   */
  readonly dialogOpen: boolean;
  /** プロパティか設備ライブラリのタグ選択が開いている。 */
  isTagPickerOpen(): boolean;
  clipboardScope(target: EventTarget | null): boolean;
  hiddenCanvasMutation(target: EventTarget | null): boolean;
  renameFocused(target: EventTarget | null): void;
  removeSelection(): void;
  save(): void | Promise<void>;
  saveAs(): void | Promise<void>;
  stopPlacement(focus: boolean): void;
  /** レイヤーのフォルダの削除確認を開く（`openFolderRequest("remove", …)`）。 */
  removeFolder(folderId: string | undefined, origin: HTMLElement): void;
}

type DesignerActions = Pick<
  ReturnType<typeof createDesignerActions>,
  "command"
>;

export function createDesignerShortcutsController(host: DesignerShortcutsHost) {
  // Banto #435 の操作定義と dispatcher（createShortcutDispatcher）でキーを処理する。
  // 上流の保護（IME・defaultPrevented・押し続け・入力欄・モーダル・メニュー）を
  // そのまま使うが、F 以外はコンテキストメニューを開いたままの Ctrl+A などで選択を
  // 変え、メニューを閉じる（selection-context の約束）ので、blockOnMenu: false で
  // メニューでは止めない（tyaro/banto#669）。モーダルでは上流が止める。
  // enabled／run は event を受け取らないので、処理中の keydown の対象を控える。
  let shortcutTarget: EventTarget | null = null;
  function filePromptsReady() {
    return (
      !host.busy && !host.draftPending && !host.replacement && !host.helpOpen
    );
  }
  function functionKeysReady() {
    return (
      !host.busy &&
      !host.clipboardBusy &&
      !host.draftPending &&
      !host.replacement &&
      !host.helpOpen &&
      !host.isTagPickerOpen()
    );
  }
  // 従来どおり Ctrl と Cmd（Meta）のどちらでも効かせる（tyaro/banto#669）。
  // メニューに出すキーの記号は OS に合わせたまま。
  const shortcutDispatcher = createShortcutDispatcher({ mod: "either" });
  const menuScoped = { blockOnMenu: false } as const;
  // メニュー・toolbar と共有する操作（designer-actions の CommandSpec）にキーを付ける。
  // 名前・実行・使える条件は共有側が決め、キーは自分だけの保護（when: 入力元・
  // キャンバス上の対象・ヘルプやタグ選択の表示中など）を足すだけ。
  type KeyOptions = Pick<
    CommandSpec,
    | "allowInEditable"
    | "allowRepeat"
    | "preventDefaultWhenDisabled"
    | "blockOnMenu"
  > & {
    keyId?: string;
    shortcut?: string;
    when?: () => boolean;
    run?: () => void;
  };
  // キーは既定で共有側の shortcut（メニューに出すキー）。別のキーは shortcut で渡す。
  function keyCommand(
    actions: DesignerActions,
    id: DesignerCommandId,
    { keyId, shortcut, when, run, ...flags }: KeyOptions = {},
  ): CommandSpec {
    const shared = actions.command(id);
    return {
      ...flags,
      id: keyId ?? id,
      title: shared.title,
      shortcut: shortcut ?? shared.shortcut,
      visible: shared.visible,
      enabled: () => (when?.() ?? true) && (shared.enabled?.() ?? true),
      run: run ?? shared.run,
    };
  }
  // designerActions の生成より後で呼ぶ（App の register）。
  function designerShortcuts(actions: DesignerActions): CommandSpec[] {
    const key = (id: DesignerCommandId, options?: KeyOptions) =>
      keyCommand(actions, id, options);
    // F1／F2・Ctrl+N／O は入力欄の中でも効き、ブラウザのヘルプ等は常に止める。
    const fileKey = {
      allowInEditable: true,
      preventDefaultWhenDisabled: true,
      ...menuScoped,
    } as const;
    return [
      key("selection.show", {
        when: () => !host.helpOpen && host.clipboardScope(shortcutTarget),
      }),
      key("help.open", { ...fileKey, when: functionKeysReady }),
      {
        id: "object.rename",
        title: "名前を変更",
        shortcut: "F2",
        ...fileKey,
        enabled: functionKeysReady,
        run: () => {
          if (host.canvasActive && !host.positionPlacement)
            host.renameFocused(shortcutTarget);
        },
      },
      key("selection.remove", {
        ...menuScoped,
        when: () =>
          !host.clipboardBusy &&
          !host.positionPlacement &&
          host.clipboardScope(shortcutTarget),
        run: () => {
          if (!host.hiddenCanvasMutation(shortcutTarget))
            host.removeSelection();
        },
      }),
      key("project.new", {
        ...fileKey,
        when: filePromptsReady,
      }),
      key("project.open", {
        ...fileKey,
        when: filePromptsReady,
      }),
      // 入力欄では標準の編集・Undo を優先する。押し続けの繰り返しは元に戻す・やり直しだけ。
      key("history.undo", { allowRepeat: true, ...menuScoped }),
      key("history.redo", {
        keyId: "history.redoShift",
        shortcut: "Mod+Shift+Z",
        allowRepeat: true,
        ...menuScoped,
      }),
      key("history.redo", {
        allowRepeat: true,
        ...menuScoped,
      }),
      // W4: Ctrl+A／G／D はキャンバスの表示中だけ（共有側の canvasBlocked）。
      // Ctrl+G はブラウザの「次を検索」を出さないよう、使えないときも既定を止める。
      key("selection.all", menuScoped),
      key("selection.group", {
        preventDefaultWhenDisabled: true,
        ...menuScoped,
      }),
      key("selection.ungroup", {
        preventDefaultWhenDisabled: true,
        ...menuScoped,
      }),
      key("selection.duplicate", menuScoped),
    ];
  }
  // Ctrl+S・Shift+Ctrl+S は dispatcher に載せず、層（モーダル・メニュー）では止めない。
  // 「Project を置き換えますか」の表示中に書き出してから破棄する流れがあり、また
  // メニューとモーダルが同時に残ると（メニュー→F1）上流の判定では互いに「上」になり、
  // ownerLayer ではどの層も選べないため。IME・先に止められたキー・押し続けでは書き出さず、
  // 入力欄の中でも効き、ブラウザの既定（ページ保存）は常に止める（従来と同じ）。
  const saveShortcuts: CommandSpec[] = [
    {
      id: "project.save",
      title: "保存",
      shortcut: "Mod+S",
      enabled: () => !host.busy,
      run: () => host.save(),
    },
    {
      id: "project.saveAs",
      title: "名前を付けて保存",
      shortcut: "Mod+Shift+S",
      enabled: () => !host.busy,
      run: () => host.saveAs(),
    },
  ];
  function handleSaveShortcut(event: KeyboardEvent) {
    const command = saveShortcuts.find((command) =>
      matchShortcut(event, command.shortcut!, "other", "either"),
    );
    if (!command || event.isComposing || event.keyCode === 229) return false;
    const consumed = event.defaultPrevented;
    event.preventDefault();
    if (!consumed && !event.repeat && command.enabled?.() !== false)
      void command.run();
    return true;
  }
  // 保護で断ったときもブラウザの既定（ヘルプ・新規ウィンドウ・ページ保存など）は止める。
  function reservedBrowserKey(event: KeyboardEvent) {
    if (event.altKey) return false;
    const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (plain && (event.key === "F1" || event.key === "F2")) return true;
    if (!(event.ctrlKey || event.metaKey) || event.isComposing) return false;
    const key = event.key.toLowerCase();
    return key === "s" || (!event.shiftKey && (key === "n" || key === "o"));
  }
  // `<svelte:window onkeydown>` から呼ぶ。
  function handle(event: KeyboardEvent) {
    if (host.runtimeWindowOpen) return;
    // F・F1・F2 は下のダイアログ・配置・フォルダの扱いより先に決める（従来の順）。
    const functionKey =
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key.toLowerCase() === "f" ||
        event.key === "F1" ||
        event.key === "F2");
    if (!functionKey && routeBeforeCommands(event)) return;
    if (handleSaveShortcut(event)) return;
    shortcutTarget = event.target;
    try {
      if (shortcutDispatcher.handle(event)) return;
    } finally {
      shortcutTarget = null;
    }
    if (reservedBrowserKey(event)) event.preventDefault();
  }
  // ダイアログ・タグ選択・配置・レイヤーのフォルダが先にキーを取る。取ったら true。
  function routeBeforeCommands(event: KeyboardEvent) {
    if (
      host.dialogOpen ||
      host.isTagPickerOpen() ||
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
      return true;
    }
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      host.positionPlacement &&
      !host.draftPending &&
      !host.replacement &&
      !(
        event.target instanceof Element &&
        event.target.closest(
          'input,textarea,select,[contenteditable],[role="menu"],[role="dialog"]',
        )
      )
    ) {
      event.preventDefault();
      host.stopPlacement(true);
      return true;
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
          host.removeFolder(focusedFolder.dataset.layerFolder, focusedFolder);
        return true;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        ["d", "x", "c"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  }

  return {
    // designerActions の生成より後に App から 1 回呼ぶ。
    register(actions: DesignerActions) {
      shortcutDispatcher.register("designer", designerShortcuts(actions));
    },
    handle,
  };
}
