import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/text-style");
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
    project.manifest.name = "Textの書式 / 工程図サンプル";
    const texts = project.screens[0].objects.filter(
      (o) => o.shape.type === "text",
    );
    const heading = texts[0];
    heading.shape.text = "原水供給・移送設備";
    heading.shape.style = { fontSize: 28, fontWeight: "bold", align: "left" };
    heading.height = 42;
    heading.name = "設備見出し（太字・左揃え）";
    const label = texts[1];
    label.shape.style = { fontSize: 18, fontWeight: "bold", align: "center" };
    if (texts[4]) {
      texts[4].shape.text = "原水移送ポンプ・運転状態";
      texts[4].width = 120;
      texts[4].shape.style = {
        fontSize: 18,
        fontWeight: "normal",
        align: "left",
      };
    }
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles({
        name: "text-style-demo.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(project)),
      });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator(`button[data-layer-id="${heading.id}"]`).click();
    await expect(page.getByLabel("文字サイズ", { exact: true })).toHaveValue(
      "28",
    );
    await expect(
      page.locator(
        `.sheet [data-object-id="${heading.id}"] [data-text-content]`,
      ),
    ).toHaveText(heading.shape.text);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `text-style-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
