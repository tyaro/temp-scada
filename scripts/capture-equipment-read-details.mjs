import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(
  process.argv[2] ?? "test-results/equipment-read-details",
);
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/symbol-slots.project.json", "utf8"),
);
const type = sample.equipmentTypes.find(
  (item) => item.id === sample.equipment[0].typeId,
);
sample.equipment[0].bindings = type.slots.map((slot, i) => ({
  slotName: slot.name,
  externalName: i === 0 ? "Demo.Pump01.Running" : null,
}));
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
      name: "details.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    for (const item of sample.equipment.slice(0, 2)) {
      await page
        .getByRole("button", { name: "機器の読取詳細", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "機器の読取詳細を開く",
        exact: true,
      });
      await picker.locator(`input[value="${item.id}"]`).check();
      await picker
        .getByRole("button", { name: "小窓を表示", exact: true })
        .click();
      await expect(
        page.locator(`[data-preview-popup="${item.id}"]`),
      ).toBeVisible();
    }
    const second = page.locator(
      `[data-preview-popup="${sample.equipment[1].id}"] [data-popup-move]`,
    );
    for (let i = 0; i < 23; i++) await second.press("Shift+ArrowRight");
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `equipment-read-details-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
