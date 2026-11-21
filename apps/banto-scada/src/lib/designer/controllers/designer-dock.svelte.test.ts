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
function delayedDock() {
  const visible = $state<Record<string, boolean>>(
    Object.fromEntries(
      Object.values(DESIGNER_PANE_IDS).map((id) => [id, true]),
    ),
  );
  const wanted = new Map<string, boolean>();
  const pending: (() => void)[] = [];
  const calls: string[] = [];
  const view: DesignerDockView = {
    isVisible: (id) => visible[id] ?? false,
    setVisible(id, want) {
      calls.push(`${id}:${want}`);
      wanted.set(id, want);
      return new Promise<DockPanelChangeOutcome>((resolve) =>
        pending.push(() => {
          if (wanted.get(id) !== want) return resolve("stale");
          visible[id] = want;
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
  return { view, visible, calls, release, releaseOne };
}

const dockState = {
  layout: { docked: null, floating: [], autoHidden: [] },
  isAutoHidden: () => false,
  flyoutPanel: null,
  openFlyout() {},
  closeFlyout() {},
} as unknown as DockState;

// vitest は node（サーバー側の Svelte）で動くので、$effect は走らない。ここで確かめるのは
// アプリの側から出す依頼の順番と打ち切り（dock の側の変化の取り込みは e2e で確かめる）。
function setup() {
  const fake = delayedDock();
  const controller = createDesignerDock(dockState, {
    mode: "edit",
    previewFullscreen: false,
    narrow: false,
    narrowShown: false,
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
});
