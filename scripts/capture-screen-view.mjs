import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/screen-view");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/embedded-screen.project.json", "utf8"),
);
const selected = project.screens[0].objects[1];
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
      .getByLabel("Project を開く", { exact: true })
      .setInputFiles({
        name: "embedded.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(project)),
      });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${selected.id}"]`).click();
    await expect(page.getByLabel("参照する画面", { exact: true })).toHaveValue(
      project.screens[1].id,
    );
    await expect(page.locator(".sheet > svg [data-screen-view]")).toHaveCount(
      2,
    );
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    await page.screenshot({
      path: join(output, `screen-view-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
