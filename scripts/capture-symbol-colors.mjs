import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/symbol-colors");
await mkdir(output, { recursive: true });
const sample = JSON.parse(
  await readFile("examples/symbol-color.project.json", "utf8"),
);
const placements = sample.screens[0].objects.filter(
  (object) => object.shape.type === "symbol",
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
async function settle(page) {
  const close = page.locator(".toast-host button.close");
  while (await close.count()) await close.first().click();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}
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
      .getByRole("menuitem", { name: "Symbol配色サンプルを開く", exact: true })
      .click();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${placements[1].id}"]`).click();
    await expect(page.getByLabel("色の使い方", { exact: true })).toHaveValue(
      "definition",
    );
    await expect(page.getByLabel("色", { exact: true })).toBeDisabled();
    await settle(page);
    await page.screenshot({
      path: join(output, `symbol-colors-${theme}.png`),
      animations: "disabled",
    });
    await page
      .locator(`button[data-layer-id="${placements[0].id}"]`)
      .click({ modifiers: ["Shift"] });
    const colors = page.getByRole("form", {
      name: "選択した配置の色",
      exact: true,
    });
    await colors.getByLabel("適用する色", { exact: true }).fill("#0f766e");
    await expect(colors.getByRole("checkbox")).not.toBeChecked();
    await expect(
      colors.getByRole("button", {
        name: "選択した配置に色を適用",
        exact: true,
      }),
    ).toBeDisabled();
    await colors.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(output, `symbol-color-conversion-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
