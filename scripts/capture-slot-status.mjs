import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/slot-status");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/bool-colors.project.json", "utf8"),
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    await page.goto(process.env.SCADA_CAPTURE_URL ?? "http://127.0.0.1:5173");
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
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "status.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    const details = page.locator('details[aria-label^="読取状態："]');
    await expect(details.locator("summary")).toContainText("表示参照 6件");
    await details.locator("summary").click();
    await expect(details.locator("[data-slot-status-key]")).toHaveCount(6);
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `slot-status-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
