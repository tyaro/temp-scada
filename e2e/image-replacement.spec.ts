import { pngFixture } from "./helpers/images";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
import { test, expect, type Page } from "@playwright/test";
import {
  mainCanvas,
  chooseTheme,
  fileCommand,
  selectPanel,
} from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const picture = (p: Page, id: string) =>
  mainCanvas(p).locator(`:scope > [data-object-id="${id}"] [data-image-frame]`);
async function png(p: Page, color = "#e75840", width = 240, height = 120) {
  return pngFixture(p, {
    width,
    height,
    rectangles: [{ x: 0, y: 0, width, height, color }],
  });
}
async function start(p: Page) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await fileCommand(p, "新しいProject");
  const original = await png(p),
    next = await png(p, "#1e9f85", 80, 360),
    chooser = p.waitForEvent("filechooser");
  await fileCommand(p, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "original.png", mimeType: "image/png", buffer: original });
  await expect(p.locator(".sheet [data-image-frame]")).toHaveCount(1);
  const id = (await mainCanvas(p)
    .locator(":scope > [data-object-id]")
    .first()
    .getAttribute("data-object-id"))!;
  return { id, original, next };
}
async function replace(p: Page, bytes: Buffer, name = "replacement.png") {
  const chooser = p.waitForEvent("filechooser");
  await button(p, "画像を差し替え…").click();
  await (
    await chooser
  ).setFiles({ name, mimeType: "image/png", buffer: bytes });
}
async function saved(p: Page) {
  const download = await downloadProject(p),
    bytes = await downloadBytes(download);
  if (download.suggestedFilename().endsWith(".json"))
    return { project: JSON.parse(bytes.toString()), archive: bytes };
  const result = await p.evaluate(
    async (bytes) => {
      const path = "/src/lib/project-package.ts";
      const { readProjectFile } = await import(path);
      const result = await readProjectFile(new Blob([new Uint8Array(bytes)]));
      const originals = await Promise.all(
        result.project.assets.map(async (asset: any) => ({
          sha256: asset.sha256,
          bytes: [
            ...new Uint8Array(
              await result.store.blob(asset.sha256).arrayBuffer(),
            ),
          ],
        })),
      );
      const project = result.project;
      result.store.dispose();
      return { project, originals };
    },
    [...bytes],
  );
  return { ...result, archive: bytes };
}
async function select(p: Page, id: string) {
  await selectPanel(p, "レイヤー");
  await p.locator(`button[data-layer-id="${id}"]`).click();
}
async function delayDecode(p: Page) {
  await p.evaluate(() => {
    const original = createImageBitmap,
      digest = crypto.subtle.digest.bind(crypto.subtle);
    (window as any).hashDone = false;
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).hashDone = true;
      return result;
    };
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeImage = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
}
async function resume(p: Page) {
  await p.evaluate(() => (window as any).resumeImage());
  await expect
    .poll(() => p.evaluate(() => (window as any).hashDone))
    .toBe(true);
}
for (const theme of ["light", "dark"])
  test(`replacement preserves placement, shared background and copies, Undo and portable originals in ${theme}`, async ({
    page: p,
  }) => {
    const { id, original, next } = await start(p);
    await chooseTheme(p, theme);
    for (const [name, value] of [
      ["回転角度", "31"],
      ["不透明度（%）", "45"],
    ] as const) {
      const input = p.getByLabel(name, { exact: true });
      await input.fill(value);
      await input.press("Enter");
    }
    await button(p, "選択図形を複製").click();
    await selectPanel(p, "プロジェクト");
    let chooser = p.waitForEvent("filechooser");
    await button(p, "背景画像を選択…").click();
    await (
      await chooser
    ).setFiles({
      name: "same-background.png",
      mimeType: "image/png",
      buffer: original,
    });
    await expect(
      p.locator(".sheet > svg > [data-background-image]"),
    ).toBeAttached();
    await select(p, id);
    const before = (await saved(p)).project,
      oldHref = await picture(p, id).getAttribute("href");
    await replace(p, next);
    await expect(picture(p, id)).not.toHaveAttribute("href", oldHref!);
    await expect(p.getByText(/原本：replacement.png/)).toBeVisible();
    const snapshot = await saved(p),
      after = snapshot.project,
      old = before.screens[0].objects[0],
      updated = after.screens[0].objects[0];
    expect(updated).toEqual({
      ...old,
      shape: { ...old.shape, assetId: updated.shape.assetId },
    });
    expect(updated.shape.assetId).not.toBe(old.shape.assetId);
    expect(after.screens[0].objects[1]).toEqual(before.screens[0].objects[1]);
    expect(after.screens[0].backgroundImage).toEqual(
      before.screens[0].backgroundImage,
    );
    expect(after.assets).toHaveLength(2);
    expect(snapshot.originals.map((o: any) => o.bytes)).toEqual(
      expect.arrayContaining([[...original], [...next]]),
    );
    await button(p, "元に戻す").click();
    await expect(picture(p, id)).toHaveAttribute("href", oldHref!);
    await button(p, "やり直す").click();
    await expect(picture(p, id)).not.toHaveAttribute("href", oldHref!);
    await openProject(p, {
      name: "replacement.bantoscada",
      mimeType: "application/zip",
      buffer: snapshot.archive,
    });
    expect((await saved(p)).project.screens).toEqual(after.screens);
  });
test("same bytes keep declaration and history; invalid images and locked placements cannot replace", async ({
  page: p,
}) => {
  const { id, original } = await start(p),
    before = (await saved(p)).project;
  await replace(p, original, "alias.png");
  await expect(button(p, "画像を差し替え…")).toBeEnabled();
  expect((await saved(p)).project).toEqual(before);
  await replace(p, Buffer.from("invalid png"));
  await expect(p.getByTestId("project-status")).toContainText("画像取込エラー");
  expect((await saved(p)).project).toEqual(before);
  await select(p, id);
  await button(p, "ロック：image · 0").click();
  await expect(button(p, "画像を差し替え…")).toBeDisabled();
});
test("unapplied name is protected before replacement and continues after explicit apply", async ({
  page: p,
}) => {
  const { id, next } = await start(p),
    oldHref = await picture(p, id).getAttribute("href");
  await p.getByLabel("配置名", { exact: true }).fill("更新後の写真");
  await replace(p, next);
  const prompt = p.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await button(p, "キャンセル").click();
  await expect(picture(p, id)).toHaveAttribute("href", oldHref!);
  await expect(p.getByLabel("配置名", { exact: true })).toHaveValue(
    "更新後の写真",
  );
  await replace(p, next);
  await button(p, "適用して続行").click();
  await expect(picture(p, id)).not.toHaveAttribute("href", oldHref!);
  expect((await saved(p)).project.screens[0].objects[0].name).toBe(
    "更新後の写真",
  );
});
for (const change of ["selection", "mode", "project"])
  test(`late image replacement is discarded after ${change} changes`, async ({
    page: p,
  }) => {
    const { id, next } = await start(p);
    await button(p, "選択図形を複製").click();
    const other = (await p
      .locator(".sheet > svg > [data-object-id]")
      .last()
      .getAttribute("data-object-id"))!;
    await select(p, id);
    const before = (await saved(p)).project;
    await delayDecode(p);
    await replace(p, next);
    await expect
      .poll(() => p.evaluate(() => typeof (window as any).resumeImage))
      .toBe("function");
    if (change === "selection") {
      await select(p, other);
      await select(p, id);
    } else if (change === "mode") {
      await button(p, "表示プレビュー").click();
      await button(p, "編集").click();
      await select(p, id);
    } else {
      await p.keyboard.press("Control+n");
      await expect(
        p.getByRole("heading", { name: "新しいProject", exact: true }),
      ).toBeVisible();
    }
    await resume(p);
    if (change !== "project") {
      await expect(button(p, "画像を差し替え…")).toBeEnabled();
      expect((await saved(p)).project).toEqual(before);
    } else {
      expect((await saved(p)).project.assets).toEqual([]);
      await expect(p.locator(".sheet [data-image-frame]")).toHaveCount(0);
    }
  });

test("geometry committed during replacement decode survives and does not cancel the image request", async ({
  page: p,
}) => {
  const { id, next } = await start(p);
  const before = (await saved(p)).project.screens[0].objects[0];
  const oldHref = await picture(p, id).getAttribute("href");
  await delayDecode(p);
  await replace(p, next);
  await expect
    .poll(() => p.evaluate(() => typeof (window as any).resumeImage))
    .toBe("function");
  const x = p.locator('form[data-editor-form="object"] input[name="x"]');
  await x.fill(String(before.x + 37));
  await x.press("Enter");
  await expect(x).toHaveValue(String(before.x + 37));
  await resume(p);
  await expect(picture(p, id)).not.toHaveAttribute("href", oldHref!);
  const after = (await saved(p)).project.screens[0].objects[0];
  expect(after.shape.assetId).not.toBe(before.shape.assetId);
  expect(after).toEqual({
    ...before,
    x: before.x + 37,
    shape: { ...before.shape, assetId: after.shape.assetId },
  });
  await button(p, "元に戻す").click();
  await expect(picture(p, id)).toHaveAttribute("href", oldHref!);
  expect((await saved(p)).project.screens[0].objects[0]).toEqual({
    ...before,
    x: before.x + 37,
  });
  await button(p, "元に戻す").click();
  expect((await saved(p)).project.screens[0].objects[0]).toEqual(before);
});
test("image originals follow Redo truncation and the 50-snapshot retention boundary", async ({
  page: p,
}) => {
  const { id, next } = await start(p);
  const image = picture(p, id);
  const originalUrl = (await image.getAttribute("href"))!;
  const readable = (src: string) =>
    p.evaluate(async (src) => {
      try {
        return (await fetch(src)).ok;
      } catch {
        return false;
      }
    }, src);
  await replace(p, next);
  await expect(image).not.toHaveAttribute("href", originalUrl);
  const redoOnlyUrl = (await image.getAttribute("href"))!;
  await button(p, "元に戻す").click();
  await expect(image).toHaveAttribute("href", originalUrl);
  expect(await readable(redoOnlyUrl)).toBe(true);
  await p.getByLabel("グリッドにスナップ", { exact: true }).uncheck();
  const frame = p.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await frame.focus();
  await p.keyboard.press("ArrowRight");
  await expect(button(p, "やり直す")).toBeDisabled();
  await expect.poll(() => readable(redoOnlyUrl)).toBe(false);
  expect(await readable(originalUrl)).toBe(true);
  await replace(p, next);
  await expect(image).not.toHaveAttribute("href", originalUrl);
  const currentUrl = (await image.getAttribute("href"))!;
  expect(currentUrl).not.toBe(redoOnlyUrl);
  const object = mainCanvas(p).locator(`:scope > [data-object-id="${id}"]`);
  const position = () =>
    object.evaluate((g) => {
      const matrix = (g as SVGGElement).transform.baseVal.consolidate()!.matrix;
      return { x: matrix.e, y: matrix.f };
    });
  const before = await position();
  await frame.focus();
  for (let i = 0; i < 49; i++) await p.keyboard.press("ArrowRight");
  await expect.poll(position).toEqual({ x: before.x + 49, y: before.y });
  expect(await readable(originalUrl)).toBe(true);
  await p.keyboard.press("ArrowRight");
  await expect.poll(position).toEqual({ x: before.x + 50, y: before.y });
  await expect.poll(() => readable(originalUrl)).toBe(false);
  expect(await readable(currentUrl)).toBe(true);
  const output = await saved(p);
  expect(output.originals!.map((a) => Buffer.from(a.bytes))).toEqual([next]);
});
