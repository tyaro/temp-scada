import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/selection-outline");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/shape-paint.project.json", "utf8"),
);
const target = sample.screens[0].objects.find(
  (o) => o.name === "枠線のみ・塗り色保持",
);
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
    const rectangle = sample.screens[0].objects.find(
      (object) => object.name === "塗りと枠線",
    );
    await page.locator(`button[data-layer-id="${rectangle.id}"]`).click();
    await page
      .locator(`button[data-layer-id="${target.id}"]`)
      .click({ modifiers: ["Shift"] });
    const form = page.getByRole("form", {
      name: "選択した矩形・楕円の枠線を変更",
      exact: true,
    });
    await expect(
      form.getByLabel("適用する枠線幅", { exact: true }),
    ).toHaveValue("");
    await form.getByLabel("適用する枠線幅", { exact: true }).fill("8");
    await expect(
      form.getByRole("button", {
        name: "選択した矩形・楕円の枠線に適用",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole("region", { name: "選択した矩形・楕円の枠線", exact: true })
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
      path: join(output, `selection-outline-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
