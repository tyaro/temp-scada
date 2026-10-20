import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/array-copy");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/equipment-property.project.json", "utf8"),
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
      name: "array.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .getByRole("region", { name: "キャンバス操作領域", exact: true })
      .focus();
    await page.keyboard.press("Control+a");
    const toasts = page.locator(".toast-host button.close");
    while (await toasts.count()) await toasts.first().click();
    await page.getByRole("button", { name: "配列複製", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "配列複製", exact: true });
    await dialog.getByLabel("列数", { exact: true }).fill("3");
    await dialog.getByLabel("行数", { exact: true }).fill("2");
    await expect(dialog).toContainText("追加30配置");
    const field = dialog.getByLabel("列数", { exact: true });
    await expect(field).toHaveValue("3");
    await page.evaluate(() => document.fonts.ready);
    const box = await field.boundingBox(),
      color = await field.evaluate((el) =>
        getComputedStyle(el).color.match(/\d+/g).slice(0, 3).map(Number),
      );
    let frame;
    await expect
      .poll(async () => {
        frame = await page.screenshot({ animations: "disabled" });
        return page.evaluate(
          async ({ encoded, box, color }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${encoded}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const pixels = ctx.getImageData(
              Math.ceil(box.x) + 4,
              Math.ceil(box.y) + 4,
              Math.floor(box.width) - 8,
              Math.floor(box.height) - 8,
            ).data;
            let ink = 0;
            for (let index = 0; index < pixels.length; index += 4)
              if (
                color.every(
                  // Regular input glyphs include antialiased edges as well as opaque cores.
                  (value, channel) =>
                    Math.abs(pixels[index + channel] - value) <= 48,
                )
              )
                ink++;
            return ink;
          },
          { encoded: frame.toString("base64"), box, color },
        );
      })
      .toBeGreaterThan(3);
    await writeFile(resolve(output, `array-copy-${theme}.png`), frame);
    await page.close();
  }
} finally {
  await browser.close();
}
