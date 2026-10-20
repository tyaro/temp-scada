import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/multiline-text");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/multiline-text.project.json", "utf8"),
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
      name: "text-style.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const id = project.screens[0].objects[4].id;
    await page.locator(`button[data-layer-id="${id}"]`).click();
    const status = page.locator(
      `.sheet > svg [data-object-id="${id}"] [data-text-line="0"]`,
    );
    await expect(status).toHaveText("原水ポンプ P-101");
    await expect(
      page.locator(
        `.sheet > svg [data-object-id="${project.screens[0].objects[6].id}"] svg[data-text-layout]`,
      ),
    ).toHaveAttribute("data-text-layout", "ellipsis");
    const toasts = page.locator(".toast-host button.close");
    while (await toasts.count()) await toasts.first().click();
    await page.evaluate(() => document.fonts.ready);
    const box = await status.boundingBox(),
      color = await status.evaluate((el) =>
        getComputedStyle(el).fill.match(/\d+/g).slice(0, 3).map(Number),
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
    await writeFile(resolve(output, `multiline-text-${theme}.png`), frame);
    await page.close();
  }
} finally {
  await browser.close();
}
