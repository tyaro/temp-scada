import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const images = (page: Page) =>
  page.locator(".sheet > svg image[data-image-frame]");
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await fileCommand(page, "新しいProject");
}
async function png(page: Page) {
  return Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 240;
      c.height = 120;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#e75840";
      ctx.fillRect(0, 0, 120, 120);
      ctx.fillStyle = "#1e9f85";
      ctx.fillRect(120, 0, 120, 120);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
}
async function place(page: Page, bytes: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await fileCommand(page, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "設備写真.png", mimeType: "image/png", buffer: bytes });
  await expect(images(page).last()).toBeAttached();
  await expect(page.locator('.sheet [data-selected="true"]')).toHaveCount(1);
}
async function number(page: Page, name: string, value: string) {
  const input = page.getByLabel(name, { exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
}
async function archive(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await wait;
  expect(file.suggestedFilename()).toBe("project.bantoscada");
  return readFile((await file.path())!);
}
async function saved(page: Page) {
  const bytes = await archive(page);
  return page.evaluate(async (bytes) => {
    const source = "/src/lib/project-package.ts";
    const { readProjectFile } = await import(source);
    const result = await readProjectFile(new Blob([new Uint8Array(bytes)]));
    result.store.dispose();
    return result.project;
  }, Array.from(bytes));
}
async function paintPixels(page: Page) {
  const points = await images(page)
    .first()
    .evaluate((el) => {
      const box = el.getBBox(),
        matrix = el.getScreenCTM()!;
      return [
        new DOMPoint(box.width * 0.25, box.height * 0.5).matrixTransform(
          matrix,
        ),
        new DOMPoint(box.width * 0.75, box.height * 0.5).matrixTransform(
          matrix,
        ),
      ].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    });
  await expect
    .poll(async () => {
      const encoded = (await page.screenshot()).toString("base64");
      return page.evaluate(
        async ({ encoded, points }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const c = document.createElement("canvas");
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          return points.map((p) =>
            Array.from(ctx.getImageData(p.x, p.y, 1, 1).data),
          );
        },
        { encoded, points },
      );
    })
    .toEqual([
      [231, 88, 64, 255],
      [30, 159, 133, 255],
    ]);
}
for (const theme of ["light", "dark"])
  test(`image frames edit, preserve ratio and original name, and restore in a fresh browser in ${theme}`, async ({
    page,
    browser,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    const bytes = await png(page);
    await place(page, bytes);
    await expect(
      page.getByText("原本：設備写真.png", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("色", { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel("色の不透明度（%）", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("width", { exact: true })).toHaveValue("240");
    await paintPixels(page);
    await number(page, "height", "240");
    // A contain frame has selectable whitespace above the source image.
    const area = await images(page).first().boundingBox();
    await page.mouse.click(area!.x + area!.width / 2, area!.y + 5);
    await expect(page.locator('.sheet [data-selected="true"]')).toHaveCount(1);
    const y = Number(await page.getByLabel("y", { exact: true }).inputValue());
    await number(page, "回転角度", "33");
    await number(page, "不透明度（%）", "45");
    await button(page, "元比率へ戻す").click();
    await expect(page.getByLabel("height", { exact: true })).toHaveValue("120");
    await expect(page.getByLabel("y", { exact: true })).toHaveValue(
      String(y + 60),
    );
    await page.getByLabel("配置名", { exact: true }).fill("原水設備の写真");
    await button(page, "変更を適用").click();
    await expect(
      page.getByText("原本：設備写真.png", { exact: false }),
    ).toBeVisible();
    const data = await archive(page),
      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      }),
      other = await context.newPage();
    await other.goto("/");
    await button(other, "編集").click();
    await other.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "image.bantoscada",
      mimeType: "application/zip",
      buffer: data,
    });
    await expect(images(other)).toHaveCount(1);
    expect(
      Buffer.from(
        await images(other).evaluate(async (el) =>
          Array.from(
            new Uint8Array(
              await (await fetch(el.getAttribute("href")!)).arrayBuffer(),
            ),
          ),
        ),
      ),
    ).toEqual(bytes);
    await selectPanel(other, "レイヤー");
    await button(other, "原水設備の写真").click();
    await expect(other.getByLabel("回転角度", { exact: true })).toHaveValue(
      "33",
    );
    await expect(
      other.getByLabel("不透明度（%）", { exact: true }),
    ).toHaveValue("45");
    await expect(other.locator(".minimap image[data-image-frame]")).toHaveCount(
      1,
    );
    await button(other, "表示プレビュー").click();
    await expect(images(other)).toHaveCount(1);
    await context.close();
  });
test("background and duplicated images share one original through remove and Undo", async ({
  page,
}) => {
  await start(page);
  const bytes = await png(page);
  await place(page, bytes);
  await selectPanel(page, "プロジェクト");
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "同じ背景.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect(
    page.locator(".sheet > svg > image[data-background-image]"),
  ).toBeAttached();
  await selectPanel(page, "レイヤー");
  await button(page, "image · 0").click();
  await page.keyboard.press("Control+d");
  await expect(images(page)).toHaveCount(2);
  let project = await saved(page);
  expect(project.assets).toHaveLength(1);
  expect(
    project.screens[0].objects.every(
      (o: any) =>
        o.shape.assetId === project.screens[0].backgroundImage.assetId,
    ),
  ).toBe(true);
  await selectPanel(page, "プロジェクト");
  await button(page, "背景画像を解除").click();
  await selectPanel(page, "レイヤー");
  await button(page, "image · 0").click();
  await page.keyboard.press("Delete");
  await expect(images(page)).toHaveCount(1);
  await button(page, "image · 1").click();
  await page.keyboard.press("Delete");
  await expect(images(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(images(page)).toHaveCount(1);
  project = await saved(page);
  expect(project.assets).toHaveLength(1);
});
test("image mixed colors are disabled without partially coloring other objects", async ({
  page,
}) => {
  await start(page);
  await place(page, await png(page));
  await selectPanel(page, "部品");
  await button(page, "Rectangle を追加").click();
  await selectPanel(page, "レイヤー");
  await button(page, "image · 0").click({ modifiers: ["Shift"] });
  const colors = page.locator('form[data-editor-form="selection-color"]');
  await expect(colors).toContainText("画像を含む選択には色を適用できません");
  await expect(colors.getByLabel("適用する色", { exact: true })).toBeDisabled();
  await expect(
    colors.getByRole("button", { name: "選択した配置に色を適用", exact: true }),
  ).toBeDisabled();
});
test("late image decode is discarded when leaving preview and returning to edit", async ({
  page,
}) => {
  await start(page);
  const bytes = await png(page);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).digestComplete = true;
      return result;
    };
    const original = window.createImageBitmap;
    window.createImageBitmap = async (
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      await new Promise<void>(
        (resolve) => ((window as any).releaseImage = resolve),
      );
      (window as any).decoded = true;
      return (original as any)(...args);
    };
  });
  const chooser = page.waitForEvent("filechooser");
  await fileCommand(page, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "late.png", mimeType: "image/png", buffer: bytes });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseImage))
    .toBe("function");
  await button(page, "表示プレビュー").click();
  await button(page, "編集").click();
  await page.evaluate(() => (window as any).releaseImage());
  await expect
    .poll(() => page.evaluate(() => (window as any).decoded))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).digestComplete))
    .toBe(true);
  await expect(images(page)).toHaveCount(0);
});

test("image drag, frame resize, lock and visibility use the existing editing contract", async ({
  page,
}) => {
  await start(page);
  await place(page, await png(page));
  const object = page.locator('.sheet [data-selected="true"]'),
    initial = await object.getAttribute("transform");
  const box = (await images(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 + 40,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(object).not.toHaveAttribute("transform", initial!);
  const handle = page.locator('.sheet [data-resize-handle="se"]'),
    h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + h.height / 2 + 30, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(page.getByLabel("width", { exact: true })).not.toHaveValue(
    "240",
  );
  await page.keyboard.press("Control+z");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("240");
  await number(page, "不透明度（%）", "0");
  await selectPanel(page, "レイヤー");
  await button(page, "image · 0").click();
  await expect(object).toHaveCount(1);
  await expect(object.locator("[data-object-rotation]")).toHaveAttribute(
    "opacity",
    "0",
  );
  await button(page, "ロック：image · 0").click();
  await expect(page.getByLabel("x", { exact: true })).toBeDisabled();
  await expect(button(page, "元比率へ戻す")).toBeDisabled();
  await button(page, "ロックを解除").click();
  await expect(page.getByLabel("x", { exact: true })).toBeEnabled();
  await button(page, "非表示：image · 0").click();
  await expect(images(page)).toHaveCount(0);
  await expect(page.locator(".minimap image[data-image-frame]")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(images(page)).toHaveCount(1);
});
