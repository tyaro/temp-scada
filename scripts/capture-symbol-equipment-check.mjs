import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(
  process.argv[2] ?? "test-results/symbol-equipment-check",
);
await mkdir(output, { recursive: true });
const sample = JSON.parse(
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
      name: "check.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .locator(`button[data-layer-id="${sample.screens[0].objects[0].id}"]`)
      .click();
    const check = page.getByRole("region", {
      name: "関連付け候補の確認",
      exact: true,
    });
    await check.locator("summary").click();
    await page
      .getByLabel("関連付ける機器", { exact: true })
      .selectOption(sample.equipment[1].id);
    await expect(
      check.locator('[data-equipment-check-slot="running"]'),
    ).toContainText("catalog未確認");
    await check.scrollIntoViewIfNeeded();
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.locator(
        `.sheet > svg [data-object-id="${sample.screens[0].objects[0].id}"]`,
      ),
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({
      path: join(output, `symbol-equipment-check-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
