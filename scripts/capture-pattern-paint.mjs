import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/pattern-paint");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/pattern-paint.project.json", "utf8"),
);
const target = sample.screens[0].objects.find((o) => o.order === 17);
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
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "pattern-paint.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${target.id}"]`).click();
    const form = page.getByRole("form", { name: "塗りと枠線", exact: true });
    await expect(form.getByLabel("塗りの種類", { exact: true })).toHaveValue(
      "pattern",
    );
    const rotation = page.locator(
      `.sheet > svg [data-object-id="${target.id}"] > [data-object-rotation]`,
    );
    // Verify the live crosshatch raster has holes and caps at one foreground alpha.
    const pixels = await rotation.evaluate(async (element) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="42">${element.outerHTML}</svg>`;
      const image = new Image();
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 42;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, 240, 42).data;
      let maximum = 0,
        holes = 0,
        colored = 0;
      for (let i = 3; i < data.length; i += 4) {
        maximum = Math.max(maximum, data[i]);
        if (data[i] === 0) holes++;
        if (data[i] > 100) colored++;
      }
      return { maximum, holes, colored };
    });
    expect(pixels.maximum).toBe(140);
    expect(pixels.holes).toBeGreaterThan(100);
    expect(pixels.colored).toBeGreaterThan(100);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    await page.screenshot({
      path: join(output, `pattern-paint-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
