import { test, expect, type Page } from "@playwright/test";
import { pngFixture } from "./helpers/images";
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
import { readFile } from "node:fs/promises";
const fitForm = (page: Page) =>
  page.getByRole("form", { name: "画像の表示方式", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await fileCommand(page, "新しいProject");
  const bytes = await pngFixture(page, {
    width: 400,
    height: 200,
    rectangles: [
      { x: 0, y: 0, width: 100, height: 200, color: "#ff0000" },
      { x: 100, y: 0, width: 100, height: 200, color: "#00ff00" },
      { x: 200, y: 0, width: 100, height: 200, color: "#0000ff" },
      { x: 300, y: 0, width: 100, height: 200, color: "#ffff00" },
      { x: 0, y: 0, width: 400, height: 50, color: "#000000" },
      { x: 0, y: 150, width: 400, height: 50, color: "#ffffff" },
    ],
  });
  const chooser = page.waitForEvent("filechooser");
  await fileCommand(page, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "asymmetric.png", mimeType: "image/png", buffer: bytes });
  await expect(page.locator(".sheet [data-image-frame]")).toHaveCount(1);
  return bytes;
}
async function number(page: Page, name: string, value: number) {
  const input = page.getByLabel(name, { exact: true });
  await input.fill(String(value));
  await input.press("Enter");
  await expect(input).toHaveValue(String(value));
}
async function applyFit(page: Page, fit: string) {
  await fitForm(page).getByRole("combobox").selectOption(fit);
  await fitForm(page)
    .getByRole("button", { name: "表示方式を適用", exact: true })
    .click();
}
const grid = [0.13, 0.37, 0.63, 0.87].flatMap((x) =>
  [0.13, 0.37, 0.63, 0.87].map((y) => ({ x, y })),
);
async function pixels(
  page: Page,
  w: number,
  h: number,
  fit: string,
  cropped: boolean,
  opacity = 1,
) {
  const points = await page
    .locator(".sheet > svg > [data-object-id] > [data-object-rotation]")
    .first()
    .evaluate(
      (el, grid) => {
        const m = (el as SVGGraphicsElement).getScreenCTM()!;
        return grid.map((p) => {
          const pt = new DOMPoint(p.x, p.y).matrixTransform(m);
          return { x: Math.round(pt.x), y: Math.round(pt.y) };
        });
      },
      grid.map((p) => ({ x: p.x * w, y: p.y * h })),
    );
  const colors = grid.map((p) => {
    const sw = cropped ? 200 : 400,
      sh = cropped ? 100 : 200,
      ox = cropped ? 100 : 0,
      oy = cropped ? 50 : 0;
    const scale =
      fit === "cover" ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
    const sx = fit === "stretch" ? w / sw : scale,
      sy = fit === "stretch" ? h / sh : scale;
    const x = (p.x * w - (w - sw * sx) / 2) / sx,
      y = (p.y * h - (h - sh * sy) / 2) / sy;
    if (x < 0 || x >= sw || y < 0 || y >= sh) return [255, 255, 255];
    if (y + oy < 50) return [0, 0, 0];
    if (y + oy >= 150) return [255, 255, 255];
    return [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ][Math.min(3, Math.floor((x + ox) / 100))];
  });
  const expectedColors = colors.map((color) =>
    color.map((value) => Math.round(value * opacity + 255 * (1 - opacity))),
  );
  await expect
    .poll(async () => {
      const screenshot = (await page.screenshot()).toString("base64");
      return page.evaluate(
        async ({ screenshot, points, colors }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${screenshot}`;
          await image.decode();
          const c = document.createElement("canvas");
          c.width = image.width;
          c.height = image.height;
          const context = c.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return points.map((p, i) => {
            const actual = context.getImageData(p.x, p.y, 1, 1).data;
            return colors[i].every((v, j) => Math.abs(v - actual[j]) < 8);
          });
        },
        { screenshot, points, colors: expectedColors },
      );
    })
    .toEqual(grid.map(() => true));
}
for (const theme of ["light", "dark"] as const)
  test(`image fitting pixels match wide and tall frames with and without crop in ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await start(page);
    await chooseTheme(page, theme);
    await number(page, "x", 100);
    await number(page, "y", 70);
    for (const cropped of [false, true]) {
      if (cropped) {
        const crop = page.getByRole("form", {
          name: "画像のトリミング",
          exact: true,
        });
        for (const [name, value] of [
          ["cropX", "25"],
          ["cropY", "25"],
          ["cropWidth", "50"],
          ["cropHeight", "50"],
        ])
          await crop.locator(`[name="${name}"]`).fill(value);
        await crop
          .getByRole("button", { name: "切出しを適用", exact: true })
          .click();
      }
      for (const [w, h] of [
        [240, 90],
        [90, 240],
      ]) {
        await number(page, "width", w);
        await number(page, "height", h);
        for (const fit of ["contain", "cover", "stretch"]) {
          await applyFit(page, fit);
          await pixels(page, w, h, fit, cropped);
        }
      }
    }
  });
test("fit drafts, Undo, clipboard and archive preserve modes, crop and original bytes", async ({
  page,
}) => {
  const bytes = await start(page);
  const selector = fitForm(page).getByRole("combobox");
  await selector.selectOption("cover");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(selector).toHaveValue("cover");
  await fitForm(page)
    .getByRole("button", { name: "表示方式を適用", exact: true })
    .click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(selector).toHaveValue("contain");
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(selector).toHaveValue("cover");
  const crop = page.getByRole("form", {
    name: "画像のトリミング",
    exact: true,
  });
  await crop.locator('[name="cropX"]').fill("25");
  await crop.locator('[name="cropWidth"]').fill("50");
  await crop.getByRole("button", { name: "切出しを適用", exact: true }).click();
  await selectPanel(page, "レイヤー");
  await page.locator("button[data-layer-id]").first().click();
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await canvas.focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".sheet > svg > [data-object-id]")).toHaveCount(2);
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const packed = await readFile((await (await pending).path())!);
  const result = await page.evaluate(async (raw) => {
    const path = "/src/lib/project-package.ts",
      { readProjectFile } = await import(path);
    const candidate = await readProjectFile(new Blob([new Uint8Array(raw)]));
    const project = candidate.project;
    const originals = await Promise.all(
      project.assets.map(async (a: any) =>
        Array.from(
          new Uint8Array(await candidate.store.blob(a.sha256).arrayBuffer()),
        ),
      ),
    );
    candidate.store.dispose();
    return { project, originals };
  }, Array.from(packed));
  expect(result.project.manifest.schemaVersion).toBe("0.29.0");
  expect(
    result.project.screens[0].objects.map((object: any) => object.shape),
  ).toEqual([
    expect.objectContaining({
      fit: "cover",
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    }),
    expect.objectContaining({
      fit: "cover",
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    }),
  ]);
  expect(result.originals).toEqual([Array.from(bytes)]);
});

test("cover fitting preserves rotation and applies placement opacity once", async ({
  page,
}) => {
  await start(page);
  await number(page, "x", 100);
  await number(page, "y", 100);
  await number(page, "width", 140);
  await number(page, "height", 200);
  await applyFit(page, "cover");
  await number(page, "回転角度", 37);
  await number(page, "不透明度（%）", 50);
  await pixels(page, 140, 200, "cover", false, 0.5);
});
