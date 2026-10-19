import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const images = (p: Page) => p.locator(".sheet > svg image[data-image-frame]");
const viewport = (p: Page) =>
  p.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await fileCommand(page, "新しいProject");
  await viewport(page).focus();
}
async function bytes(page: Page, mime = "image/png") {
  return page.evaluate(async (mime) => {
    const c = document.createElement("canvas");
    c.width = 80;
    c.height = 40;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(0,128,255,0.5)";
    ctx.fillRect(0, 0, 80, 40);
    return Array.from(
      new Uint8Array(
        await (
          await new Promise<Blob>((r) => c.toBlob((b) => r(b!), mime))
        ).arrayBuffer(),
      ),
    );
  }, mime);
}
async function nativePaste(
  page: Page,
  data: number[],
  options: {
    text?: string;
    count?: number;
    mime?: string;
    target?: string;
  } = {},
) {
  return page.evaluate(
    ({ data, options }) => {
      const transfer = new DataTransfer();
      if (options.text !== undefined)
        transfer.setData("text/plain", options.text);
      for (let i = 0; i < (options.count ?? 1); i++)
        transfer.items.add(
          new File([new Uint8Array(data)], `貼付${i}.png`, {
            type: options.mime ?? "image/png",
          }),
        );
      const e = new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      document
        .querySelector(options.target ?? '[aria-label="キャンバス操作領域"]')!
        .dispatchEvent(e);
      return e.defaultPrevented;
    },
    { data, options },
  );
}
async function systemImage(page: Page) {
  const data = await bytes(page);
  await page.evaluate(async (data) => {
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(data)], { type: "image/png" }),
      }),
    ]);
  }, data);
  return page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (
          await (await navigator.clipboard.read())[0].getType("image/png")
        ).arrayBuffer(),
      ),
    ),
  );
}
async function archived(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const path = (await (await wait).path())!;
  const archive = await readFile(path);
  return page.evaluate(async (data) => {
    const source = "/src/lib/project-package.ts";
    const { readProjectFile } = await import(source);
    const candidate = await readProjectFile(new Blob([new Uint8Array(data)]));
    const project = candidate.project;
    candidate.store.dispose();
    return project;
  }, Array.from(archive));
}
for (const theme of ["light", "dark"])
  test(`native Ctrl+V keeps delivered PNG bytes and transparency, repeats share the asset and undo in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    const delivered = await systemImage(page);
    await viewport(page).focus();
    await page.keyboard.press("Control+v");
    await expect(images(page)).toHaveCount(1);
    expect(
      await images(page).evaluate(async (el) =>
        Array.from(
          new Uint8Array(
            await (await fetch(el.getAttribute("href")!)).arrayBuffer(),
          ),
        ),
      ),
    ).toEqual(delivered);
    const alpha = await images(page).evaluate(async (el) => {
      const img = await createImageBitmap(
        await (await fetch(el.getAttribute("href")!)).blob(),
      );
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = 40;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      img.close();
      return ctx.getImageData(40, 20, 1, 1).data[3];
    });
    expect(alpha).toBe(128);
    await viewport(page).focus();
    await page.keyboard.press("Control+v");
    await expect(images(page)).toHaveCount(2);
    const project = await archived(page);
    expect(project.assets).toHaveLength(1);
    expect(project.screens[0].objects).toHaveLength(2);
    await button(page, "元に戻す").click();
    await expect(images(page)).toHaveCount(1);
    await button(page, "やり直す").click();
    await expect(images(page)).toHaveCount(2);
  });
test("menu paste reads an image only on demand and handles denied read with an actionable message", async ({
  page,
}) => {
  await start(page);
  await systemImage(page);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name: "貼り付け", exact: true })
    .click();
  await expect(images(page)).toHaveCount(1);
  await page.evaluate(() => {
    navigator.clipboard.read = async () => {
      throw new Error("denied");
    };
  });
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name: "貼り付け", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText(
    "Ctrl／Command＋V",
  );
  await expect(images(page)).toHaveCount(1);
});
test("SCADA text wins over attached raster; malformed SCADA is rejected without falling back to an image", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  const text = await page.evaluate(async () => {
    const source = "/src/lib/clipboard.ts",
      create = "/src/lib/new-project.ts",
      editor = "/src/lib/editor.ts";
    const { copyObjects } = await import(source),
      { createProject } = await import(create),
      { applyCommand } = await import(editor);
    let p = createProject();
    p = applyCommand(
      p,
      { type: "add", screenId: p.screens[0].id, kind: "rectangle" },
      "edit",
    );
    return copyObjects(
      p,
      p.screens[0].id,
      [p.screens[0].objects[0].id],
      "other",
    );
  });
  await nativePaste(page, data, { text });
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(1);
  await expect(images(page)).toHaveCount(0);
  await nativePaste(page, data, { text: '{"format":"banto-scada.objects",' });
  await expect(page.getByTestId("project-status")).toContainText(
    "クリップボード操作に失敗",
  );
  await expect(images(page)).toHaveCount(0);
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(1);
  await nativePaste(page, data, { text: "画像の説明" });
  await expect(images(page)).toHaveCount(1);
});
test("multiple, unsupported and corrupt images leave placements and Undo untouched; JPEG is accepted", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  await nativePaste(page, data, { count: 2 });
  await expect(page.getByTestId("project-status")).toContainText("1枚ずつ");
  await nativePaste(page, data, { mime: "image/gif" });
  await expect(page.getByTestId("project-status")).toContainText("PNG／JPEG");
  await nativePaste(page, [1, 2, 3]);
  await expect(page.getByTestId("project-status")).toContainText(
    "画像取込エラー",
  );
  await expect(images(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await nativePaste(page, await bytes(page, "image/jpeg"), {
    mime: "image/jpeg",
  });
  await expect(images(page)).toHaveCount(1);
  const project = await archived(page);
  expect(project.assets[0].mime).toBe("image/jpeg");
});
test("paste is not intercepted in inputs or preview, and image paste in Symbol definitions gives a reason", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  await nativePaste(page, data);
  await expect(images(page)).toHaveCount(1);
  await page.getByLabel("配置名", { exact: true }).fill("keep draft");
  expect(await nativePaste(page, data, { target: 'input[name="name"]' })).toBe(
    false,
  );
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "keep draft",
  );
  await expect(images(page)).toHaveCount(1);
  await page.getByLabel("配置名", { exact: true }).press("Escape");
  await button(page, "変更を適用").click();
  await button(page, "表示プレビュー").click();
  expect(await nativePaste(page, data)).toBe(false);
  await expect(images(page)).toHaveCount(1);
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await nativePaste(page, data);
  await expect(page.getByTestId("project-status")).toContainText(
    "Symbol定義には画像を貼り付けできません",
  );
  await expect(images(page)).toHaveCount(0);
});
test("an image awaiting decode cannot revive after leaving and returning to the same screen scope", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  await page.evaluate(() => {
    const bitmap = window.createImageBitmap,
      digest = crypto.subtle.digest.bind(crypto.subtle);
    window.createImageBitmap = async (
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      await new Promise<void>(
        (resolve) => ((window as any).releasePaste = resolve),
      );
      return (bitmap as any)(...args);
    };
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).pasteHashed = true;
      return result;
    };
  });
  await nativePaste(page, data);
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releasePaste))
    .toBe("function");
  await button(page, "表示プレビュー").click();
  await button(page, "編集").click();
  await page.evaluate(() => (window as any).releasePaste());
  await expect
    .poll(() => page.evaluate(() => (window as any).pasteHashed))
    .toBe(true);
  await expect(images(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("paste captures event data before draft confirmation; cancel preserves input and discard resumes the same image", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  await nativePaste(page, data);
  await expect(images(page)).toHaveCount(1);
  await page.getByLabel("配置名", { exact: true }).fill("未適用の名前");
  await nativePaste(page, data);
  const dialog = page.getByRole("dialog").filter({ hasText: "未適用" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(images(page)).toHaveCount(1);
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await nativePaste(page, data);
  await dialog
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(images(page)).toHaveCount(2);
  const project = await archived(page);
  expect(project.assets).toHaveLength(1);
  expect(project.screens[0].objects.every((o: any) => !o.name)).toBe(true);
});
test("delayed menu clipboard read cannot resume after leaving and returning to the same mode", async ({
  page,
}) => {
  await start(page);
  const data = await bytes(page);
  await page.evaluate((data) => {
    navigator.clipboard.read = async () => {
      await new Promise<void>(
        (resolve) => ((window as any).releaseRead = resolve),
      );
      (window as any).readComplete = true;
      return [
        new ClipboardItem({
          "image/png": new Blob([new Uint8Array(data)], { type: "image/png" }),
        }),
      ];
    };
  }, data);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name: "貼り付け", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseRead))
    .toBe("function");
  await button(page, "表示プレビュー").click();
  await button(page, "編集").click();
  await page.evaluate(() => (window as any).releaseRead());
  await expect
    .poll(() => page.evaluate(() => (window as any).readComplete))
    .toBe(true);
  await expect(images(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
