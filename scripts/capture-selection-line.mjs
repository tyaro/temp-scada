import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/selection-line");
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
    const lines = project.screens[0].objects.filter(
      (object) => object.shape.type === "polyline",
    );
    for (const [i, object] of lines.entries())
      object.name =
        ["原水供給配管", "送水配管", "戻り配管"][i] ?? `配管 ${i + 1}`;
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles({
        name: "named-pipes.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(project)),
      });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    for (const [i, object] of lines.entries())
      await page
        .locator(`button[data-layer-id="${object.id}"]`)
        .click({ modifiers: i ? ["Shift"] : [] });
    const form = page.getByRole("form", {
      name: "選択した線・配管のスタイルを変更",
      exact: true,
    });
    await form.getByLabel("適用する線幅", { exact: true }).fill("6");
    await form.getByLabel("適用する矢印", { exact: true }).selectOption("end");
    await expect(
      form.getByRole("button", { name: "選択した線・配管に適用", exact: true }),
    ).toBeEnabled();
    await form.scrollIntoViewIfNeeded();
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `selection-line-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
