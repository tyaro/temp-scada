import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/background-crop");
await mkdir(output, { recursive: true });
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
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "ファイル", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "ファイル", exact: true })
      .getByRole("menuitem", { name: "新しいProject", exact: true })
      .click();
    const encoded = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#edf6fa";
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "16px sans-serif";
      ctx.fillText("REFERENCE PLAN / ORIGINAL 640 × 360", 20, 28);
      ctx.strokeStyle = "#718a97";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(0, 180);
      ctx.lineTo(640, 180);
      ctx.stroke();
      ctx.fillStyle = "#b8d7e1";
      ctx.fillRect(80, 90, 90, 180);
      ctx.strokeRect(80, 90, 90, 180);
      ctx.fillStyle = "#53ae9b";
      ctx.beginPath();
      ctx.arc(320, 180, 54, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2c7069";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = "#c9e0dc";
      ctx.fillRect(380, 146, 100, 68);
      ctx.strokeRect(380, 146, 100, 68);
      ctx.fillStyle = "#475569";
      ctx.font = "18px sans-serif";
      ctx.fillText("TANK", 96, 304);
      ctx.fillText("PUMP", 292, 276);
      return c.toDataURL("image/png").split(",")[1];
    });
    await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
      name: "下絵参考図.png",
      mimeType: "image/png",
      buffer: Buffer.from(encoded, "base64"),
    });
    await expect(page.locator(".sheet [data-background-image]")).toHaveCount(1);
    await page
      .getByLabel("背景画像の不透明度（%）", { exact: true })
      .fill("40");
    await page
      .getByRole("button", { name: "背景画像の設定を適用", exact: true })
      .click();
    const form = page.getByRole("form", {
      name: "背景画像のトリミング",
      exact: true,
    });
    for (const [name, value] of [
      ["cropX", "10"],
      ["cropY", "10"],
      ["cropWidth", "80"],
      ["cropHeight", "80"],
    ])
      await form.locator(`[name="${name}"]`).fill(value);
    await form
      .getByRole("button", { name: "背景の切出しを適用", exact: true })
      .click();
    await form.scrollIntoViewIfNeeded();
    await expect(
      page.locator(".sheet [data-background-crop] > svg"),
    ).toHaveAttribute("viewBox", "64 36 512 288");
    await page
      .locator(".toast-host button.close")
      .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await page.evaluate(() => document.fonts.ready);
    let verifiedFrame;
    await expect
      .poll(async () => {
        verifiedFrame = await page.screenshot({ animations: "disabled" });
        const encoded = verifiedFrame.toString("base64");
        const point = await page.locator(".sheet > svg").evaluate((el) => {
          const p = new DOMPoint(480, 270).matrixTransform(el.getScreenCTM());
          return { x: Math.round(p.x), y: Math.round(p.y) };
        });
        return page.evaluate(
          async ({ encoded, point }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${encoded}`;
            await image.decode();
            const c = document.createElement("canvas");
            c.width = image.width;
            c.height = image.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const rgba = ctx.getImageData(point.x, point.y, 1, 1).data;
            return [186, 223, 215].every((v, i) => Math.abs(v - rgba[i]) < 8);
          },
          { encoded, point },
        );
      })
      .toBe(true);
    await writeFile(
      resolve(output, `background-crop-${theme}.png`),
      verifiedFrame,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
