import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/distribute");
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
    fixture.manifest.name = "等間隔配置の静的サンプル";
    fixture.screens[0].name = "ポンプの中心を等間隔に配置";
    const pump = fixture.screens[0].objects.find(
      (object) => object.order === 10,
    );
    const text = fixture.screens[0].objects.find(
      (object) => object.order === 0,
    );
    const id = (n) => `0199fa00-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const names = ["P-101 給水ポンプ", "P-102 循環ポンプ", "P-103 予備ポンプ"];
    fixture.screens[0].objects = [
      ...[100, 350, 700].map((x, index) => ({
        ...structuredClone(pump),
        id: id(index + 1),
        order: index,
        name: names[index],
        x,
        y: 220,
        width: 100,
        height: 100,
      })),
      {
        ...structuredClone(text),
        id: id(4),
        order: 3,
        x: 90,
        y: 70,
        width: 780,
        height: 36,
        fill: "#0f172a",
        shape: { type: "text", text: "中心を等間隔に配置した静的サンプル" },
      },
      {
        ...structuredClone(text),
        id: id(5),
        order: 4,
        x: 90,
        y: 115,
        width: 780,
        height: 20,
        fill: "#334155",
        shape: {
          type: "text",
          text: "両端固定・300 unit 間隔・スナップ丸めなし（Hub 未接続）",
        },
      },
    ];
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "named-equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const layers = page.getByRole("navigation", { name: "図形一覧" });
    for (const [index, name] of names.entries())
      await layers
        .getByRole("button", { name, exact: true })
        .click(index ? { modifiers: ["Shift"] } : {});
    await page
      .getByRole("button", { name: "中心を水平方向に等間隔", exact: true })
      .click();
    await expect(
      page.locator(`.sheet > svg [data-object-id="${id(2)}"]`),
    ).toHaveAttribute("transform", "translate(400 220)");
    await expect(
      page.locator('.sheet > svg [data-selected="true"]'),
    ).toHaveCount(3);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: join(output, `distribute-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
