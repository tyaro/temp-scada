import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/line-style");
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
    project.manifest.name = "実線・破線・点線 / 工程図サンプル";
    const lines = project.screens[0].objects.filter(
      (o) => o.shape.type === "polyline",
    );
    for (const [i, line] of lines.entries()) {
      line.shape.lineStyle = ["dashed", "dotted", "solid"][i % 3];
      line.shape.strokeWidth = 4;
      line.name = ["供給配管（破線）", "送水配管（点線）", "戻り配管（実線）"][
        i % 3
      ];
    }
    const tank = project.screens[0].objects.find(
      (o) => o.shape.type === "rectangle",
    );
    tank.shape.paint.stroke = {
      color: "#334155",
      width: 3,
      lineStyle: "dashed",
    };
    const selected = lines[0];
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles({
        name: "line-style-demo.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(project)),
      });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${selected.id}"]`).click();
    await expect(page.getByLabel("線種", { exact: true })).toHaveValue(
      "dashed",
    );
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `line-style-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
