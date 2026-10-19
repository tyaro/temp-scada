import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/selection-color");
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
    const fixture = JSON.parse(
      await readFile("examples/process-light.project.json", "utf8"),
    );
    const labels = {
      2: "TK-01 タンク枠",
      3: "TK-01 液面表示",
      6: "タンク液位ラベル",
      7: "原水供給配管",
      8: "送水配管",
      9: "戻り配管",
      10: "P-01 循環ポンプ",
      11: "V-01 調整バルブ",
    };
    for (const object of fixture.screens[0].objects)
      if (labels[object.order]) object.name = labels[object.order];
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "named-equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const layers = page.getByRole("navigation", { name: "図形一覧" });
    await layers
      .getByRole("button", { name: "P-01 循環ポンプ", exact: true })
      .click();
    await layers
      .getByRole("button", { name: "送水配管", exact: true })
      .click({ modifiers: ["Shift"] });
    const colors = page.getByRole("form", {
      name: "選択した配置の色",
      exact: true,
    });
    await expect(colors).toContainText("現在の色：混在");
    await colors.getByLabel("適用する色", { exact: true }).fill("#2563eb");
    await expect(
      colors.getByRole("button", {
        name: "選択した配置に色を適用",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.locator('.sheet > svg [data-selected="true"]'),
    ).toHaveCount(2);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `selection-color-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
