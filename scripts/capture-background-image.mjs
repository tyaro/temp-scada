import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/background-image");
await mkdir(output, { recursive: true });
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
    const project = JSON.parse(
      await readFile("examples/process-light.project.json", "utf8"),
    );
    project.manifest.name = "背景画像 / 工程図サンプル";
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.getByRole("tab", { name: "プロジェクト", exact: true }).click();
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 960, 540);
      ctx.strokeStyle = "#d5e3e9";
      ctx.lineWidth = 1;
      for (let x = 0; x <= 960; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 540);
        ctx.stroke();
      }
      for (let y = 0; y <= 540; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(960, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#e1f2f0";
      ctx.fillRect(100, 120, 290, 340);
      ctx.fillStyle = "#f0f4fb";
      ctx.fillRect(440, 280, 460, 160);
      ctx.strokeStyle = "#71aaa4";
      ctx.lineWidth = 2;
      ctx.strokeRect(100, 120, 290, 340);
      ctx.strokeRect(440, 280, 460, 160);
      ctx.fillStyle = "#4d817a";
      ctx.font = "14px sans-serif";
      ctx.fillText("原水設備エリア", 110, 115);
      ctx.fillText("移送設備エリア", 450, 272);
      ctx.fillText("背景画像サンプル：設備エリア図", 40, 510);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
      name: "設備エリア図.png",
      mimeType: "image/png",
      buffer: Buffer.from(encoded, "base64"),
    });
    await expect(
      page.locator(".sheet > svg > image[data-background-image]"),
    ).toBeAttached();
    await page
      .getByLabel("背景画像の不透明度（%）", { exact: true })
      .fill("55");
    await page
      .getByRole("button", { name: "背景画像の設定を適用", exact: true })
      .click();
    await page
      .getByRole("region", { name: "背景画像の設定", exact: true })
      .scrollIntoViewIfNeeded();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `background-image-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
