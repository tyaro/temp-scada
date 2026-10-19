import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/preview-popups");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/embedded-screen.project.json", "utf8"),
);
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
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "popup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    for (const source of [project.screens[0], project.screens[1]]) {
      await page
        .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "画面を小窓で表示確認",
        exact: true,
      });
      await dialog.locator(`input[value="${source.id}"]`).check();
      await dialog
        .getByRole("button", { name: "小窓を表示", exact: true })
        .click();
      await expect(
        page.locator(`[data-preview-popup="${source.id}"] [data-popup-move]`),
      ).toBeFocused();
    }
    const window = page.locator(
      `[data-preview-popup="${project.screens[1].id}"]`,
    );
    const title = window.locator("[data-popup-move]");
    for (let i = 0; i < 16; i++) await title.press("Shift+ArrowRight");
    for (let i = 0; i < 3; i++) await title.press("Shift+ArrowDown");
    const resize = window.locator("[data-popup-resize]");
    await resize.focus();
    for (let i = 0; i < 4; i++) await resize.press("Shift+ArrowLeft");
    for (let i = 0; i < 2; i++) await resize.press("Shift+ArrowUp");
    await title.focus();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    await page.screenshot({
      path: join(output, `preview-popups-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
