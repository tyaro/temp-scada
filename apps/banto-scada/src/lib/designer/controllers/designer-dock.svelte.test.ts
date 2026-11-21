import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import type { DockPanelChangeOutcome, DockState } from "@banto/dock-svelte";
import { DESIGNER_PANE_IDS } from "../dock-layout";
import {
  createDesignerDock,
  type DesignerDockView,
} from "./designer-dock.svelte";

/**
 * 承認を待たせる dock のモック。`setVisible` は `release` するまで終わらない。上流と同じく、
 * 承認待ちの間に同じ pane へ逆の値を頼むと最新の値が勝ち、古い依頼は `stale` になる。
 */
function delayedDock(narrow = false) {
  const visible = $state<Record<string, boolean>>(
    Object.fromEntries(
      Object.values(DESIGNER_PANE_IDS).map((id) => [id, true]),
    ),
  );
  const wanted = new Map<string, boolean>();
  const pending: (() => void)[] = [];
  const calls: string[] = [];
  // 左の表のタブ（広い表示）と引き出し（狭い表示）。上流と同じく、出した左のパネルが
  // 表のタブになり、狭い表示では隠れていたものを出すとその引き出しが開く。
  const leftIds: string[] = [
    DESIGNER_PANE_IDS.project,
    DESIGNER_PANE_IDS.layers,
    DESIGNER_PANE_IDS.parts,
  ];
  const state = { front: "", flyout: null as string | null };
  const dock = {
    layout: { docked: null, floating: [], autoHidden: [] },
    isAutoHidden: (id: string) => narrow && (visible[id] ?? false),
    get flyoutPanel() {
      return state.flyout;
    },
    openFlyout(id: string) {
      state.flyout = id;
    },
    closeFlyout() {
      state.flyout = null;
    },
  } as unknown as DockState;
  const view: DesignerDockView = {
    isVisible: (id) => visible[id] ?? false,
    setVisible(id, want) {
      calls.push(`${id}:${want}`);
      wanted.set(id, want);
      return new Promise<DockPanelChangeOutcome>((resolve) =>
        pending.push(() => {
          if (wanted.get(id) !== want) return resolve("stale");
          const revealed = want && !visible[id];
          visible[id] = want;
          if (want && leftIds.includes(id)) {
            if (!narrow) state.front = id;
            else if (revealed) state.flyout = id;
          }
          resolve("applied");
        }),
      );
    },
    restoreLayout: () => Promise.resolve("applied"),
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flushSync();
  };
  /** 待っている最も古い依頼を 1 つ通す。 */
  async function releaseOne() {
    pending.shift()?.();
    await settle();
  }
  /** 待っている依頼を順にすべて通す（通した後に出た依頼も）。 */
  async function release() {
    await settle();
    while (pending.length) await releaseOne();
  }
  return { view, dock, state, visible, calls, release, releaseOne };
}

// vitest は node（サーバー側の Svelte）で動くので、$effect は走らない。ここで確かめるのは
// アプリの側から出す依頼の順番と打ち切り（dock の側の変化の取り込みは e2e で確かめる）。
function setup(narrow = false) {
  const fake = delayedDock(narrow);
  const controller = createDesignerDock(fake.dock, {
    mode: "edit",
    previewFullscreen: false,
    narrow,
    narrowShown: narrow,
    inspectorWanted: true,
    inspectorAdoptable: true,
    adoptInspector() {},
  });
  controller.view = fake.view;
  return { ...fake, controller };
}

describe("createDesignerDock", () => {
  it("lets a later show win over a hide-all still waiting for approval", async () => {
    const { controller, visible, calls, release } = setup();
    // 「左パネルを隠す」: Project の非表示が承認待ちの間に「左パネルを表示」。
    void controller.setSidebar(false);
    expect(calls).toEqual(["left:false"]);
    void controller.setSidebar(true);
    // 見た目はまだ出ているが、最新の希望を dock へ伝えて古い依頼を失効させる。
    expect(calls).toEqual(["left:false", "left:true"]);
    await release();

    // 古い一括の依頼は打ち切られ、レイヤー・部品を隠さない。
    expect(calls).toEqual(["left:false", "left:true"]);
    expect(visible[DESIGNER_PANE_IDS.project]).toBe(true);
    expect(visible[DESIGNER_PANE_IDS.layers]).toBe(true);
    expect(visible[DESIGNER_PANE_IDS.parts]).toBe(true);
    expect(controller.showSidebar).toBe(true);
  });

  it("stops an old batch after each await once a later request owns its panes", async () => {
    const { controller, visible, calls, release, releaseOne } = setup();
    void controller.setSidebar(false);
    // Project の非表示が通った後、レイヤーの非表示を待つ間に「左パネルを表示」。
    await releaseOne();
    expect(visible[DESIGNER_PANE_IDS.project]).toBe(false);
    expect(calls).toEqual(["left:false", "layers:false"]);
    void controller.setSidebar(true);
    await release();
    expect(visible[DESIGNER_PANE_IDS.project]).toBe(true);
    expect(visible[DESIGNER_PANE_IDS.layers]).toBe(true);
    expect(visible[DESIGNER_PANE_IDS.parts]).toBe(true);
    expect(calls).not.toContain("parts:false");
    expect(controller.showSidebar).toBe(true);
  });

  /**
   * Project が表の状態で左を隠し、一括の表示の最初の依頼（Project）を待つ間に
   * 「部品」を明示に出す。一括の残り（レイヤー）が表を奪っても、終わったときに
   * 部品を表に戻す（Project を選び直さない・引き出しを閉じない）。
   */
  async function showPartsDuringRevealAll(narrow: boolean) {
    const fake = setup(narrow);
    const { controller, release, releaseOne, calls } = fake;
    void controller.setSidebar(false);
    await release();
    expect(controller.showSidebar).toBe(false);
    calls.length = 0;
    void controller.setSidebar(true);
    expect(calls).toEqual(["left:true"]);
    void controller.showLeftPane("parts");
    expect(calls).toEqual(["left:true", "parts:true"]);
    // Project が通ると一括はレイヤーへ進む（部品は後の依頼が持ち主なので飛ばす）。
    await releaseOne();
    expect(calls).toEqual(["left:true", "parts:true", "layers:true"]);
    await release();
    return fake;
  }

  it("keeps a later explicit tab in front after an old reveal-all (wide)", async () => {
    const { state, visible } = await showPartsDuringRevealAll(false);
    expect(visible[DESIGNER_PANE_IDS.project]).toBe(true);
    expect(visible[DESIGNER_PANE_IDS.layers]).toBe(true);
    expect(state.front).toBe(DESIGNER_PANE_IDS.parts);
  });

  it("keeps a later explicit drawer open after an old reveal-all (narrow)", async () => {
    const { state, visible } = await showPartsDuringRevealAll(true);
    expect(visible[DESIGNER_PANE_IDS.layers]).toBe(true);
    expect(state.flyout).toBe(DESIGNER_PANE_IDS.parts);
  });

  it("still picks the previous front tab when no later choice was made", async () => {
    const { controller, state, release } = setup();
    void controller.setSidebar(false);
    await release();
    void controller.setSidebar(true);
    await release();
    expect(state.front).toBe(DESIGNER_PANE_IDS.project);
  });
});
