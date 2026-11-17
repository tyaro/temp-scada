import { test, expect, type Page } from "@playwright/test";
import { chooseMenuItem, mainCanvas, selectPanel } from "./helpers/designer";

// Issue #223 WT1a・WT1b: メイン領域の作業タブ（docs/design/editor/main-work-tabs-design.md）。

const workTabs = (page: Page) =>
  page.getByRole("navigation", { name: "作業タブ", exact: true });
const screenTabs = (page: Page) =>
  page.getByRole("navigation", { name: "画面タブ", exact: true });
const settingsTab = (page: Page) =>
  workTabs(page).getByRole("button", { name: "プロジェクト設定", exact: true });
const workScreen = (page: Page) =>
  page.getByRole("region", { name: "プロジェクト設定", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "プロパティパネル", exact: true });
const toolbar = (page: Page) =>
  page.getByRole("toolbar", { name: "共通編集ツールバー", exact: true });

async function edit(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
}
async function openSettings(page: Page) {
  await chooseMenuItem(page, "表示", "プロジェクト設定");
}
async function menuItem(page: Page, group: string, name: string) {
  await page
    .getByRole("menubar", { name: "Designer メニューバー" })
    .getByRole("menuitem", { name: group, exact: true })
    .click();
  return page
    .getByRole("menu", { name: group, exact: true })
    .getByRole("menuitem", { name, exact: true });
}
async function center(page: Page) {
  return viewport(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const point = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
}
const objects = (page: Page) => mainCanvas(page).locator("[data-object-id]");
/** 標準の画面へ Rectangle を足し、足した後の配置数を返す。 */
async function addRectangle(page: Page) {
  const count = await objects(page).count();
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  await expect(objects(page)).toHaveCount(count + 1);
  return count + 1;
}

test("表示メニューから作業タブを開き、画面タブとの切替・閉じるでフォーカスを移す", async ({
  page,
}) => {
  await edit(page);
  const revision = await page
    .locator("main")
    .getAttribute("data-project-revision");
  await openSettings(page);
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  // aria-current="page" は1つだけ（画面タブの選択を外す）。
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(
    workScreen(page).getByRole("heading", { name: "プロジェクト設定" }),
  ).toBeFocused();
  await expect(viewport(page)).toBeHidden();
  await expect(inspector(page)).toHaveCount(0);

  // 画面タブを選ぶとキャンバスへ戻り、作業タブは開いたまま。
  const current = screenTabs(page).getByRole("button").first();
  await current.click();
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(settingsTab(page)).not.toHaveAttribute("aria-current", "page");
  await expect(viewport(page)).toBeVisible();
  await expect(workScreen(page)).toBeHidden();
  await expect(inspector(page)).toBeVisible();

  await settingsTab(page).click();
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  await expect(workScreen(page)).toBeVisible();
  // 開き直しても1枚のまま。
  await openSettings(page);
  await expect(workTabs(page).locator("[data-work-tab]")).toHaveCount(1);

  await workTabs(page)
    .getByRole("button", { name: "プロジェクト設定を閉じる", exact: true })
    .click();
  await expect(workTabs(page)).toHaveCount(0);
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current).toBeFocused();
  await expect(viewport(page)).toBeVisible();
  // W1: 開閉・切替は Project を変えない。
  expect(await page.locator("main").getAttribute("data-project-revision")).toBe(
    revision,
  );
});

test("作業画面の表示中はキャンバス向けの操作を無効にし、Undo で画面が変わると画面タブへ戻る", async ({
  page,
}) => {
  await edit(page);
  const count = await addRectangle(page);
  await openSettings(page);

  // レイヤー・部品は inert にして理由を示す。
  await selectPanel(page, "部品");
  const parts = page.locator("#designer-panel-parts");
  await expect(parts.getByText("画面タブを選ぶと使えます")).toBeVisible();
  await expect(parts.locator(".canvas-only")).toHaveAttribute("inert", "");
  await selectPanel(page, "レイヤー");
  const layers = page.locator("#designer-panel-layers");
  await expect(layers.getByText("画面タブを選ぶと使えます")).toBeVisible();
  await expect(layers.locator(".canvas-only")).toHaveAttribute("inert", "");

  // ツールバーは Undo／Redo だけが使える。
  const enabled = await toolbar(page)
    .locator("[data-edit-action]:not([disabled])")
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("aria-label")),
    );
  expect(enabled.length).toBeGreaterThan(0);
  expect(
    enabled.every((name) => ["元に戻す", "やり直す"].includes(name!)),
  ).toBe(true);
  await expect(
    toolbar(page).getByRole("button", { name: "キャンバスの操作" }),
  ).toBeDisabled();
  await expect(
    toolbar(page).getByRole("button", { name: "拡大", exact: true }),
  ).toBeDisabled();
  await expect(
    toolbar(page).getByRole("button", { name: "選択範囲を表示", exact: true }),
  ).toBeDisabled();

  // メニューの群（編集・挿入・選択範囲を表示・Inspector とタグ参照・ルーラー）。
  for (const [group, name] of [
    ["編集", "選択図形を削除"],
    ["編集", "コピー"],
    ["挿入", "Rectangle を追加"],
    ["ファイル", "画像を配置"],
    ["表示", "選択範囲を表示"],
    ["表示", "プロパティを隠す"],
    ["表示", "プロパティを浮動にする"],
    ["表示", "タグ参照一覧を隠す"],
    ["表示", "ルーラーを隠す"],
  ] as const) {
    await expect(await menuItem(page, group, name)).toBeDisabled();
    await page.keyboard.press("Escape");
  }
  await expect(await menuItem(page, "編集", "元に戻す")).toBeEnabled();
  await page.keyboard.press("Escape");

  // ショートカットもキャンバスへ向かない。
  await workScreen(page)
    .getByRole("heading", { name: "プロジェクト設定", level: 2 })
    .focus();
  for (const key of ["Delete", "Control+a", "Control+d", "Control+g"])
    await page.keyboard.press(key);
  await page.keyboard.press("f");
  await expect(objects(page)).toHaveCount(count);
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");

  // W11: 画面の内容が変わる Undo は画面タブへ戻す。
  await page.keyboard.press("Control+z");
  await expect(objects(page)).toHaveCount(count - 1);
  await expect(viewport(page)).toBeVisible();
  await expect(settingsTab(page)).not.toHaveAttribute("aria-current", "page");
  await expect(screenTabs(page).locator('[aria-current="page"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator("#designer-panel-layers .canvas-only"),
  ).not.toHaveAttribute("inert", "");
});

test("倍率・中心・選択は作業タブとプレビューの往復で戻り、Inspector の表示設定は変わらない", async ({
  page,
}) => {
  await edit(page);
  await addRectangle(page);
  await toolbar(page)
    .getByRole("button", { name: "拡大", exact: true })
    .click();
  await toolbar(page)
    .getByRole("button", { name: "拡大", exact: true })
    .click();
  await viewport(page).evaluate((el) => {
    el.scrollLeft += 60;
    el.scrollTop += 40;
  });
  const zoom = await toolbar(page)
    .getByLabel("表示倍率", { exact: true })
    .inputValue();
  const before = await center(page);

  await openSettings(page);
  await expect(inspector(page)).toHaveCount(0);
  // Inspector は隠すだけで、表示の設定（配置の保存が使う値）は変えない。
  await expect(await menuItem(page, "表示", "プロパティを隠す")).toBeDisabled();
  await page.keyboard.press("Escape");

  // プレビューへ移ると作業タブは隠れ、編集へ戻ると選択ごと戻る。
  await chooseMenuItem(page, "表示", "表示プレビュー");
  await expect(workTabs(page)).toHaveCount(0);
  await expect(viewport(page)).toBeVisible();
  await chooseMenuItem(page, "表示", "編集モード");
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  await expect(workScreen(page)).toBeVisible();
  await expect(viewport(page)).toBeHidden();

  await screenTabs(page).getByRole("button").first().click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByLabel("幅", { exact: true })).toBeVisible();
  await expect(
    toolbar(page).getByLabel("表示倍率", { exact: true }),
  ).toHaveValue(zoom);
  await expect
    .poll(async () => {
      const after = await center(page);
      return Math.hypot(after.x - before.x, after.y - before.y);
    })
    .toBeLessThan(2);
});

test("Symbol 定義の編集中は作業タブを隠し、戻ると並びだけを戻す", async ({
  page,
}) => {
  await edit(page);
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加", exact: true }).click();
  await openSettings(page);
  // W10: 定義の編集へは画面タブを選んでから入る。
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "定義を編集", exact: true }).click();
  await expect(
    page.getByRole("note").filter({ hasText: "Symbol 定義を編集中" }),
  ).toBeVisible();
  await expect(workTabs(page)).toHaveCount(0);
  await expect(
    await menuItem(
      page,
      "表示",
      "プロジェクト設定（Symbol 定義の編集中は使えません）",
    ),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  // W8: 左の「設定」の行と「プロジェクト名を変更」も理由を示して無効にする。
  await expect(
    page.getByRole("button", { name: "プロジェクト設定", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "記録希望設定", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Symbol 定義の編集中は使えません。", { exact: true }),
  ).toBeVisible();
  await expect(
    await menuItem(
      page,
      "ファイル",
      "プロジェクト名を変更（Symbol 定義の編集中は使えません）",
    ),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
  await expect(settingsTab(page)).toBeVisible();
  await expect(settingsTab(page)).not.toHaveAttribute("aria-current", "page");
  await expect(screenTabs(page).locator('[aria-current="page"]')).toHaveCount(
    1,
  );
  await expect(viewport(page)).toBeVisible();
});

test("Inspector の未適用入力は作業タブを開くと確定し、不正なら切替を拒否して欄へ戻す", async ({
  page,
}) => {
  await edit(page);
  await page.getByLabel("画面名", { exact: true }).fill("確定した画面名");
  await openSettings(page);
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  await expect(screenTabs(page)).toContainText("確定した画面名");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await screenTabs(page).getByRole("button").first().click();
  await workTabs(page)
    .getByRole("button", { name: "プロジェクト設定を閉じる", exact: true })
    .click();
  const width = page.getByLabel("画面の幅", { exact: true });
  await width.fill("0");
  await openSettings(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(workTabs(page)).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
  await expect(width).toBeFocused();
  await expect(width).toHaveValue("0");
  // reveal は繰り返さない: 落ち着いた後も切替は起きず、フォーカスと入力が残る。
  await page.waitForTimeout(300);
  await expect(workTabs(page)).toHaveCount(0);
  await expect(width).toBeFocused();
  await expect(await menuItem(page, "表示", "プロジェクト設定")).toBeEnabled();
  await page.keyboard.press("Escape");

  await width.fill("1280");
  await openSettings(page);
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
});

test("作業画面の表示中に左の Symbol から配置すると、画面タブへ戻って表示中心に置く", async ({
  page,
}) => {
  await edit(page);
  // 共有定義を1つ作る（標準の Project には Symbol がない）。
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加", exact: true }).click();
  await page.keyboard.press("Escape");
  await toolbar(page)
    .getByRole("button", { name: "拡大", exact: true })
    .click();
  await viewport(page).evaluate((el) => {
    el.scrollLeft += 80;
    el.scrollTop += 50;
  });
  const before = await center(page);
  const placed = mainCanvas(page).locator("[data-symbol-id]");
  const count = await placed.count();

  await openSettings(page);
  await expect(viewport(page)).toBeHidden();
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("navigation", { name: "共有 Symbol 一覧" })
    .getByRole("button", { name: /^共有定義：/ })
    .first()
    .click();
  await page.getByRole("button", { name: "画面に配置", exact: true }).click();

  // W10: キャンバスが見え、作業タブは残ったまま画面タブが選ばれる。
  await expect(viewport(page)).toBeVisible();
  await expect(settingsTab(page)).not.toHaveAttribute("aria-current", "page");
  await expect(placed).toHaveCount(count + 1);
  // 隠れたキャンバスではなく、戻した表示の中心へ置く。
  const middle = await placed.nth(count).evaluate((el) => {
    const svg = (el as SVGGraphicsElement).ownerSVGElement!;
    const box = el.getBoundingClientRect();
    const point = new DOMPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    ).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
  expect(Math.hypot(middle.x - before.x, middle.y - before.y)).toBeLessThan(24);
});

test("作業画面の表示中に左の「タグ参照一覧を開く」を押すと、画面タブへ戻って一覧を出す", async ({
  page,
}) => {
  await edit(page);
  await page
    .getByLabel("Project を開く", { exact: true })
    .setInputFiles("examples/tag-binding.project.json");
  await openSettings(page);
  await expect(workScreen(page)).toBeVisible();
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("button", { name: "タグ参照一覧を開く", exact: true })
    .click();
  await expect(viewport(page)).toBeVisible();
  await expect(settingsTab(page)).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "タグ参照パネル", exact: true }),
  ).toBeVisible();
});

test("左の「設定」から開いた作業画面で設定し、未適用の入力は離れるときに確定する（WT1b）", async ({
  page,
}) => {
  await edit(page);
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("button", { name: "プロジェクト設定", exact: true })
    .click();
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  await expect(
    workScreen(page).getByRole("heading", { name: "プロジェクト設定" }),
  ).toBeFocused();
  const name = workScreen(page).getByLabel("プロジェクト名", { exact: true });
  await name.fill("作業タブで変えた名前");
  // 画面タブへ切り替えると確認なしで確定する（W2）。
  await screenTabs(page).getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("作業タブで変えた名前");
  await expect(workScreen(page)).toBeHidden();
  // W3: 非選択の作業画面は破棄せず隠すだけ。
  await expect(
    page.locator('[data-work-screen="project-settings"] input[name="name"]'),
  ).toHaveCount(1);
  // メニュー「プロジェクト名を変更」は作業タブを選んでプロジェクト名へフォーカスする（W12）。
  await chooseMenuItem(page, "ファイル", "プロジェクト名を変更");
  await expect(settingsTab(page)).toHaveAttribute("aria-current", "page");
  await expect(name).toBeFocused();
  // 記録希望設定は作業画面からも既存の Modal を開く。
  await workScreen(page)
    .getByRole("button", { name: "記録希望設定を開く", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "記録希望設定", exact: true }),
  ).toBeVisible();
});

for (const width of [960, 700])
  test(`最小幅 ${width}px でも作業タブと×、作業画面の最後の操作に手が届く（WT1b）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await openSettings(page);
    // 700px 以下は全体が1列でページごと縦に流れるので、スクロールで届けばよい。
    await settingsTab(page).scrollIntoViewIfNeeded();
    await expect(settingsTab(page)).toBeInViewport();
    const close = workTabs(page).getByRole("button", {
      name: "プロジェクト設定を閉じる",
      exact: true,
    });
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeInViewport();
    const last = workScreen(page).getByRole("button", {
      name: "記録希望設定を開く",
      exact: true,
    });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(
      page.getByRole("dialog", { name: "記録希望設定", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await close.click();
    await expect(workTabs(page)).toHaveCount(0);
  });
