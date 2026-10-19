import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/image-crop");
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
    project.screens[0].width = 1280;
    project.screens[0].height = 720;
    project.manifest.name = "画像の非破壊編集 / 原水供給設備";
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.getByTestId("project-status")).toHaveText(
      "Project を読み込みました。",
    );
    const encoded = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 240;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#f0f7fa";
      ctx.fillRect(0, 0, 480, 240);
      ctx.fillStyle = "#c4d6dd";
      ctx.fillRect(0, 0, 48, 240);
      ctx.fillRect(432, 0, 48, 240);
      ctx.fillStyle = "#334155";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("P-101 / PUMP ASSEMBLY", 72, 36);
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(48, 135);
      ctx.lineTo(432, 135);
      ctx.stroke();
      ctx.fillStyle = "#a7ded1";
      ctx.strokeStyle = "#20776b";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(215, 130, 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#dcebe7";
      ctx.fillRect(263, 96, 96, 68);
      ctx.strokeRect(263, 96, 96, 68);
      ctx.fillStyle = "#20776b";
      ctx.fillRect(170, 180, 188, 10);
      ctx.fillStyle = "#475569";
      ctx.font = "14px sans-serif";
      ctx.fillText("REFERENCE IMAGE / ORIGINAL 480 × 240", 64, 222);
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
      name: "ポンプ参考図.png",
      mimeType: "image/png",
      buffer: Buffer.from(encoded, "base64"),
    });
    await expect(page.locator(".sheet [data-image-frame]")).toHaveCount(1);
    for (const [name, value] of [
      ["x", "760"],
      ["y", "420"],
      ["width", "480"],
      ["height", "240"],
    ]) {
      const input = page.getByLabel(name, { exact: true });
      await input.fill(value);
      await input.press("Enter");
    }
    await page
      .getByLabel("配置名", { exact: true })
      .fill("ポンプ参考図 / 切出し");
    await page.getByRole("button", { name: "変更を適用", exact: true }).click();
    const form = page.getByRole("form", {
      name: "画像のトリミング",
      exact: true,
    });
    await form.locator('[name="cropX"]').fill("10");
    await form.locator('[name="cropWidth"]').fill("80");
    await form
      .getByRole("button", { name: "切出しを適用", exact: true })
      .click();
    await expect(page.locator(".sheet [data-image-crop]")).toHaveAttribute(
      "viewBox",
      "48 0 384 240",
    );
    await form.scrollIntoViewIfNeeded();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.screenshot({
      path: resolve(output, `image-crop-${theme}.png`),
      fullPage: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
