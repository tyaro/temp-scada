import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/selection-paint-alpha");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/minimal.project.json", "utf8"),
);
project.manifest.name = "塗り・枠線の不透明度";
project.screens[0].background = "#ffffff";
project.screens[0].objects[2].fill = "#1e293b";
project.screens[0].objects[2].shape.text = "単色塗り・枠線のα一括編集";
for (const object of project.screens[0].objects.slice(0, 2)) {
  object.shape.paint.stroke = { color: "#2563eb", width: 8 };
  object.opacity = 0.8;
}
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
      name: "opacity.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .getByRole("region", { name: "キャンバス操作領域", exact: true })
      .focus();
    const ids = project.screens[0].objects
      .slice(0, 2)
      .map((object) => object.id);
    await page.locator(`button[data-layer-id="${ids[0]}"]`).click();
    await page
      .locator(`button[data-layer-id="${ids[1]}"]`)
      .click({ modifiers: ["Control"] });
    const form = page.getByRole("form", {
      name: "選択した塗り・枠線の不透明度",
      exact: true,
    });
    await form
      .getByLabel("適用する単色塗りの不透明度（%）", { exact: true })
      .fill("50");
    await form
      .getByLabel("適用する枠線の不透明度（%）", { exact: true })
      .fill("75");
    await form
      .getByRole("button", {
        name: "選択した塗り・枠線に不透明度を適用",
        exact: true,
      })
      .click();
    const status = form.locator("p").filter({ hasText: "単色塗りの現在値" });
    await expect(status).toHaveText("単色塗りの現在値：50%");
    await status.scrollIntoViewIfNeeded();
    const toasts = page.locator(".toast-host button.close");
    while (await toasts.count()) await toasts.first().click();
    await page.evaluate(() => document.fonts.ready);
    const box = await status.boundingBox(),
      color = await status.evaluate((el) =>
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
              Math.floor(box.x),
              Math.floor(box.y),
              Math.ceil(box.width),
              Math.ceil(box.height),
            ).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (color.every((c, j) => Math.abs(pixels[i + j] - c) <= 32))
                ink++;
            return ink;
          },
          { encoded: frame.toString("base64"), box, color },
        );
      })
      .toBeGreaterThan(30);
    await writeFile(
      resolve(output, `selection-paint-alpha-${theme}.png`),
      frame,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
