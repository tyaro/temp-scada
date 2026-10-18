import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// 起動済みの開発サーバーから実画面を撮影する。
const output = resolve(process.argv[2] ?? "test-results/sidebar-tree");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    await page.goto("http://127.0.0.1:5173");
    const button = (name) => page.getByRole("button", { name, exact: true });
    await button("テーマを変更").click();
    await page
      .getByRole("menuitem", {
        name: theme === "light" ? "ライト" : "ダーク",
        exact: true,
      })
      .click();
    await button("編集").click();
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles("examples/process-light.project.json");
    await expect(
      page
        .getByRole("navigation", { name: "画面一覧" })
        .getByRole("button", { name: "循環設備（ライト）", exact: true }),
    ).toBeVisible();
    for (const label of ["シンボル", "プロジェクト設定"]) {
      const summary = page
        .locator("details.tree-section > summary")
        .filter({ hasText: label });
      await summary.click();
    }
    await page.evaluate(() => document.fonts.ready);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.screenshot({
      path: join(output, `project-tree-${theme}.png`),
      animations: "disabled",
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "レイヤーを検索" })
      .fill("ポンプ");
    const row = page
      .getByRole("navigation", { name: "図形一覧" })
      .locator("[data-layer-id]")
      .first();
    await row.click();
    await page.screenshot({
      path: join(output, `layer-tree-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
