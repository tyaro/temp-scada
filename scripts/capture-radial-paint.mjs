import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/radial-paint");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/radial-paint.project.json", "utf8"),
);
const target = sample.screens[0].objects
  .filter((o) => o.shape.type === "rectangle")
  .at(-1);
target.opacity = 1;
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
      name: "radial.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${target.id}"]`).click();
    const form = page.getByRole("form", { name: "塗りと枠線", exact: true });
    for (const [name, value] of [
      ["radialStartColor", "#00a88a"],
      ["radialEndColor", "#b6e9fc"],
      ["radialStartAlpha", "100"],
      ["radialEndAlpha", "100"],
      ["radialCenterX", "35"],
      ["radialCenterY", "35"],
      ["radialRadius", "75"],
    ])
      await form.locator(`[name="${name}"]`).fill(value);
    await form
      .getByRole("button", { name: "塗りと枠線を適用", exact: true })
      .click();
    await form.scrollIntoViewIfNeeded();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(() => document.fonts.ready);
    const point = await page
      .locator(
        `.sheet > svg > [data-object-id="${target.id}"] > [data-object-rotation]`,
      )
      .evaluate((el, target) => {
        const p = new DOMPoint(
          target.width * 0.35,
          target.height * 0.35,
        ).matrixTransform(el.getScreenCTM());
        return { x: p.x, y: p.y };
      }, target);
    let frame;
    await expect
      .poll(async () => {
        frame = await page.screenshot({ animations: "disabled" });
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
            const rgba = ctx.getImageData(
              Math.round(point.x),
              Math.round(point.y),
              1,
              1,
            ).data;
            return (
              Math.abs(rgba[0]) < 10 &&
              Math.abs(rgba[1] - 168) < 10 &&
              Math.abs(rgba[2] - 138) < 10
            );
          },
          { encoded: frame.toString("base64"), point },
        );
      })
      .toBe(true);
    await writeFile(resolve(output, `radial-paint-${theme}.png`), frame);
    await page.close();
  }
} finally {
  await browser.close();
}
