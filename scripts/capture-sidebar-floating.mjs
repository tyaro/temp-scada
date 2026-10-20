import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "test-results/sidebar-floating");
await mkdir(output, { recursive: true });
const project = JSON.parse(
  await readFile("examples/equipment-property.project.json", "utf8"),
);
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
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "metadata.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .getByRole("button", {
        name: `${project.equipment[1].code} · ${project.equipment[1].name}`,
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    await page
      .locator(`button[data-layer-id="${project.screens[0].objects[2].id}"]`)
      .click();
    await expect(page.locator('form[data-editor-form="object"]')).toBeVisible();
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await page
      .getByRole("menu", { name: "常設メニュー", exact: true })
      .getByRole("menuitem", { name: "プロパティを浮動にする", exact: true })
      .click();
    const panel = page.locator("#designer-inspector-panel");
    await expect(panel).toHaveAttribute("data-panel-placement", "floating");
    const grip = page.getByRole("button", {
        name: "プロパティパネルを移動",
        exact: true,
      }),
      handleBox = await grip.boundingBox();
    await page.mouse.move(handleBox.x + 30, handleBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 30, handleBox.y + 40, { steps: 8 });
    await page.mouse.up();
    await expect(
      page.getByRole("button", {
        name: "プロパティパネルのサイズを変更",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await page
      .getByRole("menu", { name: "常設メニュー", exact: true })
      .getByRole("menuitem", { name: "作業パネルを浮動にする", exact: true })
      .click();
    await expect(page.locator("#designer-project-panel")).toHaveAttribute(
      "data-panel-placement",
      "floating",
    );
    const toasts = page.locator(".toast-host button.close");
    while (await toasts.count()) await toasts.first().click();
    const name = page.locator(
      `.sheet > svg [data-object-id="${project.screens[0].objects[2].id}"] [data-equipment-property="name"]`,
    );
    await expect(name).toContainText(project.equipment[1].name);
    await expect(name).toHaveAttribute("data-text-layout", "full");
    await expect(name.locator("[data-text-content]")).not.toBeEmpty();
    await expect(
      page.locator('.sheet > svg [data-equipment-property-state="resolved"]'),
    ).toHaveCount(6);
    await expect(
      page.locator('.sheet > svg [data-equipment-property-state="unbound"]'),
    ).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    const close = page.locator(".toast-host button.close");
    while (await close.count()) await close.first().click();
    const box = await name.boundingBox();
    let frame;
    await expect
      .poll(async () => {
        frame = await page.screenshot({ animations: "disabled" });
        return page.evaluate(
          async ({ encoded, box }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${encoded}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const pixels = ctx.getImageData(
              Math.floor(box.x),
              Math.floor(box.y),
              Math.ceil(box.width),
              Math.ceil(box.height),
            ).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (
                pixels[i] === 15 &&
                pixels[i + 1] === 23 &&
                pixels[i + 2] === 42
              )
                ink++;
            return ink;
          },
          { encoded: frame.toString("base64"), box },
        );
      })
      .toBeGreaterThan(40);
    await writeFile(resolve(output, `sidebar-floating-${theme}.png`), frame);
    await page.close();
  }
} finally {
  await browser.close();
}
