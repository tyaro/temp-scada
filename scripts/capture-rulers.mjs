import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/rulers");
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
    await expect(page.getByTestId("ruler-x")).toBeVisible();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "ポンプ · 10", exact: true })
      .click();
    await expect(
      page.locator('.sheet > svg [data-selected="true"]'),
    ).toHaveCount(1);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.screenshot({
      path: join(output, `rulers-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
