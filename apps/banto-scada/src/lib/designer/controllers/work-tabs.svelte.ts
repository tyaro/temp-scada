/**
 * メイン領域の作業タブ（Issue #223、docs/design/editor/main-work-tabs-design.md §3）。
 *
 * 開いている作業タブの並びと選択中のタブだけを持つ。選択が `null` のときは
 * 画面タブ（キャンバス）を表示する。表示の可否（`workTabsShown`／`canvasActive`）、
 * モード・Symbol 定義の編集・未適用入力との接続は App が持つ。
 *
 * - `open`／`select`／`close` は利用者の操作の入口で、`host.transition`
 *   （`drafts.allow`）を1回だけ通す（W2）。
 * - `selectNow` はゲートを通さない同期の切替で、W2 の例外（`revealDraftForm`、
 *   Undo／Redo、`edit()` や `allow` 済みの action の中）だけが使う。
 */
export type WorkTabKind =
  "equipment" | "alarm-definitions" | "project-settings";

export const WORK_TABS: readonly { kind: WorkTabKind; label: string }[] = [
  { kind: "equipment", label: "機器" },
  { kind: "alarm-definitions", label: "警報の定義" },
  { kind: "project-settings", label: "プロジェクト設定" },
];

export function workTabLabel(kind: WorkTabKind): string {
  return WORK_TABS.find((tab) => tab.kind === kind)!.label;
}

export type WorkTabCause = "open" | "select" | "close" | "now" | "reset";

export interface WorkTabChange {
  /** 切替前の選択（`null` は画面タブ）。 */
  previous: WorkTabKind | null;
  /** 切替後の選択（`null` は画面タブ）。 */
  next: WorkTabKind | null;
  cause: WorkTabCause;
}

export interface WorkTabsHost {
  /** 未適用入力のゲート（App の `transition`）。通過したら `run` を呼ぶ。 */
  transition(run: () => void): void;
  /**
   * 選択を書き換える直前に同期で呼ぶ。キャンバスを隠す前の表示位置の控えなど、
   * 切替前の状態を読む処理と、切替後のフォーカス移動の予約に使う。
   */
  changing?(change: WorkTabChange): void;
}

export function createWorkTabsController(host: WorkTabsHost) {
  let tabs = $state<WorkTabKind[]>([]);
  let selected = $state<WorkTabKind | null>(null);
  // 閉じたときに戻る先（直前に選んでいたタブ）。表示には使わない。
  let returnTo: WorkTabKind | null = null;

  function change(next: WorkTabKind | null, cause: WorkTabCause) {
    const previous = selected;
    host.changing?.({ previous, next, cause });
    if (previous !== next) {
      returnTo = previous;
      selected = next;
    }
  }

  function selectNow(kind: WorkTabKind | null) {
    if (kind && !tabs.includes(kind)) tabs = [...tabs, kind];
    if (selected === kind) return;
    change(kind, "now");
  }

  return {
    get tabs(): readonly WorkTabKind[] {
      return tabs;
    },
    get selected(): WorkTabKind | null {
      return selected;
    },
    isOpen(kind: WorkTabKind) {
      return tabs.includes(kind);
    },
    /** 作業タブを開いて選ぶ（開いていれば選ぶだけ）。 */
    open(kind: WorkTabKind) {
      host.transition(() => {
        if (!tabs.includes(kind)) tabs = [...tabs, kind];
        change(kind, "open");
      });
    },
    /** 開いている作業タブ、または `null`（画面タブ）を選ぶ。 */
    select(kind: WorkTabKind | null) {
      host.transition(() => {
        if (kind && !tabs.includes(kind)) return;
        if (selected === kind) return;
        change(kind, "select");
      });
    },
    /** 作業タブを閉じる。選択中なら直前に選んでいたタブ（なければ画面タブ）へ戻る。 */
    close(kind: WorkTabKind) {
      host.transition(() => {
        if (!tabs.includes(kind)) return;
        tabs = tabs.filter((item) => item !== kind);
        if (selected === kind) {
          const next =
            returnTo !== null && tabs.includes(returnTo) ? returnTo : null;
          change(next, "close");
          returnTo = null;
        } else {
          if (returnTo === kind) returnTo = null;
          host.changing?.({
            previous: selected,
            next: selected,
            cause: "close",
          });
        }
      });
    },
    selectNow,
    /** Project の採用（W7）。ゲートは呼び出し側で通過済み。 */
    reset() {
      if (!tabs.length && selected === null) return;
      host.changing?.({ previous: selected, next: null, cause: "reset" });
      tabs = [];
      selected = null;
      returnTo = null;
    },
  };
}

export type WorkTabsController = ReturnType<typeof createWorkTabsController>;
