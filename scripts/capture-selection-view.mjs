import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/selection-view");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/shape-paint.project.json", "utf8"),
);
const target = sample.screens[0].objects.filter(
  (object) => object.shape.type === "symbol",
)[1];
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
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "ファイル", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "塗りと枠線サンプルを開く", exact: true })
      .click();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${target.id}"]`).click();
    await page
      .getByRole("button", { name: "選択範囲を表示", exact: true })
      .click();
    await expect(page.getByLabel("表示倍率", { exact: true })).not.toHaveValue(
      "fit",
    );
    await expect(page.getByTestId("save-state")).not.toContainText(
      "未書き出しの変更あり",
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
      path: join(output, `selection-view-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
