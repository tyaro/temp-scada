import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/tag-picker");
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
    await page
      .getByRole("button", { name: "テーマを変更", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: theme === "light" ? "ライト" : "ダーク",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page
      .getByLabel("Project を開く", { exact: true })
      .setInputFiles("examples/process-light.project.json");
    await expect(
      page.getByRole("img", { name: "循環設備（ライト）", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "text · 6", exact: true })
      .click();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.getByRole("button", { name: "タグを選択", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "タグを選択",
      exact: true,
    });
    await picker.getByRole("treeitem", { name: /原水タンク 液位/ }).click();
    await expect(
      picker.getByRole("region", { name: "タグの詳細" }),
    ).toContainText("Demo.Water.Tank01.Level");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `tag-picker-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
