import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/bool-colors");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/bool-colors.project.json", "utf8"),
);
// Authored static text is adjusted for the dark definition canvas, not the screenshot.
for (const object of sample.symbols[0].objects)
  if (object.shape.type === "text") object.fill = "#cbd5e1";
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
      name: "colors.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("button", { name: "定義を編集", exact: true }).click();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .locator(`button[data-layer-id="${sample.symbols[0].objects[5].id}"]`)
      .click();
    const form = page.getByRole("form", {
      name: "bool slotの状態別文字色",
      exact: true,
    });
    await expect(form.getByLabel("状態別の文字色を使用")).toHaveValue(
      "enabled",
    );
    await form.scrollIntoViewIfNeeded();
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `bool-colors-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
