import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/equipment-types");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/symbol-slots.project.json", "utf8"),
);
for (const item of sample.equipment)
  item.bindings = item.bindings.filter(
    (binding) => binding.slotName === "running",
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
      name: "types.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page
      .getByRole("region", { name: "機器台帳", exact: true })
      .getByRole("button", { name: "機器種別", exact: true })
      .click();
    const editor = page.getByRole("region", {
      name: "機器種別の編集",
      exact: true,
    });
    await editor
      .getByLabel("編集する機器種別", { exact: true })
      .selectOption(sample.equipmentTypes[0].id);
    await expect(
      editor.getByLabel("slot名", { exact: true }).first(),
    ).toHaveAttribute("readonly", "");
    await page
      .getByRole("region", { name: "機器台帳", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `equipment-types-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
