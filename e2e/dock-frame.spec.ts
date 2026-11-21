import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/shape-label.project.json" with { type: "json" };
import { chooseMenuItem, mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// #331 D2: Designer の枠（ThreePaneDock）。左 = Project・レイヤー・部品の dock のタブ、
// 中央 = 画面プレビュー、右 = Inspector。浮動は D4 まで止める。blur で確定する欄は、
// dock の組み替えによる blur では確定しない（moveBefore の無い WebView2 向け）。
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const tab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });
const inspector = (page: Page) => page.locator("#designer-inspector-panel");

async function start(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await button(page, "編集").click();
}

test("the left panes are dock tabs that switch, hide and come back; floating is paused", async ({
  page,
}) => {
  await start(page);
  await expect(tab(page, "プロジェクト")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#designer-project-panel")).toBeVisible();
  await selectPanel(page, "レイヤー");
  await expect(page.locator("#designer-layers-panel")).toBeVisible();
  await expect(page.locator("#designer-project-panel")).toBeHidden();
  await selectPanel(page, "部品");
  await expect(page.locator("#designer-parts-panel")).toBeVisible();
  await expect(inspector(page)).toBeVisible();

  // ✕ はそのパネルだけを隠す（中身は据え置き）。「左パネルを表示」で戻る。
  await page.getByRole("searchbox", { name: "部品を検索" }).fill("rect");
  await button(page, "部品を隠す").click();
  await expect(tab(page, "部品")).toHaveCount(0);
  await chooseMenuItem(page, "表示", "左パネルを隠す");
  await expect(tab(page, "プロジェクト")).toHaveCount(0);
  await chooseMenuItem(page, "表示", "左パネルを表示");
  await expect(tab(page, "プロジェクト")).toBeVisible();
  await selectPanel(page, "部品");
  await expect(page.getByRole("searchbox", { name: "部品を検索" })).toHaveValue(
    "rect",
  );

  // Inspector の ✕ は「プロパティを隠す」。メニューから戻す。
  await button(page, "プロパティを隠す").click();
  await expect(inspector(page)).toBeHidden();
  await chooseMenuItem(page, "表示", "プロパティを表示");
  await expect(inspector(page)).toBeVisible();

  // 浮動の入口は出さない（自前の浮動も dock の浮動・別ウィンドウも）。
  await expect(
    page.getByRole("button", { name: /別ウィンドウで開く$/ }),
  ).toHaveCount(0);
  await page
    .getByRole("menubar", { name: "Designer メニューバー" })
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: /浮動/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("preview shows only the Project pane and full screen preview hides it", async ({
  page,
}) => {
  await start(page);
  await button(page, "表示プレビュー").click();
  await expect(page.locator("#designer-project-panel")).toBeVisible();
  await expect(tab(page, "レイヤー")).toHaveCount(0);
  await expect(inspector(page)).toHaveCount(0);
  await button(page, "編集").click();
  await expect(tab(page, "プロジェクト")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(inspector(page)).toBeVisible();
});

test("the narrow display puts the side panes in edge bands", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="left"]')).toBeVisible();
  await expect(page.locator('[data-dock-band-tab="right"]')).toBeVisible();
  // レイヤー・部品も左の帯に並ぶ（dock の狭い表示は左右だけを帯に置く）。
  await expect(page.locator('[data-dock-band-tab="layers"]')).toBeVisible();
  await expect(page.locator('[data-dock-band-tab="parts"]')).toBeVisible();
  await selectPanel(page, "部品");
  await expect(page.locator("#designer-parts-panel")).toBeVisible();
  await page.locator('[data-dock-band-tab="right"]').click();
  await expect(inspector(page)).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(tab(page, "レイヤー")).toBeVisible();
  await expect(inspector(page)).toBeVisible();
});

test("a pane closed with ✕ in the narrow display stays hidden after going wide", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="layers"]')).toBeVisible();
  await selectPanel(page, "レイヤー");
  await button(page, "レイヤーを隠す").click();
  await expect(page.locator('[data-dock-band-tab="layers"]')).toHaveCount(0);
  // 広い表示へ戻すと dock は控えた配置へ戻すが、✕ の希望が勝つ。
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(tab(page, "プロジェクト")).toBeVisible();
  await expect(tab(page, "部品")).toBeVisible();
  await expect(tab(page, "レイヤー")).toHaveCount(0);
  await expect(page.locator("#designer-layers-panel")).toBeHidden();

  // 狭い表示で残りの 2 つも ✕ で閉じると、アプリの「左パネル」も非表示になる。
  await page.setViewportSize({ width: 900, height: 800 });
  await selectPanel(page, "部品");
  await button(page, "部品を隠す").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "プロジェクトを隠す").click();
  await expect(page.locator('[data-dock-band-tab="left"]')).toHaveCount(0);
  await chooseMenuItem(page, "表示", "左パネルを表示");
  await expect(page.locator('[data-dock-band-tab="left"]')).toBeVisible();
});

test("the Inspector closed with ✕ in the narrow display stays hidden after going wide", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator('[data-dock-band-tab="right"]').click();
  await expect(inspector(page)).toBeVisible();
  await button(page, "プロパティを隠す").click();
  await expect(page.locator('[data-dock-band-tab="right"]')).toHaveCount(0);
  // 広い表示へ戻すと dock は控えた配置（Inspector あり）へ戻すが、✕ の希望が勝つ。
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(tab(page, "プロジェクト")).toBeVisible();
  await expect(inspector(page)).toBeHidden();
  await chooseMenuItem(page, "表示", "プロパティを表示");
  await expect(inspector(page)).toBeVisible();
});

test("opening the parts panel from favorites in the narrow display opens its drawer", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="parts"]')).toBeVisible();
  // 一度引き出して閉じ、部品が帯にあって見えている（dock の isVisible）状態にする。
  await page.locator('[data-dock-band-tab="parts"]').click();
  await expect(page.locator("#designer-parts-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#designer-parts-panel")).toBeHidden();
  await page
    .getByRole("button", { name: "部品パネルを開く", exact: true })
    .click();
  await expect(page.locator("#designer-parts-panel")).toBeVisible();
});

test("renaming a screen in the narrow display opens the Inspector drawer", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="right"]')).toBeVisible();
  await expect(inspector(page)).toBeHidden();
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前変更", exact: true }).click();
  const screenName = page.getByRole("textbox", { name: "画面名", exact: true });
  await expect(screenName).toBeVisible();
  await expect(screenName).toBeFocused();
});

test("renaming a shape with F2 in the narrow display opens the Inspector drawer", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="right"]')).toBeVisible();
  await expect(inspector(page)).toBeHidden();
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await canvas.focus();
  await page.keyboard.press("F2");
  const name = page.getByLabel("配置名", { exact: true });
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
});

// 未保存のフォームへ戻る（離れたら確定で不正な値に止まる）とき、狭い表示で端の帯にある
// だけの Inspector は引き出しを開き、開き終わってから検証・フォーカスする。
test("leaving an invalid Inspector draft in the narrow display opens its drawer and focuses it", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  const width = page.getByLabel("幅", { exact: true });
  await width.fill("0");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-dock-band-tab="right"]')).toBeVisible();
  await expect(inspector(page)).toBeHidden();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(width).toBeVisible();
  await expect(width).toHaveValue("0");
  await expect(width).toBeFocused();
});

// moveBefore の無い環境（古い WebView2）では、組み替えでフォーカス中の欄に blur が出る。
// Inspector の数値の欄にフォーカスを置いたまま、Inspector のタイトルバーをドラッグして
// 左の外周へドッキングし直す（タイトルバーの pointerdown はフォーカスを動かさない）。
// 組み替えの blur では確定せず、後で Tab で離れたときに 1 回だけ確定する。
// ShapeLabel の欄は e2e/dock-probe.spec.ts で同じことを確かめる。
for (const withMoveBefore of [false, true])
  test(`a rearrangement blur does not commit the Inspector number, a later Tab commits once (moveBefore ${withMoveBefore ? "present" : "absent"})`, async ({
    page,
  }) => {
    if (!withMoveBefore)
      await page.addInitScript(() => {
        delete (Element.prototype as { moveBefore?: unknown }).moveBefore;
      });
    await start(page);
    await openProject(page, {
      name: "shape-label.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    const object = sample.screens[0].objects.find(
      (item) => item.name === "矩形の文字",
    )!;
    await mainCanvas(page)
      .locator(`[data-object-id="${object.id}"]`)
      .first()
      .click();
    const undo = button(page, "元に戻す");
    await expect(undo).toBeDisabled();
    const field = page.getByLabel("X", { exact: true });
    const before = await field.inputValue();
    await field.fill("77");
    await expect(field).toBeFocused();

    const title = page.getByRole("toolbar", {
      name: "プロパティ",
      exact: true,
    });
    const box = (await title.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 10, box.y + 60, { steps: 6 });
    const edge = page.locator('[data-dock-edge="left"]');
    await expect(edge).toBeAttached();
    const target = (await edge.boundingBox())!;
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    // Inspector は左の外周へ移った（同じ欄のまま、確定されず、フォーカスも戻る）。
    await expect
      .poll(async () => (await inspector(page).boundingBox())!.x)
      .toBeLessThan(box.x - 200);
    await expect(field).toHaveValue("77");
    await expect(field).toBeFocused();
    await expect(undo).toBeDisabled();

    // Tab で離れたときは今までどおり 1 回確定する。
    await page.keyboard.press("Tab");
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(field).toHaveValue(before);
  });
