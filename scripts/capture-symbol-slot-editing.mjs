import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/symbol-slot-editing");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/symbol-slots.project.json", "utf8"),
);
// The definition editor has a dark design background; use authored text colors that fit it.
for (const definition of sample.symbols)
  for (const object of definition.objects)
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
      name: "slots.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("button", { name: "定義を編集", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "共有Symbolの読取slot",
      exact: true,
    });
    const form = panel.getByRole("form", {
      name: "読取slotを追加",
      exact: true,
    });
    await form.getByLabel("slot名", { exact: true }).fill("pressure");
    await form.getByRole("button", { name: "宣言を追加", exact: true }).click();
    await expect(
      panel.getByRole("region", { name: "slot宣言 pressure", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("form", { name: "slot宣言 pressure を編集", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .locator(".toast-host .toast button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `symbol-slot-editing-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
