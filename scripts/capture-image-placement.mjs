import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/image-placement");
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
    project.manifest.name = "画像配置 / 原水供給設備";
    project.screens[0].width = 1280;
    project.screens[0].height = 720;
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    const encoded = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 360;
      c.height = 180;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#eff6ff";
      ctx.fillRect(0, 0, 360, 180);
      ctx.strokeStyle = "#d5e2ef";
      ctx.lineWidth = 1;
      for (let x = 0; x <= 360; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 170);
        ctx.stroke();
      }
      for (let y = 0; y < 170; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(360, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText("設備エリア / 参考レイアウト", 16, 26);
      ctx.fillStyle = "#93c5fd";
      ctx.fillRect(25, 65, 70, 65);
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 3;
      ctx.strokeRect(25, 50, 70, 80);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(95, 100);
      ctx.lineTo(320, 100);
      ctx.stroke();
      ctx.fillStyle = "#ecfdf5";
      ctx.strokeStyle = "#0f766e";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(170, 100, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(160, 87);
      ctx.lineTo(183, 100);
      ctx.lineTo(160, 113);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = "#475569";
      ctx.font = "12px sans-serif";
      ctx.fillText("PNG原本を図面に配置する例", 16, 155);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(0, 170, 360, 10);
      return c.toDataURL("image/png").split(",")[1];
    });
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "ファイル", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "ファイル", exact: true })
      .getByRole("menuitem", { name: "画像を配置", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "設備参考図.png",
      mimeType: "image/png",
      buffer: Buffer.from(encoded, "base64"),
    });
    const image = page.locator(".sheet > svg image[data-image-frame]");
    await expect(image).toHaveCount(1);
    for (const [name, value] of [
      ["x", "830"],
      ["y", "460"],
    ]) {
      const input = page.getByLabel(name, { exact: true });
      await input.fill(value);
      await input.press("Enter");
    }
    await page.getByLabel("配置名", { exact: true }).fill("設備エリア参考図");
    await page.getByRole("button", { name: "変更を適用", exact: true }).click();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(() => document.fonts.ready);
    await image.evaluate(async (el) => {
      const img = new Image();
      img.src = el.getAttribute("href");
      await img.decode();
    });
    const probe = await image.evaluate((el) => {
      const p = new DOMPoint(40, 175).matrixTransform(el.getScreenCTM());
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    let capture;
    await expect
      .poll(
        async () => {
          capture = await page.screenshot({ animations: "disabled" });
          return page.evaluate(
            async ({ encoded, probe }) => {
              const img = new Image();
              img.src = `data:image/png;base64,${encoded}`;
              await img.decode();
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d");
              ctx.drawImage(img, 0, 0);
              return [...ctx.getImageData(probe.x, probe.y, 1, 1).data];
            },
            { encoded: capture.toString("base64"), probe },
          );
        },
        {
          message: "Image pixels must be painted before saving the screenshot",
        },
      )
      .toEqual([37, 99, 235, 255]);
    await writeFile(join(output, `image-placement-${theme}.png`), capture);
    await page.close();
  }
} finally {
  await browser.close();
}
