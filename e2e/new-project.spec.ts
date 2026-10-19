import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { fileCommand, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const state = (page: Page) => page.getByTestId("save-state");
const replacement = (page: Page) =>
  page.getByRole("dialog", { name: "Project を置き換えますか", exact: true });
const draft = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
async function exported(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+Shift+s");
  const download = await downloading;
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}
test("new blank project is an editable clean baseline, exports current schema and has independent IDs", async ({
  page,
}) => {
  await page.goto("/");
  await fileCommand(page, "新しいProject");
  await expect(page.locator("h1")).toHaveText("新しいProject");
  await expect(button(page, "編集")).toHaveAttribute("aria-pressed", "true");
  const canvas = page.getByRole("img", { name: "画面1", exact: true });
  await expect(canvas.locator("[data-object-id]")).toHaveCount(0);
  await expect(state(page)).toContainText("新しいProject・未書き出し");
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(true);
  await selectPanel(page, "部品");
  await button(page, "Rectangle を追加").click();
  await expect(state(page)).toContainText("未書き出しの変更あり");
  await button(page, "元に戻す").click();
  await expect(state(page)).toContainText("新しいProject・未書き出し");
  const first = await exported(page);
  expect(first.manifest.schemaVersion).toBe("0.11.0");
  expect(first.screens).toHaveLength(1);
  expect(first.screens[0]).toMatchObject({
    name: "画面1",
    width: 960,
    height: 540,
    background: "#ffffff",
    objects: [],
  });
  expect(first.symbols).toEqual([]);
  await page.keyboard.press("Control+n");
  await expect(state(page)).toContainText("新しいProject・未書き出し");
  await expect(button(page, "元に戻す")).toBeDisabled();
  const second = await exported(page);
  expect(second.manifest.projectId).not.toBe(first.manifest.projectId);
  expect(second.screens[0].id).not.toBe(first.screens[0].id);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "new.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(first)),
  });
  await expect(state(page)).toContainText("読込後の変更なし");
  await expect(canvas.locator("[data-object-id]")).toHaveCount(0);
});

test("new-project cancellation preserves drafts and selection; applying input still requires content replacement", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  const rectangle = page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true });
  await rectangle.click();
  const color = page.getByLabel("色", { exact: true });
  await color.fill("#aabbcc");
  await page.keyboard.press("Control+n");
  await expect(draft(page)).toBeVisible();
  await draft(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(color).toHaveValue("#aabbcc");
  await expect(rectangle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+n");
  await draft(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(replacement(page)).toBeVisible();
  await replacement(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(color).toHaveValue("#aabbcc");
  await expect(button(page, "元に戻す")).toBeEnabled();
  await page.keyboard.press("Control+n");
  await replacement(page)
    .getByRole("button", { name: "破棄して開く", exact: true })
    .click();
  await expect(page.locator("h1")).toHaveText("新しいProject");
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("Ctrl+O validates the selected file before touching a draft; chooser cancel does nothing", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  const name = page.getByRole("textbox", { name: "画面名", exact: true });
  await name.fill("編集中の画面名");
  let choosing = page.waitForEvent("filechooser");
  await name.press("Control+o");
  await (await choosing).setFiles([]);
  await expect(name).toHaveValue("編集中の画面名");
  await expect(draft(page)).toHaveCount(0);
  choosing = page.waitForEvent("filechooser");
  await name.press("Control+o");
  await (
    await choosing
  ).setFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.getByTestId("project-status")).toContainText("読込エラー");
  await expect(name).toHaveValue("編集中の画面名");
  await expect(draft(page)).toHaveCount(0);
  choosing = page.waitForEvent("filechooser");
  await name.press("Control+o");
  await (
    await choosing
  ).setFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(draft(page)).toBeVisible();
  await draft(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(name).toHaveValue("プロセス画面");
  await expect(state(page)).toContainText("読込後の変更なし");
});

test("file shortcuts respect modal, IME, repeat and shifted-key boundaries", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await button(page, "タグを選択").click();
  const modal = page.getByRole("dialog", { name: "タグを選択", exact: true });
  const search = modal.getByLabel("タグ候補を検索", { exact: true });
  const events = await search.evaluate((el) =>
    ["n", "o", "s"].map((key) => {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      return el.dispatchEvent(event);
    }),
  );
  expect(events).toEqual([false, false, false]);
  await expect(modal).toBeVisible();
  await expect(page.locator("h1")).toHaveText(sample.manifest.name);
  await search.press("Escape");
  await page.evaluate(() => {
    for (const flags of [
      { isComposing: true },
      { repeat: true },
      { shiftKey: true },
    ])
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          ctrlKey: true,
          ...flags,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  await expect(page.locator("h1")).toHaveText(sample.manifest.name);
  await expect(state(page)).toContainText("サンプルからの変更なし");
});

test("a newer completed file read wins over an older delayed read", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const original = File.prototype.text;
    (window as any).releaseFile = null;
    File.prototype.text = function () {
      if (this.name === "slow.json")
        return new Promise<string>((resolve) => {
          (window as any).releaseFile = async () =>
            resolve(await original.call(this));
        });
      return original.call(this);
    };
  });
  const input = page.getByLabel("Project JSON を開く", { exact: true });
  const old = structuredClone(sample),
    latest = structuredClone(sample);
  old.manifest.name = "古い非同期読み込み";
  latest.manifest.name = "新しい読み込み";
  await input.setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(old)),
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseFile))
    .toBe("function");
  // Simulate a second native change arriving before the first promise settles.
  await input.evaluate((el, content) => {
    const files = new DataTransfer();
    files.items.add(
      new File([content], "latest.json", { type: "application/json" }),
    );
    (el as HTMLInputElement).files = files.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, JSON.stringify(latest));
  await expect(page.locator("h1")).toHaveText("新しい読み込み");
  await page.evaluate(async () => {
    await (window as any).releaseFile();
    await new Promise(requestAnimationFrame);
  });
  await expect(page.locator("h1")).toHaveText("新しい読み込み");
  await expect(state(page)).toContainText("読込後の変更なし");
});
