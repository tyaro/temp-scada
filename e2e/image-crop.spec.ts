import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const cropFrame = (p: Page) =>
  p.locator(".sheet > svg > [data-object-id] [data-image-crop]");
const form = (p: Page) =>
  p.getByRole("form", { name: "画像のトリミング", exact: true });
async function source(p: Page, mime = "image/png", transparent = false) {
  return Buffer.from(
    await p.evaluate(
      ({ mime, transparent }) => {
        const c = document.createElement("canvas");
        c.width = 240;
        c.height = 120;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#e75840";
        ctx.fillRect(0, 0, 120, 120);
        ctx.fillStyle = "#1e9f85";
        ctx.fillRect(120, 0, 120, transparent ? 60 : 120);
        return c.toDataURL(mime, 1).split(",")[1];
      },
      { mime, transparent },
    ),
    "base64",
  );
}
async function place(p: Page, bytes: Buffer, name = "crop.png") {
  const chooser = p.waitForEvent("filechooser");
  await fileCommand(p, "画像を配置");
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: name.endsWith("jpg") ? "image/jpeg" : "image/png",
    buffer: bytes,
  });
  await expect(p.locator(".sheet [data-image-frame]")).toHaveCount(1);
}
async function start(p: Page, transparent = false) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await fileCommand(p, "新しいProject");
  const bytes = await source(p, "image/png", transparent);
  await place(p, bytes);
  return bytes;
}
async function crop(p: Page, x = "50", y = "0", w = "50", h = "100") {
  for (const [name, value] of [
    ["cropX", x],
    ["cropY", y],
    ["cropWidth", w],
    ["cropHeight", h],
  ])
    await form(p).locator(`input[name="${name}"]`).fill(value);
  await button(p, "切出しを適用").click();
}
async function save(p: Page) {
  const waiting = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  const d = await waiting;
  return readFile((await d.path())!);
}
async function unpack(p: Page, bytes: Buffer) {
  return p.evaluate(
    async (bytes) => {
      const path = "/src/lib/project-package.ts",
        { readProjectFile } = await import(path);
      const candidate = await readProjectFile(
        new Blob([new Uint8Array(bytes)]),
      );
      const project = candidate.project;
      const originals = await Promise.all(
        project.assets.map(async (a: any) => [
          ...new Uint8Array(await candidate.store.blob(a.sha256).arrayBuffer()),
        ]),
      );
      candidate.store.dispose();
      return { project, originals };
    },
    [...bytes],
  );
}
async function load(p: Page, bytes: Buffer) {
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "crop.bantoscada",
    mimeType: "application/zip",
    buffer: bytes,
  });
  const replacement = p.getByRole("dialog", {
    name: "Project を置き換えますか",
    exact: true,
  });
  await expect(
    replacement.or(
      p
        .getByTestId("project-status")
        .filter({ hasText: "Project を読み込みました。" }),
    ),
  ).toBeVisible();
  if (await replacement.isVisible())
    await replacement
      .getByRole("button", { name: "破棄して開く", exact: true })
      .click();
  await expect(p.getByTestId("project-status")).toContainText(
    "Project を読み込みました。",
  );
}
async function replace(p: Page, bytes: Buffer, name = "replacement.png") {
  const chooser = p.waitForEvent("filechooser");
  await button(p, "画像を差し替え…").click();
  await (
    await chooser
  ).setFiles({ name, mimeType: "image/png", buffer: bytes });
}
async function pixels(p: Page, points: { x: number; y: number }[]) {
  const encoded = (await p.screenshot()).toString("base64");
  return p.evaluate(
    async ({ encoded, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return points.map(({ x, y }) => [
        ...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      ]);
    },
    { encoded, points },
  );
}
async function framePoints(p: Page, coords: number[][]) {
  return p
    .locator(".sheet > svg > [data-object-id]")
    .first()
    .evaluate((el, coords) => {
      const matrix = el.getScreenCTM()!;
      return coords.map(([x, y]) => {
        const point = new DOMPoint(x, y).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      });
    }, coords);
}
for (const theme of ["light", "dark"])
  test(`non-destructive crop clips letterbox, preserves frame and originals with history/package in ${theme}`, async ({
    page: p,
  }) => {
    const original = await start(p);
    await chooseTheme(p, theme);
    const before = (await unpack(p, await save(p))).project;
    await crop(p);
    await expect(cropFrame(p)).toHaveAttribute("viewBox", "120 0 120 120");
    const points = await framePoints(p, [
      [10, 60],
      [120, 60],
      [230, 60],
    ]);
    await expect
      .poll(() => pixels(p, points))
      .toEqual([
        [255, 255, 255, 255],
        [30, 159, 133, 255],
        [255, 255, 255, 255],
      ]);
    const archive = await save(p),
      after = await unpack(p, archive);
    expect(after.originals).toEqual([[...original]]);
    expect(after.project.screens[0].objects[0]).toEqual({
      ...before.screens[0].objects[0],
      shape: {
        ...before.screens[0].objects[0].shape,
        crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
      },
    });
    await button(p, "元に戻す").click();
    await expect(cropFrame(p)).toHaveCount(0);
    await button(p, "やり直す").click();
    await expect(cropFrame(p)).toHaveCount(1);
    await button(p, "選択図形を複製").click();
    await expect(cropFrame(p)).toHaveCount(2);
    await load(p, archive);
    await expect(cropFrame(p)).toHaveCount(1);
    await selectPanel(p, "レイヤー");
    await p.locator("button[data-layer-id]").first().click();
    await p.getByLabel("回転角度", { exact: true }).fill("37");
    await p.getByLabel("回転角度", { exact: true }).press("Enter");
    const y = Number(await p.getByLabel("y", { exact: true }).inputValue());
    await button(p, "切出し範囲の比率に合わせる").click();
    await expect(p.getByLabel("height", { exact: true })).toHaveValue("240");
    await expect(p.getByLabel("y", { exact: true })).toHaveValue(
      String(y - 60),
    );
    await expect(p.getByLabel("回転角度", { exact: true })).toHaveValue("37");
  });
test("crop draft is explicit, invalid preview disappears, Escape and target transition preserve input", async ({
  page: p,
}) => {
  await start(p);
  const x = form(p).locator('[name="cropX"]');
  await x.fill("50");
  await form(p).locator('[name="cropWidth"]').fill("0");
  await p.getByLabel("x", { exact: true }).focus();
  await expect(cropFrame(p)).toHaveCount(0);
  await expect(form(p).getByRole("status")).toBeVisible();
  await expect(form(p).getByLabel("切出し結果", { exact: true })).toHaveCount(
    0,
  );
  await button(p, "表示プレビュー").click();
  await expect(
    p.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
  ).toBeVisible();
  await button(p, "キャンセル").click();
  await expect(x).toHaveValue("50");
  await x.press("Escape");
  await expect(x).toHaveValue("0");
  await expect(form(p).getByRole("status")).toHaveCount(0);
  await crop(p);
  await button(p, "原本全体へ戻す").click();
  await expect(cropFrame(p)).toHaveCount(1);
  await button(p, "切出しを適用").click();
  await expect(cropFrame(p)).toHaveCount(0);
});
test("replacement keeps crop for same bytes and clears it atomically for different bytes", async ({
  page: p,
}) => {
  const original = await start(p);
  await crop(p);
  const before = (await unpack(p, await save(p))).project;
  await replace(p, original, "alias.png");
  await expect(button(p, "画像を差し替え…")).toBeEnabled();
  expect((await unpack(p, await save(p))).project).toEqual(before);
  await replace(p, await source(p, "image/png", true));
  await expect(cropFrame(p)).toHaveCount(0);
  await button(p, "元に戻す").click();
  await expect(cropFrame(p)).toHaveAttribute("viewBox", "120 0 120 120");
});
test("crop draft can explicitly apply before replacement without invalidating the authorized request", async ({
  page: p,
}) => {
  await start(p);
  await form(p).locator('[name="cropX"]').fill("50");
  await form(p).locator('[name="cropWidth"]').fill("50");
  const oldHref = await p
    .locator(".sheet [data-image-frame]")
    .getAttribute("href");
  await replace(p, await source(p, "image/png", true));
  await button(p, "適用して続行").click();
  await expect(p.locator(".sheet [data-image-frame]")).not.toHaveAttribute(
    "href",
    oldHref!,
  );
  await expect(cropFrame(p)).toHaveCount(0);
  await button(p, "元に戻す").click();
  await expect(cropFrame(p)).toHaveCount(1);
});
test("crop changed and reverted during decode invalidates a pending replacement", async ({
  page: p,
}) => {
  await start(p);
  await crop(p);
  const oldHref = await p
    .locator(".sheet [data-image-frame]")
    .getAttribute("href");
  const next = await source(p, "image/png", true);
  await p.evaluate(() => {
    const original = createImageBitmap;
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeCropImage = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
  await replace(p, next);
  await expect
    .poll(() => p.evaluate(() => typeof (window as any).resumeCropImage))
    .toBe("function");
  await crop(p, "0", "0", "50", "100");
  await crop(p);
  await p.evaluate(() => (window as any).resumeCropImage());
  await expect(button(p, "画像を差し替え…")).toBeEnabled();
  await expect(p.locator(".sheet [data-image-frame]")).toHaveAttribute(
    "href",
    oldHref!,
  );
  await expect(cropFrame(p)).toHaveAttribute("viewBox", "120 0 120 120");
});
test("transparent PNG keeps alpha within crop while the original still travels through clipboard", async ({
  page: p,
}) => {
  const original = await start(p, true);
  await crop(p);
  const points = await framePoints(p, [
    [120, 30],
    [120, 90],
  ]);
  await expect
    .poll(() => pixels(p, points))
    .toEqual([
      [30, 159, 133, 255],
      [255, 255, 255, 255],
    ]);
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await p.getByLabel("キャンバス操作領域", { exact: true }).focus();
  await p.keyboard.press("Control+c");
  await expect
    .poll(() =>
      p.evaluate(async () =>
        (await navigator.clipboard.readText()).includes('"version":2'),
      ),
    )
    .toBe(true);
  const text = await p.evaluate(() => navigator.clipboard.readText());
  await fileCommand(p, "新しいProject");
  await p
    .getByLabel("キャンバス操作領域", { exact: true })
    .evaluate((el, text) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, text);
  await expect(cropFrame(p)).toHaveCount(1);
  const after = await unpack(p, await save(p));
  expect(after.originals).toEqual([[...original]]);
  expect(after.project.screens[0].objects[0].shape.crop).toEqual({
    x: 0.5,
    y: 0,
    width: 0.5,
    height: 1,
  });
});
test("EXIF-oriented JPEG crops in display coordinates", async ({ page: p }) => {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await fileCommand(p, "新しいProject");
  const jpeg = await source(p, "image/jpeg");
  // APP1 Exif, little-endian TIFF, orientation=6 (90 degrees clockwise).
  const exif = Buffer.from([
    0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
    0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
  ]);
  await place(
    p,
    Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]),
    "oriented.jpg",
  );
  await expect(p.getByText(/原本：oriented.jpg/)).toContainText("120 × 240");
  await crop(p, "0", "50", "100", "50");
  await expect(cropFrame(p)).toHaveAttribute("viewBox", "0 120 120 120");
  const point = await framePoints(p, [[60, 120]]);
  const colors = await pixels(p, point);
  expect(colors[0][0]).toBeLessThan(40);
  expect(colors[0][1]).toBeGreaterThan(150);
  expect(colors[0][2]).toBeGreaterThan(120);
});
for (const fit of ["contain", "cover", "stretch"] as const)
  test(`embedded View, minimap and preview Popup share cropped ${fit} painting`, async ({
    page: p,
  }) => {
    await start(p);
    await crop(p);
    const fitForm = p.getByRole("form", {
      name: "画像の表示方式",
      exact: true,
    });
    await fitForm.getByRole("combobox").selectOption(fit);
    await fitForm
      .getByRole("button", { name: "表示方式を適用", exact: true })
      .click();
    const archive = await save(p);
    const bytes = await p.evaluate(
      async (bytes) => {
        const path = "/src/lib/project-package.ts",
          { readProjectFile, writeProjectPackage } = await import(path);
        const candidate = await readProjectFile(
            new Blob([new Uint8Array(bytes)]),
          ),
          project = candidate.project;
        const sourceId = project.screens[0].id;
        project.screens.unshift({
          id: "temporary-host-id",
          name: "埋込先",
          width: 1280,
          height: 720,
          background: "#ffffff",
          folders: [],
          groups: [],
          objects: [],
        });
        // Use the application's UUID v7 generator for contract-valid IDs.
        const editorPath = "/src/lib/editor.ts",
          { newId } = await import(editorPath);
        project.screens[0].id = newId();
        project.screens[0].objects.push({
          id: newId(),
          order: 0,
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          rotation: 0,
          shape: { type: "screenView", screenId: sourceId, fit: "contain" },
        });
        const blob = await writeProjectPackage(project, candidate.store);
        candidate.store.dispose();
        return {
          bytes: [...new Uint8Array(await blob.arrayBuffer())],
          sourceId,
        };
      },
      [...archive],
    );
    await load(p, Buffer.from(bytes.bytes));
    await expect(
      p.locator(".sheet [data-source-object-id] [data-image-crop]"),
    ).toHaveAttribute("viewBox", "120 0 120 120");
    await expect(
      p.locator('[aria-label="ミニマップ"] [data-image-crop]'),
    ).toHaveCount(1);
    await expect(
      p.locator(".sheet [data-source-object-id] [data-image-fit]"),
    ).toHaveAttribute("data-image-fit", fit);
    await expect(
      p.locator('[aria-label="ミニマップ"] [data-image-fit]'),
    ).toHaveAttribute("data-image-fit", fit);
    await button(p, "表示プレビュー").click();
    await button(p, "画面を小窓で表示確認").click();
    const dialog = p.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await dialog.locator(`input[value="${bytes.sourceId}"]`).check();
    await dialog
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    await expect(
      p.locator(`[data-preview-popup="${bytes.sourceId}"] [data-image-crop]`),
    ).toHaveAttribute("viewBox", "120 0 120 120");
    await expect(
      p.locator(`[data-preview-popup="${bytes.sourceId}"] [data-image-fit]`),
    ).toHaveAttribute("data-image-fit", fit);
  });
