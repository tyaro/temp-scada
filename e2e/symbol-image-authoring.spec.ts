import { test, expect, type Page } from "@playwright/test";
import {
  mainCanvas,
  fileCommand,
  selectPanel,
  chooseTheme,
} from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
import { pngFixture } from "./helpers/images";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const images = (p: Page) => mainCanvas(p).locator("image[data-image-frame]");
const viewport = (p: Page) =>
  p.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function definition(p: Page) {
  await selectPanel(p, "プロジェクト");
  await button(p, "定義を編集").click();
}
async function start(p: Page) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await openProject(p, "examples/symbol-image.bantoscada");
  await definition(p);
  return pngFixture(p, {
    width: 240,
    height: 120,
    rectangles: [{ x: 0, y: 0, width: 240, height: 120, color: "#279f85" }],
  });
}
async function place(p: Page, bytes: Buffer) {
  const chooser = p.waitForEvent("filechooser");
  await fileCommand(p, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "共有設備.png", mimeType: "image/png", buffer: bytes });
}
async function saved(p: Page) {
  const bytes = await downloadBytes(await downloadProject(p));
  return p.evaluate(
    async (bytes) => {
      const path = "/src/lib/project-package.ts";
      const { readProjectFile } = await import(path);
      const result = await readProjectFile(new Blob([new Uint8Array(bytes)]));
      try {
        return {
          project: result.project,
          originals: await Promise.all(
            result.project.assets.map(async (asset: any) => ({
              hash: asset.sha256,
              bytes: [
                ...new Uint8Array(
                  await result.store.blob(asset.sha256).arrayBuffer(),
                ),
              ],
            })),
          ),
        };
      } finally {
        result.store.dispose();
      }
    },
    [...bytes],
  );
}
for (const theme of ["light", "dark"])
  test(`definition image import, fit/crop, replacement, lock and Undo in ${theme}`, async ({
    page: p,
  }) => {
    const bytes = await start(p);
    await chooseTheme(p, theme);
    await place(p, bytes);
    await expect(images(p)).toHaveCount(2);
    const fit = p.getByRole("combobox", {
      name: "画像の表示方式",
      exact: true,
    });
    await fit.selectOption("cover");
    await button(p, "表示方式を適用").click();
    const crop = p.getByRole("form", { name: "画像のトリミング", exact: true });
    await crop.locator('[name="cropWidth"]').fill("50");
    await button(p, "切出しを適用").click();
    let result = await saved(p);
    const object = result.project.symbols[0].objects.at(-1)!;
    expect(object.shape).toMatchObject({
      type: "image",
      fit: "cover",
      crop: { width: 0.5, height: 1 },
    });
    expect(result.project.assets).toHaveLength(2);
    expect(
      result.originals.some((a) => Buffer.from(a.bytes).equals(bytes)),
    ).toBe(true);
    await selectPanel(p, "レイヤー");
    await p.locator(`[data-layer-id="${object.id}"]`).click();
    await button(p, "ロック：image · 3").click();
    await expect(fit).toBeDisabled();
    await expect(button(p, "画像を差し替え…")).toBeDisabled();
    await button(p, "ロックを解除").click();
    const replacement = await pngFixture(p, {
      width: 100,
      height: 100,
      rectangles: [{ x: 0, y: 0, width: 100, height: 100, color: "#e75840" }],
    });
    const chooser = p.waitForEvent("filechooser");
    await button(p, "画像を差し替え…").click();
    await (
      await chooser
    ).setFiles({
      name: "交換設備.png",
      mimeType: "image/png",
      buffer: replacement,
    });
    await expect(
      p.getByText("原本：交換設備.png", { exact: false }),
    ).toBeVisible();
    result = await saved(p);
    expect(result.project.symbols[0].objects.at(-1)!.shape).not.toHaveProperty(
      "crop",
    );
    expect(
      result.originals.some((a) => Buffer.from(a.bytes).equals(replacement)),
    ).toBe(true);
    expect(
      result.originals.some((a) => Buffer.from(a.bytes).equals(bytes)),
    ).toBe(false);
    await button(p, "元に戻す").click();
    await expect(
      p.getByText("原本：共有設備.png", { exact: false }),
    ).toBeVisible();
    await expect(crop.locator('[name="cropWidth"]')).toHaveValue("50");
    if (process.env.SCADA_SCREENSHOT_DIR)
      await p.screenshot({
        path: `${process.env.SCADA_SCREENSHOT_DIR}/symbol-image-authoring-${theme}.png`,
      });
    await button(p, "画面へ戻る").click();
    await expect(images(p)).toHaveCount(2);
    await button(p, "表示プレビュー").click();
    await expect(images(p)).toHaveCount(2);
  });
test("raw image paste and child-image clipboard reuse originals across definition and screen", async ({
  page: p,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const bytes = await start(p);
  await viewport(p).focus();
  await p.evaluate(
    (data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(data)], "貼付設備.png", { type: "image/png" }),
      );
      document.activeElement!.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    },
    [...bytes],
  );
  await expect(images(p)).toHaveCount(2);
  await viewport(p).focus();
  await p.keyboard.press("Control+c");
  await expect(p.getByTestId("project-status")).toContainText("コピーしました");
  await p.keyboard.press("Control+v");
  await expect(images(p)).toHaveCount(3);
  expect((await saved(p)).project.assets).toHaveLength(2);
  await button(p, "元に戻す").click();
  await expect(images(p)).toHaveCount(2);
  await button(p, "画面へ戻る").click();
  await viewport(p).focus();
  await p.keyboard.press("Control+v");
  await expect(images(p)).toHaveCount(3);
  const result = await saved(p);
  expect(result.project.assets).toHaveLength(2);
  expect(result.originals.some((a) => Buffer.from(a.bytes).equals(bytes))).toBe(
    true,
  );
});
for (const replacing of [false, true])
  test(`late definition image ${replacing ? "replacement" : "placement"} stays cancelled after leaving and returning`, async ({
    page: p,
  }) => {
    const bytes = await start(p);
    if (replacing) {
      await selectPanel(p, "レイヤー");
      await p
        .locator('[data-layer-id="0199fc00-0000-7000-8000-000000000004"]')
        .click();
    }
    await p.evaluate(() => {
      const decode = window.createImageBitmap;
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      window.createImageBitmap = async (
        ...args: Parameters<typeof createImageBitmap>
      ) => {
        await new Promise<void>(
          (resolve) => ((window as any).releaseImage = resolve),
        );
        window.createImageBitmap = decode;
        return decode(...args);
      };
      crypto.subtle.digest = async (...args) => {
        const result = await digest(...args);
        (window as any).imageHashed = true;
        return result;
      };
    });
    if (replacing) {
      const chooser = p.waitForEvent("filechooser");
      await button(p, "画像を差し替え…").click();
      await (
        await chooser
      ).setFiles({ name: "遅延.png", mimeType: "image/png", buffer: bytes });
    } else await place(p, bytes);
    await expect
      .poll(() => p.evaluate(() => typeof (window as any).releaseImage))
      .toBe("function");
    await button(p, "画面へ戻る").click();
    await definition(p);
    await p.evaluate(() => (window as any).releaseImage());
    await expect
      .poll(() => p.evaluate(() => (window as any).imageHashed))
      .toBe(true);
    await expect(images(p)).toHaveCount(1);
    const result = await saved(p);
    expect(result.project.assets).toHaveLength(1);
    expect(result.project.symbols[0].objects).toHaveLength(3);
    await expect(button(p, "元に戻す")).toBeDisabled();
  });

test("definition crop draft survives cancelled navigation and does not submit during IME", async ({
  page: p,
}) => {
  const bytes = await start(p);
  await place(p, bytes);
  await expect(images(p)).toHaveCount(2);
  const crop = p.getByRole("form", { name: "画像のトリミング", exact: true });
  const width = crop.locator('[name="cropWidth"]');
  await width.fill("60");
  await button(p, "画面へ戻る").click();
  await expect(
    p.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
  ).toBeVisible();
  await button(p, "キャンセル").click();
  await expect(width).toHaveValue("60");
  await width.dispatchEvent("compositionstart");
  await width.fill("40");
  await width.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(mainCanvas(p).locator("[data-image-crop]")).toHaveCount(0);
  await width.dispatchEvent("compositionend");
  await button(p, "切出しを適用").click();
  await expect(mainCanvas(p).locator("[data-image-crop]")).toHaveCount(1);
  await button(p, "元に戻す").click();
  await expect(mainCanvas(p).locator("[data-image-crop]")).toHaveCount(0);
  await expect(images(p)).toHaveCount(2);
});
