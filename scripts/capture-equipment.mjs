import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/equipment");
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
    const project = JSON.parse(
      await readFile("examples/process-light.project.json", "utf8"),
    );
    const equipment = JSON.parse(
      await readFile("examples/equipment.project.json", "utf8"),
    );
    project.equipmentTypes = equipment.equipmentTypes;
    project.equipment = equipment.equipment;
    project.manifest.name = "循環設備 / 機器台帳";
    project.equipment[0].bindings = [
      { slotName: "running", externalName: "Demo.Water.Pump01.Running" },
      { slotName: "current", externalName: null },
    ];
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.getByTestId("project-status")).toHaveText(
      "Project を読み込みました。",
    );
    for (const label of ["画面", "タグ参照", "シンボル", "プロジェクト設定"]) {
      await page
        .locator("summary")
        .filter({ has: page.getByText(label, { exact: true }) })
        .click();
    }
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .getByRole("button", { name: "FAN-101 · 誘引送風機", exact: true })
      .click();
    await expect(
      library.getByRole("form", { name: "機器情報と割付", exact: true }),
    ).toBeVisible();
    for (const close of await page
      .locator(".toast-host .toast button.close")
      .all())
      await close.click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `equipment-${theme}.png`),
      animations: "disabled",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
