import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/symbol-read-slots");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/symbol-slots.project.json", "utf8"),
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
      name: "symbol-slots.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.getByTestId("project-status")).toHaveText(
      "Project を読み込みました。",
    );
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .locator(`button[data-layer-id="${project.screens[0].objects[2].id}"]`)
      .click();
    await page
      .getByRole("combobox", { name: "関連付ける機器", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.locator('.sheet > svg [data-tag-state="disconnected"]'),
    ).toHaveCount(1);
    for (const close of await page
      .locator(".toast-host .toast button.close")
      .all())
      await close.click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `symbol-read-slots-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
