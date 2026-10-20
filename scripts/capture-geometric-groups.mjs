import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const output = resolve(process.argv[2] ?? "test-results/geometric-groups");
const baseURL = process.env.SCADA_CAPTURE_URL ?? "http://127.0.0.1:5173";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    await page.goto(baseURL);
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
    const screen = project.screens[0];
    project.manifest.name = "循環設備 / グループ編集";
    const members = screen.objects
      .filter((object) => object.order >= 10 && object.order <= 13)
      .sort((a, b) => a.order - b.order);
    screen.groups = [
      {
        id: "0199f600-0000-7000-8000-000000000001",
        name: "循環ポンプ・バルブユニット",
        memberIds: members.map((object) => object.id),
      },
    ];
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "groups.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.getByTestId("project-status")).toHaveText(
      "Project を読み込みました。",
    );
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page.locator("button[data-layer-group]").click();
    await expect(page.getByLabel("グループ名", { exact: true })).toHaveValue(
      "循環ポンプ・バルブユニット",
    );
    await expect(
      page.locator('.sheet > svg [data-selected="true"]'),
    ).toHaveCount(4);
    await page.locator(".toast-host .toast button.close").first().click();
    await expect(page.locator(".toast-host .toast")).toHaveCount(0);
    await page.screenshot({
      path: join(output, `geometric-groups-${theme}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const settle = async () => {
      for (const close of await page
        .locator(".toast-host .toast button.close")
        .all())
        await close.click();
      await expect(page.locator(".toast-host .toast")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await page
        .getByRole("region", { name: "キャンバス操作領域", exact: true })
        .evaluate(
          (element) =>
            new Promise((resolve) => {
              const observer = new ResizeObserver(() => {
                observer.disconnect();
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              });
              observer.observe(element);
            }),
        );
    };
    await settle();
    const groupedPixels = await page.locator(".sheet > svg").screenshot({
      path: join(output, `preview-grouped-${theme}.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "編集", exact: true }).click();
    screen.groups = [];
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "ungrouped.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.getByTestId("project-status")).toHaveText(
      "Project を読み込みました。",
    );
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await settle();
    const plainPixels = await page.locator(".sheet > svg").screenshot({
      path: join(output, `preview-plain-${theme}.png`),
      animations: "disabled",
    });
    expect(plainPixels.equals(groupedPixels)).toBe(true);
    process.stdout.write(
      `${theme}: group and independent placements render identical preview pixels\n`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
