import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
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
  if (process.env.SCADA_SCREENSHOT_THEME) {
    await page
      .getByRole("button", { name: "テーマを変更", exact: true })
      .click();
    const themeLabel = {
      light: "ライト",
      dark: "ダーク",
      system: "OS に合わせる",
    }[process.env.SCADA_SCREENSHOT_THEME];
    if (!themeLabel) throw new Error("Unknown screenshot theme");
    await page
      .getByRole("menu", { name: "テーマ", exact: true })
      .getByRole("menuitem", { name: themeLabel, exact: true })
      .click();
  }
  const button = (name) => page.getByRole("button", { name, exact: true });
  const sidebar = page.getByRole("complementary", { name: "Project と部品" });
  async function capture(name, keepMenu = false) {
    const panel = sidebar.getByRole("tabpanel");
    if (!keepMenu && (await panel.count()))
      await panel.evaluate((element) => (element.scrollTop = 0));
    await page.evaluate(() => document.fonts.ready);
    // 通知は通常の閉じるボタンで片付ける。画面の DOM や描画内容は変えない。
    const dismiss = page.locator(".toast-host button.close");
    while (!keepMenu && (await dismiss.count())) await dismiss.first().click();
    const path = join(output, name);
    await page.screenshot({ path, animations: "disabled" });
    console.log(path);
  }
  await button("工程図サンプルを開く").click();
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
} finally {
  await browser.close();
}
