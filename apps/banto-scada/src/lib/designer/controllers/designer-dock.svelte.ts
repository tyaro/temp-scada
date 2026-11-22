import { untrack } from "svelte";
import type { DockPanelChangeOutcome, DockState } from "@banto/dock-svelte";
import {
  DESIGNER_LEFT_PANES,
  DESIGNER_PANE_IDS,
  frontLeftPanes,
  type DesignerLeftPane,
} from "../dock-layout";

/** `ThreePaneDock` の操作の口のうち、ここで使うもの。 */
export interface DesignerDockView {
  isVisible(id: string): boolean;
  setVisible(
    id: string,
    visible: boolean,
  ): Promise<DockPanelChangeOutcome | "unavailable">;
  restoreLayout(saved: unknown): Promise<unknown>;
}

export interface DesignerDockHost {
  readonly mode: "edit" | "preview";
  readonly previewFullscreen: boolean;
  /**
   * dock の狭い表示（左右は端の帯）か、その幅になっている（dock が狭い表示へ切り替える
   * 途中は、レイヤー・部品が隠れてから `narrow` が true になる）。
   */
  readonly narrow: boolean;
  /** dock が今、狭い表示を出している（`ThreePaneDock` の `narrow`）。 */
  readonly narrowShown: boolean;
  /** Inspector を画面に出したい（`showInspector` かつキャンバスの表示中）。 */
  readonly inspectorWanted: boolean;
  /** 利用者の Inspector の表示・非表示を `showInspector` へ写してよい（編集中のキャンバス）。 */
  readonly inspectorAdoptable: boolean;
  adoptInspector(visible: boolean): void;
}

type PaneKey = DesignerLeftPane | "inspector";
const PANE_KEYS: readonly PaneKey[] = [...DESIGNER_LEFT_PANES, "inspector"];

/**
 * Designer の枠の表示・非表示（#331 D2）。
 *
 * - アプリの状態（左3つの表示・`showInspector`・モード・全画面プレビュー）から各 pane を
 *   出すかを決め（`desired`）、dock の `setVisible` へ渡す（`push`）。
 * - 利用者が dock の側で隠した・出した（✕、狭い表示への切り替えで帯へ移らなかった pane）
 *   ときは、編集中ならアプリの状態へ写し、そうでなければアプリの状態へ戻す（`adopt`）。
 * - `pushed` は最後に dock と一致させた（または依頼した）値。依頼の途中（`inflight`）の
 *   pane は dock の側の変化として数えない。依頼が通らなかったときは、終わった後に
 *   dock の今の値と比べ直す。
 * - 依頼は pane ごとに新しいものが持ち主になる（`owner`）。古い一括の依頼は、各 await の
 *   後に持ち主でなくなった pane を飛ばす（後から出した逆の依頼に負ける）。dock の見た目が
 *   今の希望と同じでも、承認待ちの逆の依頼（`asking`）があれば希望を dock へ伝え直し、
 *   古い依頼を上流に `stale` にさせる。
 * - 各 pane の表示とは別に、左で何を表に出すか（広い表示の表のタブ・狭い表示の引き出し）の
 *   最新の意図を番号つきで持つ（`frontIntent`）。一括の処理は終わったときに意図の持ち主で
 *   なければ自分の選び直し（前に表だったもの・引き出しを閉じる）をせず、後から明示した
 *   パネルを表に戻す（途中で戻したパネルが表を奪っていることがある）。
 * - 狭い表示の引き出しはどれか 1 つだけが開く。どれを開いておくかの最新の明示の意図
 *   （左のパネルを出す・Inspector を開く）は `flyoutIntent` に別に持つ。上流は狭い表示で
 *   隠れていた pane を出すとその引き出しを開くので、古い一括の処理は終わったときに
 *   意図の持ち主でなければ、意図した引き出しを開き直す（Inspector を開く操作は左の表の
 *   タブを変えないので、広い表示の `frontIntent` には数えない）。
 */
export function createDesignerDock(dock: DockState, host: DesignerDockHost) {
  let view = $state.raw<DesignerDockView>();
  const left = $state<Record<DesignerLeftPane, boolean>>({
    project: true,
    layers: true,
    parts: true,
  });
  const pushed = new Map<PaneKey, boolean>();
  const inflight = new Map<PaneKey, number>();
  /** dock の側の変化を読み直す合図（依頼が終わったとき）。 */
  let settled = $state(0);
  /** pane ごとの依頼の持ち主（最後に出した依頼の番号）。 */
  const owner = new Map<PaneKey, number>();
  let requests = 0;
  /** dock へ渡して承認を待っている値（pane ごとに最後のもの）。 */
  const asking = new Map<PaneKey, { want: boolean }>();
  /**
   * 左で何を表に出すかの最新の意図。`id` は出した依頼の番号、`pane` は明示に選んだ
   * パネル（`showLeftPane`）。`pane` が無いのは一括の処理が自分で選び直す意図。
   */
  let frontIntent: { id: number; pane?: DesignerLeftPane } = { id: 0 };
  /**
   * 狭い表示でどの引き出しを開いておくかの最新の意図。`pane` は明示に開いたもの
   * （左のパネル・Inspector）、無いのは一括の処理が自分で決める（左の引き出しを閉じる）意図。
   */
  let flyoutIntent: { id: number; pane?: PaneKey; none?: boolean } = { id: 0 };
  /** 前に見たとき開いていた引き出し（`noteFlyout`）。 */
  let lastFlyout: string | null = null;

  /**
   * 開いている引き出しの変化を見る。意図した引き出しが閉じた（何も開いていない）のは、
   * 利用者が Esc・外へのフォーカス・帯のタブで閉じたもの。上流はこれを直接閉じるので、
   * ここで「どれも開かない」という最新の意図にする（古い一括の処理が開き直さない）。
   * 上流が別の pane へ切り替えた（`revealNarrow`）のは閉じたとは数えない。
   */
  function noteFlyout(open: string | null) {
    const before = lastFlyout;
    lastFlyout = open;
    const pane = flyoutIntent.pane;
    if (open === null && pane && before === DESIGNER_PANE_IDS[pane])
      flyoutIntent = { id: ++requests, none: true };
  }

  /** 左で表に出すもの・開く引き出しの意図を、番号 `id` の処理のものにする。 */
  function intend(id: number, pane?: DesignerLeftPane) {
    frontIntent = { id, pane };
    flyoutIntent = { id, pane };
  }

  function desired(key: PaneKey): boolean {
    if (key === "inspector")
      return host.mode === "edit" && host.inspectorWanted;
    if (host.mode !== "edit")
      return key === "project" && !host.previewFullscreen;
    return left[key];
  }

  function shown(target: DesignerDockView, key: PaneKey) {
    return target.isVisible(DESIGNER_PANE_IDS[key]);
  }

  /** 依頼の間は `inflight` に数え、終わったら dock の側の変化を読み直す。 */
  function request(keys: PaneKey[], run: () => Promise<unknown>) {
    for (const key of keys) inflight.set(key, (inflight.get(key) ?? 0) + 1);
    return run().finally(() => {
      for (const key of keys) {
        const count = (inflight.get(key) ?? 1) - 1;
        if (count > 0) inflight.set(key, count);
        else inflight.delete(key);
      }
      settled++;
    });
  }

  /** 依頼の持ち主を新しい番号にする（古い依頼はその pane を飛ばす）。 */
  function claim(keys: readonly PaneKey[]): number {
    const id = ++requests;
    for (const key of keys) owner.set(key, id);
    return id;
  }

  /** dock の `setVisible` を呼ぶ（承認を待つあいだは `asking` に控える）。 */
  async function send(target: DesignerDockView, key: PaneKey, want: boolean) {
    const entry = { want };
    asking.set(key, entry);
    try {
      await target.setVisible(DESIGNER_PANE_IDS[key], want);
    } finally {
      if (asking.get(key) === entry) asking.delete(key);
    }
  }

  /**
   * dock の見た目を `want` にする。見た目が同じでも、承認待ちの逆の依頼があれば
   * 新しい希望を伝える（上流は古い依頼を適用の直前に `stale` にする）。
   */
  function ask(target: DesignerDockView, key: PaneKey, want: boolean) {
    const pending = asking.get(key);
    if (shown(target, key) === want && (!pending || pending.want === want))
      return Promise.resolve();
    return send(target, key, want);
  }

  function push(key: PaneKey, want: boolean): Promise<unknown> {
    pushed.set(key, want);
    const id = claim([key]);
    return request([key], async () => {
      const target = view;
      if (target && owner.get(key) === id) await ask(target, key, want);
    });
  }

  /** 開いている引き出しが左のパネルのときだけ閉じる（Inspector の引き出しは残す）。 */
  function closeLeftFlyout() {
    const open = dock.flyoutPanel;
    if (DESIGNER_LEFT_PANES.some((pane) => DESIGNER_PANE_IDS[pane] === open))
      dock.closeFlyout();
  }

  /** 端の帯にある `pane` の引き出しを開く（開いていれば何もしない）。 */
  function openBandFlyout(target: DesignerDockView, pane: PaneKey) {
    const id = DESIGNER_PANE_IDS[pane];
    if (!shown(target, pane) || !dock.isAutoHidden(id)) return false;
    if (dock.flyoutPanel !== id) dock.openFlyout(id);
    return true;
  }

  /**
   * 後から明示したパネルを表に戻す。狭い表示では意図した引き出し（`flyoutIntent.pane`、
   * Inspector も含む）を開き直し、広い表示では `frontIntent.pane` を表のタブにする。
   */
  async function keepFront(target: DesignerDockView) {
    if (view !== target) return;
    if (host.narrow) {
      // 利用者が引き出しを閉じた後なら、古い処理が開いた左の引き出しを閉じておく。
      if (flyoutIntent.none) {
        closeLeftFlyout();
        return;
      }
      const pane = flyoutIntent.pane;
      if (pane && desired(pane)) openBandFlyout(target, pane);
      return;
    }
    const pane = frontIntent.pane;
    if (!pane || !left[pane] || !shown(target, pane)) return;
    if (!openBandFlyout(target, pane))
      await target.setVisible(DESIGNER_PANE_IDS[pane], true);
  }

  /**
   * 一括の処理（番号 `id`）の終わりに表を選び直す。意図の持ち主のままなら `own` を行い、
   * 後から別の意図が出ていればそれを守る。
   */
  async function settleFront(
    target: DesignerDockView,
    id: number,
    own: () => Promise<unknown> | void,
  ) {
    if (view !== target) return;
    const intent = host.narrow ? flyoutIntent : frontIntent;
    if (intent.id === id) await own();
    else await keepFront(target);
  }

  // 最後に表に出ていた左のパネル（編集モードだけ。プレビューは Project だけが出る）。
  let lastFront: DesignerLeftPane[] = [];

  /**
   * 左のパネルをまとめて出す・隠す。1 つずつ順に依頼する（狭い表示では 1 回ごとに
   * 配置全体を組み直すので、重ねると古くなる）。隠れていたものを戻すと戻したものが
   * 表のタブになるので、最後に前に表だったもの（無ければ Project）を表に戻す。
   */
  function pushLeft(wants: [DesignerLeftPane, boolean][]): Promise<unknown> {
    const target = view;
    const before = lastFront.length ? lastFront : frontLeftPanes(dock.layout);
    const reveals = wants.some(
      ([pane, want]) => want && !!target && !shown(target, pane),
    );
    for (const [pane, want] of wants) pushed.set(pane, want);
    const panes = wants.map(([pane]) => pane);
    const id = claim(panes);
    if (reveals) intend(id);
    const owns = (pane: DesignerLeftPane) => owner.get(pane) === id;
    return request(panes, async () => {
      if (!target) return;
      for (const [pane, want] of wants) {
        if (view !== target) return;
        // 後から出した依頼が持ち主になった pane は飛ばす（古い一括の打ち切り）。
        if (owns(pane)) await ask(target, pane, want);
      }
      if (!reveals) return;
      await settleFront(target, id, async () => {
        if (!panes.some(owns)) return;
        // 狭い表示では戻したパネルは端の帯に並ぶ。引き出し（flyout）は開けたままにしない。
        if (host.narrow) {
          closeLeftFlyout();
          return;
        }
        const front =
          before.find((pane) => left[pane]) ??
          (left.project ? "project" : undefined);
        if (front && shown(target, front))
          await target.setVisible(DESIGNER_PANE_IDS[front], true);
      });
    });
  }

  /**
   * dock の側で変わった（利用者の操作・狭い表示の切り替え・断られた依頼）。
   * `banded` は前に見たとき端の帯にあったか、`restored` は広い表示へ戻る切り替えで
   * 控えの配置から木へ戻ったか。隠し直す左のパネルを返す。
   */
  function adopt(
    key: PaneKey,
    visible: boolean,
    banded: boolean,
    restored: boolean,
  ): [DesignerLeftPane, boolean] | undefined {
    if (host.mode === "edit" && key !== "inspector") {
      // 狭い表示への切り替えは木にあったレイヤー・部品を隠す。利用者の選択としては
      // 数えない（帯へ戻すのは下の狭い表示の effect）。帯の pane の ✕ は利用者の非表示。
      if (!visible && host.narrow && !banded) return;
      // 広い表示へ戻ると dock は控えた配置に戻す。狭い表示のあいだに ✕ で隠した pane は
      // 隠し直す（アプリの希望が勝つ）。
      if (visible && restored) return left[key] ? undefined : [key, false];
      left[key] = visible;
      return;
    }
    if (
      key === "inspector" &&
      host.mode === "edit" &&
      host.inspectorAdoptable
    ) {
      // 左と同じく、広い表示へ戻って控えの配置から出てきたときはアプリの希望が勝つ
      // （狭い表示のあいだに ✕ で隠した Inspector を開き直さない）。
      if (visible && restored) {
        if (!desired(key)) void push(key, false);
        return;
      }
      host.adoptInspector(visible);
      return;
    }
    void push(key, desired(key));
  }

  // 引き出しの変化を見る（利用者が閉じたかを `noteFlyout` が判定する）。
  $effect(() => {
    const open = dock.flyoutPanel;
    untrack(() => noteFlyout(open));
  });

  /** 前に見たとき端の帯にあった pane と、dock が狭い表示だったか。 */
  const wasBanded = new Set<PaneKey>();
  let wasNarrowShown = false;

  // dock → アプリ
  $effect(() => {
    const target = view;
    void settled;
    if (!target) return;
    const seen = PANE_KEYS.map(
      (key) =>
        [
          key,
          shown(target, key),
          dock.isAutoHidden(DESIGNER_PANE_IDS[key]),
        ] as const,
    );
    const narrowShown = host.narrowShown;
    untrack(() => {
      // 狭い表示では、出す pane は端の帯へ入る。木へ戻ったのは広い表示への切り替え
      // （dock の `narrow` は配置が戻った後に false になる）。
      const leaving = wasNarrowShown || narrowShown;
      const rehide: [DesignerLeftPane, boolean][] = [];
      for (const [key, visible, banded] of seen) {
        const before = wasBanded.has(key);
        if (banded) wasBanded.add(key);
        else wasBanded.delete(key);
        if (inflight.has(key)) continue;
        const last = pushed.get(key);
        if (last === visible) continue;
        pushed.set(key, visible);
        if (last === undefined) continue;
        const fix = adopt(key, visible, before, visible && leaving && !banded);
        if (fix) rehide.push(fix);
      }
      wasNarrowShown = narrowShown;
      if (rehide.length) void pushLeft(rehide);
    });
  });

  // アプリ → dock（依頼の途中の pane は、終わってから比べ直す）
  $effect(() => {
    const target = view;
    void settled;
    if (!target) return;
    const wants = PANE_KEYS.map((key) => [key, desired(key)] as const);
    untrack(() => {
      const leftWants: [DesignerLeftPane, boolean][] = [];
      for (const [key, want] of wants) {
        if (inflight.has(key) || pushed.get(key) === want) continue;
        if (key === "inspector") void push(key, want);
        else leftWants.push([key, want]);
      }
      if (leftWants.length) void pushLeft(leftWants);
    });
  });

  // 狭い表示: 出しておく左のパネルを端の帯に並べる（dock の狭い表示は左右だけを帯に置く）。
  $effect(() => {
    const target = view;
    if (!target || !host.narrow || host.mode !== "edit") return;
    untrack(() => {
      const panes = DESIGNER_LEFT_PANES.filter(
        (pane) => left[pane] && !inflight.has(pane) && !shown(target, pane),
      );
      if (!panes.length) return;
      for (const pane of panes) pushed.set(pane, true);
      const id = claim(panes);
      intend(id);
      void request(panes, async () => {
        for (const pane of panes)
          if (view === target && host.narrow && owner.get(pane) === id)
            await ask(target, pane, true);
        await settleFront(target, id, closeLeftFlyout);
      });
    });
  });

  const front = $derived(frontLeftPanes(dock.layout));
  // まとめて隠す・戻す途中の並びは数えない（隠すたびに残りのタブが表に出る）。
  $effect(() => {
    void settled;
    if (
      front.length &&
      host.mode === "edit" &&
      !DESIGNER_LEFT_PANES.some((pane) => inflight.has(pane))
    )
      lastFront = front;
  });

  return {
    get view() {
      return view;
    },
    set view(value: DesignerDockView | undefined) {
      view = value;
    },
    /** アプリの側からの表示・非表示・置き換えを dock へ依頼している途中。 */
    get requesting() {
      return inflight.size > 0;
    },
    /** 左のパネルが 1 つでも出ている（編集モードの「左パネル」）。 */
    get showSidebar() {
      return DESIGNER_LEFT_PANES.some((pane) => left[pane]);
    },
    /** 表に出ている左のパネル（文脈の鍵の失効に使う）。 */
    get activePanel() {
      return front.join(",");
    },
    /** 左のパネルをまとめて出す・隠す。出すときは隠れていたものをすべて戻す。 */
    setSidebar(visible: boolean): Promise<unknown> {
      for (const pane of DESIGNER_LEFT_PANES) left[pane] = visible;
      return pushLeft(DESIGNER_LEFT_PANES.map((pane) => [pane, desired(pane)]));
    },
    /** 左のパネルの 1 つを出して表のタブにする（部品パレットへの移動など）。 */
    showLeftPane(pane: DesignerLeftPane): Promise<unknown> {
      left[pane] = true;
      pushed.set(pane, true);
      const id = claim([pane]);
      intend(id, pane);
      return request([pane], async () => {
        // 見えていても表のタブにするので、いつも依頼する。
        const target = view;
        if (target && owner.get(pane) === id) await send(target, pane, true);
      });
    },
    /**
     * 配置を置き換える（「標準レイアウトに戻す」）。置き換えると左の表のタブも既定に
     * 戻るので、前に表だった左のパネルを表に戻す（文脈を変えない）。
     */
    async restore(layout: unknown): Promise<void> {
      const target = view;
      if (!target) return;
      const before = lastFront.length
        ? [...lastFront]
        : frontLeftPanes(dock.layout);
      const id = claim(PANE_KEYS);
      intend(id);
      await request([...PANE_KEYS], () => target.restoreLayout(layout));
      await settleFront(target, id, async () => {
        for (const pane of before)
          if (view === target && shown(target, pane))
            await request([pane], () =>
              target.setVisible(DESIGNER_PANE_IDS[pane], true),
            );
      });
    },
    /** 引き出しの変化を伝える（上の effect が呼ぶ。effect の動かない単体試験からも呼ぶ）。 */
    noteFlyout,
    /** Inspector の表示をアプリの状態に合わせ直す（`showInspector` を変えた直後に待つ）。 */
    syncInspector(): Promise<unknown> {
      return push("inspector", desired("inspector"));
    },
    /**
     * 明示の編集コマンド（画面名の変更・タグ参照からのジャンプ）で Inspector を開く。
     * 表示を合わせたうえで、狭い表示で端の帯にあるだけなら引き出しを開く
     * （帯に項目があることと、引き出しが開いていることは別）。
     */
    async revealInspector(): Promise<void> {
      // 引き出しの最新の意図にする（古い一括の処理が終わった後も開いたままにする）。
      const intent = { id: ++requests, pane: "inspector" as const };
      flyoutIntent = intent;
      await push("inspector", desired("inspector"));
      // 待つ間に別の引き出しを明示に開いていれば、それを奪わない。
      const target = view;
      if (target && flyoutIntent === intent && desired("inspector"))
        openBandFlyout(target, "inspector");
    },
  };
}
export type DesignerDock = ReturnType<typeof createDesignerDock>;
