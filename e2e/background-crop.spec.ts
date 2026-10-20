import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { pngFixture } from "./helpers/images";
import { chooseTheme, fileCommand, mainCanvas } from "./helpers/designer";
const cropForm = (page: Page) =>
  page.getByRole("form", { name: "背景画像のトリミング", exact: true });
async function upload(page: Page, bytes: Buffer) {
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "background.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
  await expect(mainCanvas(page).locator("[data-background-image]")).toHaveCount(
    1,
  );
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const project: any = structuredClone(sample);
  Object.assign(project.screens[0], {
    width: 240,
    height: 160,
    background: "#ffffff",
    objects: [],
  });
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "background.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
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
  await upload(page, bytes);
  return bytes;
}
async function crop(page: Page) {
  for (const [name, value] of [
    ["cropX", "25"],
    ["cropY", "25"],
    ["cropWidth", "50"],
    ["cropHeight", "50"],
  ])
    await cropForm(page).locator(`[name="${name}"]`).fill(value);
  await cropForm(page)
    .getByRole("button", { name: "背景の切出しを適用", exact: true })
    .click();
}
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const bytes = await readFile((await (await pending).path())!);
  return page.evaluate(async (raw) => {
    const path = "/src/lib/project-package.ts",
      { readProjectFile } = await import(path),
      candidate = await readProjectFile(new Blob([new Uint8Array(raw)])),
      project = candidate.project;
    const originals = await Promise.all(
      project.assets.map(async (a: any) =>
        Array.from(
          new Uint8Array(await candidate.store.blob(a.sha256).arrayBuffer()),
        ),
      ),
    );
    candidate.store.dispose();
    return { project, originals };
  }, Array.from(bytes));
}
const grid = [0.13, 0.37, 0.63, 0.87].flatMap((x) =>
  [0.13, 0.37, 0.63, 0.87].map((y) => ({ x: x * 240, y: y * 160 })),
);
async function pixels(page: Page, fit: string, opacity: number) {
  const points = await mainCanvas(page).evaluate(
    (el, grid) =>
      grid.map((p) => {
        const point = new DOMPoint(p.x, p.y).matrixTransform(
          (el as SVGSVGElement).getScreenCTM()!,
        );
        return { x: Math.round(point.x), y: Math.round(point.y) };
      }),
    grid,
  );
  const colors = grid.map((p) => {
    const scale =
        fit === "original"
          ? 1
          : fit === "cover"
            ? Math.max(240 / 200, 160 / 100)
            : Math.min(240 / 200, 160 / 100),
      sx = fit === "stretch" ? 240 / 200 : scale,
      sy = fit === "stretch" ? 160 / 100 : scale;
    const x = (p.x - (240 - 200 * sx) / 2) / sx,
      y = (p.y - (160 - 100 * sy) / 2) / sy;
    const color =
      x < 0 || x >= 200 || y < 0 || y >= 100
        ? [255, 255, 255]
        : x < 100
          ? [0, 255, 0]
          : [0, 0, 255];
    return color.map((v) => Math.round(v * opacity + 255 * (1 - opacity)));
  });
  await expect
    .poll(async () => {
      const encoded = (await page.screenshot()).toString("base64");
      return page.evaluate(
        async ({ encoded, points, colors }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const c = document.createElement("canvas");
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          return points.map((p, i) => {
            const rgba = ctx.getImageData(p.x, p.y, 1, 1).data;
            return colors[i].every((v, j) => Math.abs(v - rgba[j]) < 8);
          });
        },
        { encoded, points, colors },
      );
    })
    .toEqual(grid.map(() => true));
}
for (const theme of ["light", "dark"] as const)
  test(`background crop uses cropped pixels in all four fitting modes and composites once in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await crop(page);
    for (const fit of ["contain", "cover", "stretch", "original"]) {
      await page
        .getByLabel("背景画像の表示方法", { exact: true })
        .selectOption(fit);
      await page
        .getByLabel("背景画像の不透明度（%）", { exact: true })
        .fill("50");
      await page
        .getByRole("button", { name: "背景画像の設定を適用", exact: true })
        .click();
      await expect(
        mainCanvas(page).locator("[data-background-crop]"),
      ).toHaveCount(1);
      await pixels(page, fit, 0.5);
    }
    await expect(page.locator(".sheet [data-object-id]")).toHaveCount(0);
  });
test("background crop drafts, same-hash and different-hash imports preserve intended settings and Undo", async ({
  page,
}) => {
  const bytes = await start(page);
  await crop(page);
  const before = await save(page);
  await upload(page, bytes);
  await expect(page.getByTestId("project-status")).not.toContainText(
    "画像取込エラー",
  );
  expect(await save(page)).toEqual(before);
  await cropForm(page).locator('[name="cropWidth"]').fill("40");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(cropForm(page).locator('[name="cropWidth"]')).toHaveValue("40");
  await cropForm(page).locator('[name="cropWidth"]').press("Escape");
  await expect(cropForm(page).locator('[name="cropWidth"]')).toHaveValue("50");
  const other = await pngFixture(page, {
    width: 400,
    height: 200,
    rectangles: [{ x: 0, y: 0, width: 400, height: 200, color: "#123456" }],
  });
  await upload(page, other);
  const after = await save(page);
  expect(after.project.screens[0].backgroundImage).toEqual({
    assetId: expect.any(String),
    fit: "contain",
    opacity: 1,
  });
  expect(after.originals).toEqual([Array.from(other)]);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  const undo = await save(page);
  expect(undo.project.screens[0].backgroundImage).toEqual(
    before.project.screens[0].backgroundImage,
  );
  expect(undo.originals).toEqual([Array.from(bytes)]);
});
async function stall(page: Page) {
  await page.evaluate(() => {
    const original = createImageBitmap;
    (window as any).resumeBackground = undefined;
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeBackground = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
}
async function beginDelayed(page: Page, bytes: Buffer) {
  await page
    .getByLabel("背景画像を取り込む", { exact: true })
    .setInputFiles({ name: "late.png", mimeType: "image/png", buffer: bytes });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resumeBackground))
    .toBe("function");
}
async function resume(page: Page) {
  await page.evaluate(() => (window as any).resumeBackground());
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
}
test("crop changed and undone during background decode permanently invalidates the old import", async ({
  page,
}) => {
  const bytes = await start(page);
  await crop(page);
  const before = await save(page);
  const other = await pngFixture(page, {
    width: 400,
    height: 200,
    rectangles: [{ x: 0, y: 0, width: 400, height: 200, color: "#246810" }],
  });
  await stall(page);
  await beginDelayed(page, other);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await resume(page);
  const result = await save(page);
  expect(result.project.screens[0].backgroundImage).toEqual(
    before.project.screens[0].backgroundImage,
  );
  expect(result.originals).toEqual([Array.from(bytes)]);
});
test("background fit changes during decode survive and do not cancel replacement", async ({
  page,
}) => {
  await start(page);
  await crop(page);
  await page
    .getByLabel("背景画像の表示方法", { exact: true })
    .selectOption("cover");
  await page
    .getByRole("button", { name: "背景画像の設定を適用", exact: true })
    .click();
  const other = await pngFixture(page, {
    width: 400,
    height: 200,
    rectangles: [{ x: 0, y: 0, width: 400, height: 200, color: "#135790" }],
  });
  await stall(page);
  await beginDelayed(page, other);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await resume(page);
  const result = await save(page);
  expect(result.project.screens[0].backgroundImage.fit).toBe("contain");
  expect(result.project.screens[0].backgroundImage).not.toHaveProperty("crop");
  expect(result.originals).toEqual([Array.from(other)]);
});
test("a background crop draft can apply before same-original import without cancelling the authorized request", async ({
  page,
}) => {
  const bytes = await start(page);
  await crop(page);
  await cropForm(page).locator('[name="cropWidth"]').fill("40");
  await page
    .getByLabel("背景画像を取り込む", { exact: true })
    .setInputFiles({ name: "same.png", mimeType: "image/png", buffer: bytes });
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("project-status")).not.toContainText(
    "画像取込エラー",
  );
  const result = await save(page);
  expect(result.project.screens[0].backgroundImage.crop).toEqual({
    x: 0.25,
    y: 0.25,
    width: 0.4,
    height: 0.5,
  });
  expect(result.originals).toEqual([Array.from(bytes)]);
});
test("cropped original background is shared by embedded screen, minimap and preview window", async ({
  page,
}) => {
  await start(page);
  await crop(page);
  await page
    .getByLabel("背景画像の表示方法", { exact: true })
    .selectOption("original");
  await page
    .getByRole("button", { name: "背景画像の設定を適用", exact: true })
    .click();
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const archive = await readFile((await (await pending).path())!);
  const loaded = await page.evaluate(async (raw) => {
    const packagePath = "/src/lib/project-package.ts",
      { readProjectFile, writeProjectPackage } = await import(packagePath);
    const editorPath = "/src/lib/editor.ts",
      { newId } = await import(editorPath);
    const candidate = await readProjectFile(new Blob([new Uint8Array(raw)])),
      project = candidate.project,
      sourceId = project.screens[0].id;
    project.screens.unshift({
      id: newId(),
      name: "背景の埋込先",
      width: 960,
      height: 540,
      background: "#ffffff",
      folders: [],
      groups: [],
      objects: [
        {
          id: newId(),
          order: 0,
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          rotation: 0,
          shape: { type: "screenView", screenId: sourceId, fit: "contain" },
        },
      ],
    });
    const blob = await writeProjectPackage(project, candidate.store);
    candidate.store.dispose();
    return {
      sourceId,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    };
  }, Array.from(archive));
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "embedded-background.bantoscada",
    mimeType: "application/zip",
    buffer: Buffer.from(loaded.bytes),
  });
  await expect(page.getByLabel("Project を開く", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    mainCanvas(page).locator("[data-background-crop] > svg"),
  ).toHaveAttribute("viewBox", "100 50 200 100");
  await expect(
    mainCanvas(page).locator("[data-background-crop]"),
  ).toHaveAttribute("transform", "translate(20 30)");
  await expect(
    page.locator('[aria-label="ミニマップ"] [data-background-crop] > svg'),
  ).toHaveAttribute("viewBox", "100 50 200 100");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await dialog.locator(`input[value="${loaded.sourceId}"]`).check();
  await dialog.getByRole("button", { name: "小窓を表示", exact: true }).click();
  await expect(
    page.locator(
      `[data-preview-popup="${loaded.sourceId}"] [data-background-crop] > svg`,
    ),
  ).toHaveAttribute("viewBox", "100 50 200 100");
});
