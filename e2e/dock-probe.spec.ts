import { test, expect, type Page } from "@playwright/test";

// Issue #331 D1: Banto の ThreePaneDock の persistent のパネルに実フォーム（図形の文字）を入れ、
// 組み替えても同じ DOM・未適用の入力（確定前の数値の文字列を含む）・dirty が残るか、
// IME 変換中の組み替えが変換の終わりまで待つかを確かめる。製品画面は使わない（/probes/dock.html）。

const form = (page: Page) =>
  page.locator('form[data-editor-form="shape-label"]');
const text = (page: Page) =>
  page.getByRole("textbox", { name: "図形の文言", exact: true });
const size = (page: Page) =>
  page.getByRole("textbox", { name: "図形の文字サイズ", exact: true });
const draftText = "ポンプ\n2号機（点検中）";
const draftSize = "12.";

type Placement = { placement: string; visible: boolean; autoHidden?: true };

async function open(page: Page) {
  await page.setViewportSize({ width: 1536, height: 864 });
  await page.goto("/probes/dock.html");
  await expect(form(page)).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__probeForm = document.querySelector(
      'form[data-editor-form="shape-label"]',
    );
  });
}

/** ThreePaneDock のメソッドを呼び、結果（outcome）を返す。 */
async function call(page: Page, method: string, ...args: unknown[]) {
  return page.evaluate(
    ([name, rest]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pane = (window as any).__dockProbe.threePane;
      return pane[name as string](...(rest as unknown[]));
    },
    [method, args] as const,
  );
}

async function placement(page: Page, id: string): Promise<Placement> {
  return page.evaluate((panelId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (window as any).__dockProbe.dock.panels.find(
      (panel: { id: string }) => panel.id === panelId,
    );
    return {
      placement: row.placement,
      visible: row.visible,
      autoHidden: row.autoHidden,
    };
  }, id);
}

/** 同じ form 要素のまま、未適用の値・dirty が残り、確定（submit）が走っていないこと。 */
async function expectKept(page: Page, focused?: string) {
  const state = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const current = document.querySelector(
      'form[data-editor-form="shape-label"]',
    );
    return {
      same: current === w.__probeForm && !!current?.isConnected,
      dirty: w.__dockProbe.drafts.count,
      // 入力を終えた時点（typeDrafts）からの確定の回数。
      submits: w.__dockProbe.submits - (w.__baseSubmits ?? 0),
      errors: w.__dockProbe.errors.length,
      active: document.activeElement?.getAttribute("aria-label") ?? null,
    };
  });
  expect(state).toMatchObject({ same: true, dirty: 1, submits: 0, errors: 0 });
  if (focused) expect(state.active).toBe(focused);
  // 裏のタブ・隠した pane の中でも値を見るため、role ではなく name で引く。
  await expect(form(page).locator('[name="labelText"]')).toHaveValue(draftText);
  await expect(form(page).locator('[name="labelFontSize"]')).toHaveValue(
    draftSize,
  );
}

/**
 * 文言（Ctrl＋Enter か適用ボタンでだけ確定する）に改行つきの未適用の文字を入れ、フォーカスを置く。
 * 数値の欄の文字列は先に入れる。数値の欄は離れると（blur）確定する製品の仕様なので、
 * 文言の欄へ移るときに 1 回確定が走る（実証のページの submit は何も適用しない）。それを基準にする。
 */
async function typeDrafts(page: Page) {
  await size(page).fill(draftSize);
  await text(page).click();
  await text(page).fill(draftText);
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__baseSubmits = w.__dockProbe.submits;
  });
  await expectKept(page, "図形の文言");
}

test("組み替えても同じフォームと未適用の入力が残る", async ({ page }) => {
  await open(page);
  await typeDrafts(page);

  // 浮かせる → 戻す（docked と浮動の層をまたぐ）。フォーカスも戻る。
  expect(await call(page, "float", "right")).toBe("applied");
  expect(await placement(page, "right")).toMatchObject({
    placement: "floating",
  });
  await expectKept(page, "図形の文言");
  expect(await call(page, "dockBack", "right")).toBe("applied");
  expect(await placement(page, "right")).toMatchObject({
    placement: "docked",
    visible: true,
  });
  await expectKept(page, "図形の文言");

  // 左とタブにまとめ、裏のタブにしてから表へ戻す。
  expect(await call(page, "move", "right", { tabWith: "left" })).toBe(
    "applied",
  );
  await expectKept(page, "図形の文言");
  await page.getByRole("tab", { name: "プロジェクト", exact: true }).click();
  await expect(form(page)).toBeHidden();
  await expectKept(page);
  await page.getByRole("tab", { name: "プロパティ", exact: true }).click();
  await expect(form(page)).toBeVisible();
  await expectKept(page);

  // 既定の配置に戻す（replaceLayout を通る）。
  expect(await call(page, "resetLayout")).toBe("applied");
  await expectKept(page);

  // 隠す → 表示。
  expect(await call(page, "setVisible", "right", false)).toBe("applied");
  await expect(form(page)).toBeHidden();
  await expectKept(page);
  expect(await call(page, "setVisible", "right", true)).toBe("applied");
  await expect(form(page)).toBeVisible();
  await expectKept(page);

  // 狭い表示: 右は端の帯へ。「表示」メニューの項目で引き出す。幅が戻れば元の配置。
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__dockProbe.setNarrow(true),
  );
  await expect
    .poll(() => placement(page, "right"))
    .toMatchObject({ autoHidden: true });
  await expectKept(page);
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pane = (window as any).__dockProbe.threePane;
    pane
      .viewMenuItems({ resetLayout: "既定に戻す" })
      .find((item: { id: string }) => item.id === "panel:right")
      .onSelect();
  });
  await expect(form(page)).toBeVisible();
  await expectKept(page);
  await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__dockProbe.setNarrow(false),
  );
  await expect
    .poll(() => placement(page, "right"))
    .toEqual({ placement: "docked", visible: true, autoHidden: undefined });
  await expect(form(page)).toBeVisible();
  await expectKept(page);

  // 右パネルについて聞かれた変更は、どれも作り直さない（remount: false）。
  const remounts = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__dockProbe.changes
      .filter(
        (change: { panelId?: string; from?: string }) =>
          change.panelId === "right" || change.from === "right",
      )
      .map((change: { remount?: boolean }) => change.remount),
  );
  expect(remounts.length).toBeGreaterThan(0);
  expect(remounts.every((remount: boolean) => remount === false)).toBe(true);

  // 組み替えの後もフォームは働く: 適用で確定（submit）が 1 回走る。
  await page.getByRole("button", { name: "文字を適用", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () =>
          (window as any).__dockProbe.submits - (window as any).__baseSubmits,
      ),
    )
    .toBe(1);
});

test("タイトルバーのドラッグで浮かせても入力が残る", async ({ page }) => {
  await open(page);
  await typeDrafts(page);
  const bar = (await page
    .getByRole("toolbar", { name: "プロパティ", exact: true })
    .boundingBox())!;
  const canvas = (await page.locator("[data-probe-canvas]").boundingBox())!;
  await page.mouse.move(bar.x + 40, bar.y + bar.height / 2);
  await page.mouse.down();
  // 十字のボタン（キャンバスの真ん中）を避けた場所で離すと浮動になる。
  await page.mouse.move(canvas.x + 120, canvas.y + 120, { steps: 12 });
  await page.mouse.move(canvas.x + 140, canvas.y + 140, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => placement(page, "right"))
    .toMatchObject({ placement: "floating", visible: true });
  // ポインタで掴んだのでフォーカスは入力欄から外れるが、値と dirty は残る。
  await expectKept(page);
});

test("IME 変換中の組み替えは変換の確定まで待ち、変換中の文字も消えない", async ({
  page,
}) => {
  await open(page);
  await text(page).click();
  await text(page).fill("ポンプ");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "てんけん",
    selectionStart: 4,
    selectionEnd: 4,
  });
  await expect(text(page)).toHaveValue("ポンプてんけん");
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__floatResult = w.__dockProbe.threePane.float("right");
  });
  // 変換中は保留: 配置は変わらず、変換中の文字も残る。
  await page.waitForTimeout(300);
  expect(await placement(page, "right")).toMatchObject({
    placement: "docked",
  });
  await expect(text(page)).toHaveValue("ポンプてんけん");
  // 変換を確定すると、保留していた浮動化が適用される。
  await cdp.send("Input.insertText", { text: "点検" });
  expect(
    await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__floatResult,
    ),
  ).toBe("applied");
  expect(await placement(page, "right")).toMatchObject({
    placement: "floating",
  });
  const state = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return {
      same:
        document.querySelector('form[data-editor-form="shape-label"]') ===
        w.__probeForm,
      dirty: w.__dockProbe.drafts.count,
      active: document.activeElement?.getAttribute("aria-label") ?? null,
    };
  });
  expect(state).toEqual({ same: true, dirty: 1, active: "図形の文言" });
  await expect(text(page)).toHaveValue("ポンプ点検");
});

// 既知の不具合（D1 で見つけた）: 据え置きのパネルを組み替えると、Svelte が古い受け皿を消すときに
// 中のフォーカス中の欄が一度文書から外れ、blur が出る（dock はその後にフォーカスを戻す）。
// SCADA の数値の欄は blur で確定するので、確定前の文字列が submit される。
// Banto の persistent が Element.moveBefore で移すようになれば合格する（予期しない合格で知らせる）。
test("数値の欄にフォーカスがあるまま浮かせても確定しない", async ({ page }) => {
  test.fail();
  await open(page);
  await text(page).fill(draftText);
  await size(page).click();
  await size(page).fill(draftSize);
  expect(await call(page, "float", "right")).toBe("applied");
  await expectKept(page, "図形の文字サイズ");
});
