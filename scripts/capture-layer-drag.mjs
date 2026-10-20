import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/layer-drag");
const insertionMode = process.env.SCADA_CAPTURE_LAYER_INSERTION === "1";
await mkdir(output, { recursive: true });
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
    const fixture = JSON.parse(
      await readFile("examples/process-light.project.json", "utf8"),
    );
    const owner = fixture.screens[0];
    const id = (n) => `0199ff00-0000-7000-8000-${String(n).padStart(12, "0")}`;
    owner.folders = [
      { id: id(1), name: "送水設備", order: 0 },
      { id: id(2), name: "タンク", order: 1, parentId: id(1) },
      { id: id(3), name: "ポンプ・バルブ", order: 2, parentId: id(1) },
      { id: id(4), name: "配管", order: 3, parentId: id(1) },
      { id: id(5), name: "計測・テキスト", order: 4 },
    ];
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
    for (const object of owner.objects) {
      if (labels[object.order]) object.name = labels[object.order];
      object.folderId = id(
        [2, 3, 6].includes(object.order)
          ? 2
          : [10, 11].includes(object.order)
            ? 3
            : [7, 8, 9].includes(object.order)
              ? 4
              : 5,
      );
    }
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "organized-equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const pump = page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "P-01 循環ポンプ", exact: true });
    await pump.click();
    await expect(pump).toHaveAttribute("aria-pressed", "true");
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await pump.dispatchEvent("dragstart", { dataTransfer });
    await pump.dispatchEvent("dragover", { dataTransfer });
    const destination = insertionMode
      ? page.locator(
          `[data-layer-order-id="${owner.objects.find((object) => object.order === 11).id}"]`,
        )
      : page.locator(`button[data-layer-folder="${id(2)}"][aria-expanded]`);
    await expect(page.locator(".layer-drag-guide")).toBeVisible();
    const bounds = await destination.boundingBox();
    await destination.dispatchEvent("dragover", {
      dataTransfer,
      clientX: bounds.x + 50,
      clientY: insertionMode
        ? bounds.y + bounds.height - 2
        : bounds.y + bounds.height / 2,
    });
    await expect(page.locator(".layer-drag-guide")).toBeVisible();
    if (insertionMode) await expect(destination).toHaveClass(/insert-after/);
    else
      await expect(page.locator(".layer-folder.drop-hover")).toHaveAttribute(
        "data-layer-drop-folder",
        id(2),
      );
    await page.screenshot({
      path: join(
        output,
        `${insertionMode ? "layer-insertion" : "layer-drag"}-${theme}.png`,
      ),
      animations: "disabled",
    });
    await pump.dispatchEvent("dragend", { dataTransfer });
    await page.close();
  }
} finally {
  await browser.close();
}
