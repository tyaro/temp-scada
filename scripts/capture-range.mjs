import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/range");
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
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles("examples/process-light.project.json");
    const svg = page.getByRole("img", {
      name: "循環設備（ライト）",
      exact: true,
    });
    await expect(svg).toBeVisible();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    const points = await svg.evaluate((el) => {
      const matrix = el.getScreenCTM();
      return [
        { x: 130, y: 135 },
        { x: 880, y: 470 },
      ].map((p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        return { x: q.x, y: q.y };
      });
    });
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 8 });
    await expect(page.getByTestId("selection-range")).toBeVisible();
    await page.screenshot({
      path: join(output, `range-selecting-${theme}.png`),
      animations: "disabled",
    });
    await page.mouse.up();
    await expect(svg.locator('[data-selected="true"]').first()).toBeVisible();
    await page.screenshot({
      path: join(output, `range-selected-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
