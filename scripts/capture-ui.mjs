import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// 起動済みのローカル開発サーバーを使い、実画面を撮影する。
const output = resolve(process.argv[2] ?? "test-results/screenshots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(
    process.env.SCADA_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:5173",
  );
  async function chooseTheme(target) {
    if (process.env.SCADA_SCREENSHOT_THEME) {
      await target
        .getByRole("button", { name: "テーマを変更", exact: true })
        .click();
      const themeLabel = {
        light: "ライト",
        dark: "ダーク",
        system: "OS に合わせる",
      }[process.env.SCADA_SCREENSHOT_THEME];
      if (!themeLabel) throw new Error("Unknown screenshot theme");
      await target
        .getByRole("menu", { name: "テーマ", exact: true })
        .getByRole("menuitem", { name: themeLabel, exact: true })
        .click();
    }
  }
  await chooseTheme(page);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const sidebar = page.getByRole("complementary", { name: "Project と部品" });
  async function capture(name, keepMenu = false, target = page) {
    const panel = target
      .getByRole("complementary", { name: "Project と部品" })
      .getByRole("tabpanel");
    if (!keepMenu && (await panel.count()))
      await panel.evaluate((element) => (element.scrollTop = 0));
    await target.evaluate(() => document.fonts.ready);
    // 通知は通常の閉じるボタンで片付ける。画面の DOM や描画内容は変えない。
    const dismiss = target.locator(".toast-host button.close");
    while (!keepMenu && (await dismiss.count())) await dismiss.first().click();
    const path = join(output, name);
    await target.screenshot({ path, animations: "disabled" });
    console.log(path);
  }
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "ファイル", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "ファイル", exact: true })
    .getByRole("menuitem", { name: "工程図サンプルを開く", exact: true })
    .click();
  await button("編集").click();
  await page.getByRole("tab", { name: "プロジェクト", exact: true }).click();
  const screenList = page.getByRole("navigation", { name: "画面一覧" });
  await screenList
    .getByRole("button", { name: "循環設備（静的サンプル）", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menu", {
      name: "画面：循環設備（静的サンプル） の操作",
      exact: true,
    }),
  ).toBeVisible();
  await capture("scada-screen-context.png", true);
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "共有 Symbol 一覧" })
    .getByRole("button", { name: "共有定義：バルブ", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "共有定義：バルブ の操作", exact: true }),
  ).toBeVisible();
  await capture("scada-symbol-context.png", true);
  await page.keyboard.press("Escape");
  await button("使用先を確認").click();
  await expect(
    page.getByRole("region", { name: "共有定義の使用先", exact: true }),
  ).toBeVisible();
  await capture("scada-symbol-usages.png", true);
  await button("使用先一覧を閉じる").click();
  await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
  await page.getByLabel("グリッド表示", { exact: true }).check();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: /ポンプ/ })
    .first()
    .click();
  await expect(page.locator("[data-resize-handle]")).toHaveCount(8);
  await capture("scada-editor.png");
  await page
    .locator('[data-object-id][data-selected="true"]')
    .first()
    .click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "ポンプ · 10 の操作", exact: true }),
  ).toBeVisible();
  await capture("scada-selection-context.png");
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "ポンプ · 10 の操作", exact: true }),
  ).toBeVisible();
  await capture("scada-layer-context.png");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "部品", exact: true }).click();
  await page
    .getByRole("region", { name: "部品パレット" })
    .getByRole("button", { name: "アイコン一覧", exact: true })
    .click();
  await capture("scada-parts.png");
  await button("ポンプを追加").click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "ポンプ（組込） の操作", exact: true }),
  ).toBeVisible();
  await capture("scada-part-context.png");
  await page.keyboard.press("Escape");
  await button("ポンプ を配置").click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "ポンプ（共有定義） の操作", exact: true }),
  ).toBeVisible();
  await capture("scada-shared-context.png");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "名称一覧", exact: true }).click();
  await capture("scada-parts-names.png");
  await page.getByRole("button", { name: "アイコン一覧", exact: true }).click();
  await button("プロパティを隠す").click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル" }),
  ).toHaveCount(0);
  await capture("scada-wide-canvas.png");
  await button("メニュー").click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name: "プロパティを表示", exact: true })
    .click();
  await button("メニュー").click();
  await page
    .getByRole("menuitem", { name: "補助パネルをすべて隠す", exact: true })
    .click();
  await expect(sidebar).toHaveCount(0);
  await capture("scada-canvas-only.png");
  await button("メニュー").click();
  await page
    .getByRole("menuitem", { name: "補助パネルを元の表示に戻す", exact: true })
    .click();
  await button("参照する Symbol 定義を編集").click();
  await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByRole("img", { name: "ポンプ", exact: true }),
  ).toBeVisible();
  await capture("scada-symbol-editor.png");
  await button("表示プレビュー").click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル" }),
  ).toHaveCount(0);
  await capture("scada-preview.png");
  const lightPage = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await lightPage.goto(
    process.env.SCADA_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:5173",
  );
  await chooseTheme(lightPage);
  await lightPage
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles("examples/process-light.project.json");
  await lightPage.getByRole("button", { name: "編集", exact: true }).click();
  await lightPage.getByRole("tab", { name: "レイヤー", exact: true }).click();
  await lightPage.getByLabel("グリッド表示", { exact: true }).check();
  await lightPage
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await capture("scada-background-editor.png", false, lightPage);
  const leftBorder = lightPage.getByRole("separator", {
    name: "左パネルの幅",
    exact: true,
  });
  const rightBorder = lightPage.getByRole("separator", {
    name: "プロパティの幅",
    exact: true,
  });
  await leftBorder.focus();
  await lightPage.keyboard.press("Shift+ArrowRight");
  await lightPage.keyboard.press("Shift+ArrowRight");
  await rightBorder.focus();
  for (let i = 0; i < 3; i++) await lightPage.keyboard.press("Shift+ArrowLeft");
  await capture("scada-panel-widths.png", false, lightPage);

  await lightPage
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await capture("scada-background-preview.png", false, lightPage);
  const referencePage = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    deviceScaleFactor: 1,
  });
  await referencePage.goto(
    process.env.SCADA_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:5173",
  );
  await chooseTheme(referencePage);
  // 本リポジトリの工程図に未接続の表示タグを割り当てた撮影用データ。実測値は作らない。
  const referenceProject = JSON.parse(
    await readFile("examples/process-light.project.json", "utf8"),
  );
  referenceProject.screens[0].objects.find(
    (object) => object.order === 6,
  ).shape.binding = { externalName: "PLC01.Fast.Tank01.Level" };
  await referencePage
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles({
      name: "process-reference.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(referenceProject)),
    });
  await referencePage
    .getByRole("button", { name: "編集", exact: true })
    .click();
  await referencePage.locator("details.references > summary").click();
  const referenceBorder = referencePage.getByRole("separator", {
    name: "タグ参照パネルの高さ",
    exact: true,
  });
  await referenceBorder.focus();
  await referencePage.keyboard.press("Shift+ArrowUp");
  await referencePage.keyboard.press("Shift+ArrowUp");
  await expect(referenceBorder).toHaveAttribute("aria-valuenow", "304");
  await capture("scada-panel-height.png", false, referencePage);
  await referencePage
    .getByRole("tab", { name: "レイヤー", exact: true })
    .click();
  await referencePage
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 6", exact: true })
    .click();
  await referencePage
    .getByLabel("表示タグ（外部名）", { exact: true })
    .fill("PLC01.Fast.Tank01.Level.Draft");
  const numberX = referencePage.getByLabel("x", { exact: true });
  await numberX.fill(String(Number(await numberX.inputValue()) + 12));
  await numberX.press("Enter");
  await expect(referencePage.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await expect(
    referencePage.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("PLC01.Fast.Tank01.Level.Draft");
  await capture("scada-numeric-properties.png", false, referencePage);
} finally {
  await browser.close();
}
