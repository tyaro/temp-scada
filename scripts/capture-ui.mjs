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
      .getByLabel("テーマ", { exact: true })
      .selectOption(process.env.SCADA_SCREENSHOT_THEME);
  }
  const button = (name) => page.getByRole("button", { name, exact: true });
  const sidebar = page.getByRole("complementary", { name: "Project と部品" });
  async function capture(name) {
    const panel = sidebar.getByRole("tabpanel");
    if (await panel.count())
      await panel.evaluate((element) => (element.scrollTop = 0));
    await page.evaluate(() => document.fonts.ready);
    // 通知は通常の閉じるボタンで片付ける。画面の DOM や描画内容は変えない。
    const dismiss = page.locator(".toast-host button.close");
    while (await dismiss.count()) await dismiss.first().click();
    const path = join(output, name);
    await page.screenshot({ path, animations: "disabled" });
    console.log(path);
  }
  await button("工程図サンプルを開く").click();
  await button("編集").click();
  await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
  await page.getByLabel("グリッド表示", { exact: true }).check();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: /ポンプ/ })
    .first()
    .click();
  await expect(page.locator("[data-resize-handle]")).toHaveCount(8);
  await capture("scada-editor.png");
  await page.getByRole("tab", { name: "部品", exact: true }).click();
  await page
    .getByRole("region", { name: "部品パレット" })
    .getByRole("button", { name: "アイコン一覧", exact: true })
    .click();
  await capture("scada-parts.png");
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
