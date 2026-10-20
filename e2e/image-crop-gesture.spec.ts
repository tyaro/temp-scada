import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand } from "./helpers/designer";
import { pngFixture } from "./helpers/images";
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => expect(runtimeErrors.get(page)).toEqual([]));
const form = (p: Page, background = false) =>
  p.getByRole("form", {
    name: background ? "背景画像のトリミング" : "画像のトリミング",
    exact: true,
  });
async function start(p: Page, background = false) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await fileCommand(p, "新しいProject");
  const bytes = await pngFixture(p, {
    width: 400,
    height: 200,
    rectangles: [
      { x: 0, y: 0, width: 200, height: 200, color: "#e75840" },
      { x: 200, y: 0, width: 200, height: 200, color: "#1e9f85" },
    ],
  });
  if (background)
    await p.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
      name: "source.png",
      mimeType: "image/png",
      buffer: bytes,
    });
  else {
    const pending = p.waitForEvent("filechooser");
    await fileCommand(p, "画像を配置");
    await (
      await pending
    ).setFiles({ name: "source.png", mimeType: "image/png", buffer: bytes });
  }
  await form(p, background)
    .getByRole("button", { name: "範囲をマウスで調整", exact: true })
    .click();
  const close = p.locator(".toast-host button.close");
  while (await close.count()) await close.first().click();
  return form(p, background);
}
async function point(f: Locator, x: number, y: number) {
  return f.locator("[data-crop-selection]").evaluate(
    (el, p) => {
      const svg = el as SVGSVGElement;
      const q = new DOMPoint(
        p.x * svg.viewBox.baseVal.width,
        p.y * svg.viewBox.baseVal.height,
      ).matrixTransform(svg.getScreenCTM()!);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function drag(
  p: Page,
  f: Locator,
  from: [number, number],
  to: [number, number],
  release = true,
) {
  await f.locator("[data-crop-selection]").scrollIntoViewIfNeeded();
  const a = await point(f, ...from),
    b = await point(f, ...to);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  await p.mouse.move(b.x, b.y, { steps: 4 });
  if (release) await p.mouse.up();
}
async function values(f: Locator) {
  return f
    .locator(".fields input")
    .evaluateAll((els) =>
      els.map((e) => Number((e as HTMLInputElement).value)),
    );
}
async function saved(p: Page) {
  const pending = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  const bytes = await readFile((await (await pending).path())!);
  return p.evaluate(
    async (raw) => {
      const path = "/src/lib/project-package.ts",
        { readProjectFile } = await import(path);
      const candidate = await readProjectFile(new Blob([new Uint8Array(raw)]));
      const result = candidate.project;
      candidate.store.dispose();
      return result;
    },
    [...bytes],
  );
}
for (const theme of ["light", "dark"] as const)
  test(`${theme}: draw, move, resize and keyboard remain draft until one apply/Undo`, async ({
    page,
  }) => {
    const f = await start(page);
    await chooseTheme(page, theme);
    await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
    await drag(page, f, [0.25, 0.25], [0.75, 0.75]);
    const v = await values(f);
    for (let i = 0; i < 4; i++)
      expect(v[i]).toBeCloseTo([25, 25, 50, 50][i], 1);
    await expect(page.locator(".sheet [data-image-crop]")).toHaveCount(0);
    await drag(page, f, [0.5, 0.5], [0.6, 0.6]);
    const moved = await values(f);
    expect(moved[0]).toBeCloseTo(35, 1);
    expect(moved[1]).toBeCloseTo(35, 1);
    const handle = f.getByRole("button", {
      name: "切出し範囲の右下を変更",
      exact: true,
    });
    await handle.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    const resized = await values(f);
    expect(resized[2]).toBeCloseTo(47.5, 1);
    await page.keyboard.press("ArrowUp");
    expect((await values(f))[3]).toBeCloseTo(49.5, 1);
    await f.getByRole("button", { name: "切出しを適用", exact: true }).click();
    const project = await saved(page);
    expect(project.screens[0].objects[0].shape.crop.width).toBeCloseTo(
      0.475,
      3,
    );
    expect(project.screens[0].objects[0].shape.crop.height).toBeCloseTo(
      0.495,
      3,
    );
    await page.keyboard.press("Control+z");
    await expect(page.locator(".sheet [data-image-crop]")).toHaveCount(0);
    await page.keyboard.press("Control+y");
    await expect(page.locator(".sheet [data-image-crop]")).toHaveCount(1);
  });
test("Esc, lost capture, resize and window blur preserve the exact preexisting numeric draft", async ({
  page,
}) => {
  const f = await start(page);
  await f.locator('[name="cropX"]').fill("025.00");
  await f.locator('[name="cropWidth"]').fill("50");
  await f.locator('[name="cropY"]').fill("25");
  await f.locator('[name="cropHeight"]').fill("50");
  for (const reason of ["escape", "capture", "blur", "resize"] as const) {
    await drag(page, f, [0.5, 0.5], [0.6, 0.6], false);
    await expect(f.locator("[data-crop-gesture=active]")).toHaveCount(1);
    if (reason === "escape") await page.keyboard.press("Escape");
    if (reason === "capture")
      await f
        .locator("[data-crop-selection]")
        .dispatchEvent("lostpointercapture", { pointerId: 1 });
    if (reason === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (reason === "resize")
      await f
        .locator("[data-crop-selection]")
        .evaluate((el) => ((el as SVGSVGElement).style.height = "220px"));
    await expect(f.locator("[data-crop-gesture=active]")).toHaveCount(0);
    await page.mouse.up();
    await expect(f.locator('[name="cropX"]')).toHaveValue("025.00");
    expect(await values(f)).toEqual([25, 25, 50, 50]);
  }
  await f.getByRole("button", { name: "切出しを適用", exact: true }).click();
  expect((await saved(page)).screens[0].objects[0].shape.crop).toEqual({
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
  });
});
test("letterbox starts and a click do not erase a crop; invalid numeric ranges stay repairable", async ({
  page,
}) => {
  const f = await start(page);
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  const surface = f.locator("[data-crop-selection]");
  await surface.scrollIntoViewIfNeeded();
  const bounds = (await surface.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
  await page.mouse.up();
  expect(await values(f)).toEqual([0, 0, 100, 100]);
  const center = await point(f, 0.5, 0.5);
  await page.mouse.click(center.x, center.y);
  expect(await values(f)).toEqual([0, 0, 100, 100]);
  await f.locator('[name="cropWidth"]').fill("0");
  await expect(surface).toHaveCount(0);
  await expect(f.getByRole("status")).toContainText("正の幅");
  await f.getByRole("button", { name: "原本全体へ戻す", exact: true }).click();
  await expect(surface).toBeVisible();
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  await drag(page, f, [0.75, 0.75], [0.25, 0.25]);
  expect((await values(f))[2]).toBeCloseTo(50, 1);
});
test("background uses the same selection, saves a single crop change and restores it with Undo", async ({
  page,
}) => {
  const f = await start(page, true);
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  await drag(page, f, [0.25, 0.25], [0.75, 0.75]);
  await f
    .getByRole("button", { name: "背景の切出しを適用", exact: true })
    .click();
  expect((await saved(page)).screens[0].backgroundImage.crop.width).toBeCloseTo(
    0.5,
    3,
  );
  await page.keyboard.press("Control+z");
  await expect(page.locator(".sheet [data-background-crop]")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".sheet [data-background-crop]")).toHaveCount(1);
});
test("Ctrl+S cancels an unfinished pointer candidate before saving", async ({
  page,
}) => {
  const f = await start(page);
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  await drag(page, f, [0.25, 0.25], [0.75, 0.75], false);
  await expect(f.locator("[data-crop-gesture=active]")).toHaveCount(1);
  const project = await saved(page);
  await page.mouse.up();
  expect(project.screens[0].objects[0].shape.crop).toBeUndefined();
  expect(await values(f)).toEqual([0, 0, 100, 100]);
});
test("source edges clamp a reverse draw and actual corner resize keeps the opposite edge", async ({
  page,
}) => {
  const f = await start(page);
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  await drag(page, f, [0.75, 0.75], [-0.25, 0.25]);
  const v = await values(f);
  expect(v[0]).toBe(0);
  expect(v[2]).toBeCloseTo(75, 1);
  // Right-bottom corner changes size; source left/top remain fixed.
  await drag(page, f, [0.75, 0.75], [0.5, 0.5]);
  const resized = await values(f);
  expect(resized[0]).toBe(0);
  expect(resized[1]).toBeCloseTo(25, 1);
  expect(resized[2]).toBeCloseTo(50, 1);
  expect(resized[3]).toBeCloseTo(25, 1);
  // A handle at the left source boundary remains grabbable on its outside half.
  await drag(page, f, [-0.01, 0.375], [0.1, 0.375]);
  expect((await values(f))[0]).toBeCloseTo(10, 1);
});
test("preview transition destroys the unfinished candidate without writing into a later editor", async ({
  page,
}) => {
  const f = await start(page);
  await f.getByRole("button", { name: "範囲を指定", exact: true }).click();
  await drag(page, f, [0.25, 0.25], [0.75, 0.75], false);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .evaluate((el: HTMLButtonElement) => el.click());
  await expect(f).toHaveCount(0);
  await page.mouse.up();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.locator(".sheet > svg > [data-object-id]").click();
  await expect(form(page)).toBeVisible();
  expect(await values(form(page))).toEqual([0, 0, 100, 100]);
  expect((await saved(page)).screens[0].objects[0].shape.crop).toBeUndefined();
});
