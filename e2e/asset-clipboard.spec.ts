import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const objects = (p: Page) => p.locator(".sheet > svg [data-object-id]");
const images = (p: Page) => p.locator(".sheet > svg image[data-image-frame]");
const viewport = (p: Page) =>
  p.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await fileCommand(page, "新しいProject");
}
async function rawImage(page: Page, color = "#80bfff") {
  await page.evaluate((color) => {
    const c = document.createElement("canvas");
    c.width = 80;
    c.height = 40;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 80, 40);
    c.toBlob((blob) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob!], "設備.png", { type: "image/png" }));
      document
        .querySelector('[aria-label="キャンバス操作領域"]')!
        .dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
    });
  }, color);
}
async function fixture(page: Page) {
  await start(page);
  await rawImage(page);
  await expect(images(page)).toHaveCount(1);
  await page.getByLabel("配置名", { exact: true }).fill("設備画像");
  await button(page, "変更を適用").click();
  await selectPanel(page, "部品");
  await button(page, "Rectangle を追加").click();
  await button(page, "ポンプを追加").click();
  await expect(objects(page)).toHaveCount(3);
  await viewport(page).focus();
  await page.keyboard.press("Control+a");
}
async function copy(page: Page) {
  await viewport(page).focus();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("project-status")).toContainText(
    "コピーしました",
  );
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text).version).toBe(2);
  return text;
}
async function empty(page: Page) {
  await fileCommand(page, "新しいProject");
  const replace = page.getByRole("button", {
    name: "破棄して開く",
    exact: true,
  });
  if (await replace.isVisible()) await replace.click();
  await expect(objects(page)).toHaveCount(0);
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await wait;
  const data = await readFile((await file.path())!);
  if (file.suggestedFilename() === "project.json")
    return JSON.parse(data.toString());
  return page.evaluate(async (data) => {
    const path = "/src/lib/project-package.ts";
    const { readProjectFile } = await import(path);
    const r = await readProjectFile(new Blob([new Uint8Array(data)]));
    r.store.dispose();
    return r.project;
  }, Array.from(data));
}
for (const theme of ["light", "dark"])
  test(`mixed image clipboard restores originals, names and Symbol dependencies in a fresh browser in ${theme}`, async ({
    page,
    browser,
  }) => {
    await fixture(page);
    await chooseTheme(page, theme);
    const text = await copy(page),
      fragment = JSON.parse(text);
    expect(fragment.images).toHaveLength(1);
    expect(fragment.project.symbols).toHaveLength(1);
    expect(fragment.project.screens[0].backgroundImage).toBeUndefined();
    const ctx = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        permissions: ["clipboard-read", "clipboard-write"],
      }),
      other = await ctx.newPage();
    await start(other);
    await viewport(other).focus();
    await other.keyboard.press("Control+v");
    await expect(objects(other)).toHaveCount(3);
    await expect(images(other)).toHaveCount(1);
    const first = await saved(other);
    expect(first.assets).toHaveLength(1);
    expect(first.symbols).toHaveLength(1);
    expect(
      first.screens[0].objects.find((o: any) => o.shape.type === "image").name,
    ).toBe("設備画像");
    expect(first.assets[0].id).not.toBe(fragment.project.assets[0].id);
    const original = await images(other).evaluate(async (el) =>
      Array.from(
        new Uint8Array(
          await (await fetch(el.getAttribute("href")!)).arrayBuffer(),
        ),
      ),
    );
    expect(Buffer.from(original).toString("base64")).toBe(
      fragment.images[0].data,
    );
    await viewport(other).focus();
    await other.keyboard.press("Control+v");
    await expect(objects(other)).toHaveCount(6);
    const second = await saved(other);
    expect(second.assets).toHaveLength(1);
    await button(other, "元に戻す").click();
    await expect(objects(other)).toHaveCount(3);
    await button(other, "やり直す").click();
    await expect(objects(other)).toHaveCount(6);
    await ctx.close();
  });
test("native cut writes a complete image fragment before removal and one Undo restores all originals", async ({
  page,
}) => {
  await fixture(page);
  await viewport(page).focus();
  await page.keyboard.press("Control+x");
  await expect(objects(page)).toHaveCount(0);
  const fragment = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(fragment.version).toBe(2);
  expect(fragment.images).toHaveLength(1);
  await button(page, "元に戻す").click();
  await expect(objects(page)).toHaveCount(3);
  await expect(images(page)).toHaveCount(1);
  await viewport(page).focus();
  await page.keyboard.press("Control+v");
  await expect(objects(page)).toHaveCount(6);
  expect((await saved(page)).assets).toHaveLength(1);
});
test("denied and unsupported async image copy preserve the clipboard, source and history", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("keep");
    navigator.clipboard.write = async () => {
      throw new Error("denied");
    };
  });
  await viewport(page).focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("project-status")).toContainText("denied");
  await expect(objects(page)).toHaveCount(3);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep",
  );
  await page.evaluate(() => {
    (window as any).ClipboardItem = undefined;
  });
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("project-status")).toContainText(
    "対応していません",
  );
  await expect(objects(page)).toHaveCount(3);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep",
  );
});
test("cut becomes copy-only when editing changes during an asynchronous clipboard write", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    navigator.clipboard.write = async (items) => {
      (window as any).copiedSnapshot = await (
        await items[0].getType("text/plain")
      ).text();
      await new Promise<void>(
        (resolve) => ((window as any).releaseWrite = resolve),
      );
    };
  });
  await viewport(page).focus();
  await page.keyboard.press("Control+x");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseWrite))
    .toBe("function");
  await selectPanel(page, "レイヤー");
  await button(page, "設備画像").click();
  const x = page.getByLabel("x", { exact: true });
  await x.fill("150");
  await x.press("Enter");
  await page.evaluate(() => (window as any).releaseWrite());
  await expect(page.getByTestId("project-status")).toContainText(
    "切り取りは中止",
  );
  await expect(objects(page)).toHaveCount(3);
  const copied = await page.evaluate(() =>
    JSON.parse((window as any).copiedSnapshot),
  );
  expect(
    copied.project.screens[0].objects.find((o: any) => o.shape.type === "image")
      .x,
  ).not.toBe(150);
  await expect(x).toHaveValue("150");
});
test("corrupt originals and destination capacity failure reject the entire mixed paste atomically", async ({
  page,
}) => {
  await fixture(page);
  await rawImage(page, "#ff9980");
  await expect(images(page)).toHaveCount(2);
  await viewport(page).focus();
  await page.keyboard.press("Control+a");
  const text = await copy(page);
  await empty(page);
  const bad = JSON.parse(text);
  bad.project.assets[0].sha256 = bad.images[0].sha256 = "0".repeat(64);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    JSON.stringify(bad),
  );
  await viewport(page).focus();
  await page.keyboard.press("Control+v");
  await expect(page.getByTestId("project-status")).toContainText("宣言");
  await expect(objects(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.evaluate(async () => {
    const path = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/src\/lib\/image-assets\.ts(?:\?|$)/.test(name))!;
    const { AssetStore } = await import(path);
    const original = AssetStore.prototype.importFrom;
    let calls = 0;
    AssetStore.prototype.importFrom = function (...args: any[]) {
      (window as any).destinationStore = this;
      if (++calls === 2) throw new Error("容量不足の検証");
      return original.apply(this, args);
    };
    (window as any).restoreImport = () => {
      AssetStore.prototype.importFrom = original;
    };
  });
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+v");
  await expect(page.getByTestId("project-status")).toContainText("容量不足");
  await expect(objects(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).assets).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => (window as any).destinationStore.count))
    .toBe(0);
  await page.evaluate(() => (window as any).restoreImport());
  await viewport(page).focus();
  await page.keyboard.press("Control+v");
  await expect(objects(page)).toHaveCount(4);
  expect((await saved(page)).assets).toHaveLength(2);
});
test("nested Symbol fragments are rejected in a shared definition, and late verification cannot revive after a mode round trip", async ({
  page,
}) => {
  await fixture(page);
  const text = await copy(page);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await viewport(page).focus();
  await page.keyboard.press("Control+v");
  await expect(page.getByTestId("project-status")).toContainText(
    "Symbol定義には埋込画面",
  );
  await expect(images(page)).toHaveCount(0);
  // Use a separate clean Project for the delayed validation boundary.
  await empty(page);
  await page.evaluate(() => {
    const original = window.createImageBitmap,
      digest = crypto.subtle.digest.bind(crypto.subtle);
    window.createImageBitmap = async (
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      await new Promise<void>(
        (resolve) => ((window as any).releaseVerify = resolve),
      );
      return (original as any)(...args);
    };
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).verified = true;
      return result;
    };
  });
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await viewport(page).focus();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseVerify))
    .toBe("function");
  await button(page, "表示プレビュー").click();
  await button(page, "編集").click();
  await page.evaluate(() => (window as any).releaseVerify());
  await expect
    .poll(() => page.evaluate(() => (window as any).verified))
    .toBe(true);
  await expect(objects(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
