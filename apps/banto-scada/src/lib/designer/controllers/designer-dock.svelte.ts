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

  function push(key: PaneKey, want: boolean): Promise<unknown> {
    pushed.set(key, want);
    return request([key], async () => {
      const target = view;
      if (!target || shown(target, key) === want) return;
      await target.setVisible(DESIGNER_PANE_IDS[key], want);
    });
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
    return request(
      wants.map(([pane]) => pane),
      async () => {
        if (!target) return;
        for (const [pane, want] of wants) {
          if (view !== target) return;
          if (shown(target, pane) !== want)
            await target.setVisible(DESIGNER_PANE_IDS[pane], want);
        }
        if (!reveals || view !== target) return;
        // 狭い表示では戻したパネルは端の帯に並ぶ。引き出し（flyout）は開けたままにしない。
        if (host.narrow) {
          dock.closeFlyout();
          return;
        }
        const front =
          before.find((pane) => left[pane]) ??
          (left.project ? "project" : undefined);
        if (front && shown(target, front))
          await target.setVisible(DESIGNER_PANE_IDS[front], true);
      },
    );
  }

  /** dock の側で変わった（利用者の操作・狭い表示の切り替え・断られた依頼）。 */
  function adopt(key: PaneKey, visible: boolean) {
    if (host.mode === "edit" && key !== "inspector") {
      // 狭い表示への切り替えはレイヤー・部品を隠す。利用者の選択としては数えない
      // （帯へ戻すのは下の狭い表示の effect、広い表示へ戻ると元の配置に戻る）。
      if (!visible && host.narrow) return;
      left[key] = visible;
      return;
    }
    if (
      key === "inspector" &&
      host.mode === "edit" &&
      host.inspectorAdoptable
    ) {
      host.adoptInspector(visible);
      return;
    }
    void push(key, desired(key));
  }

  // dock → アプリ
  $effect(() => {
    const target = view;
    void settled;
    if (!target) return;
    const seen = PANE_KEYS.map((key) => [key, shown(target, key)] as const);
    untrack(() => {
      for (const [key, visible] of seen) {
        if (inflight.has(key)) continue;
        const last = pushed.get(key);
        if (last === visible) continue;
        pushed.set(key, visible);
        if (last !== undefined) adopt(key, visible);
      }
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
      void request(panes, async () => {
        for (const pane of panes)
          if (view === target && host.narrow)
            await target.setVisible(DESIGNER_PANE_IDS[pane], true);
        dock.closeFlyout();
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
      return request([pane], async () => {
        await view?.setVisible(DESIGNER_PANE_IDS[pane], true);
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
      await request([...PANE_KEYS], () => target.restoreLayout(layout));
      for (const pane of before)
        if (view === target && shown(target, pane))
          await request([pane], () =>
            target.setVisible(DESIGNER_PANE_IDS[pane], true),
          );
    },
    /** Inspector の表示をアプリの状態に合わせ直す（`showInspector` を変えた直後に待つ）。 */
    syncInspector(): Promise<unknown> {
      return push("inspector", desired("inspector"));
    },
  };
}
export type DesignerDock = ReturnType<typeof createDesignerDock>;
