import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const rootId = "0199fe00-0000-7000-8000-000000000001";
const leafId = "0199fe00-0000-7000-8000-000000000002";
const emptyId = "0199fe00-0000-7000-8000-000000000003";
const objectId = sample.screens[0].objects[0].id;
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const folder = (page: Page, id: string) =>
  page.locator(`button[data-layer-folder="${id}"][aria-expanded]`);
async function start(page: Page, hidden = false) {
  const project: any = structuredClone(sample);
  project.screens[0].folders = [
    { id: rootId, name: "設備", order: 0 },
    { id: leafId, name: "ポンプ", order: 1, parentId: rootId },
    { id: emptyId, name: "空", order: 2 },
  ];
  project.screens[0].objects[0].folderId = leafId;
  if (hidden) project.screens[0].objects[0].visible = false;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "folders.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function action(page: Page, id: string, name: string) {
  await folder(page, id).click({ button: "right" });
  await page
    .getByRole("menu", { name: "フォルダー の操作", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
const dialog = (page: Page, name: string) =>
  page.getByRole("dialog", { name, exact: true });
async function saved(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
async function assign(page: Page) {
  await row(page, objectId).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "配置の所属を変更", exact: true })
    .click();
  return dialog(page, "配置の所属を変更");
}
test("creates and renames folders with standard keys, no-op history, validation and JSON", async ({
  page,
}) => {
  await start(page);
  await button(page, "ルートにフォルダーを作成").click();
  const create = dialog(page, "フォルダーを作成");
  await create.getByLabel("フォルダー名", { exact: true }).fill("  タンク  ");
  await create.getByLabel("親フォルダー", { exact: true }).selectOption(rootId);
  await create.getByRole("button", { name: "作成", exact: true }).click();
  const created = page
    .locator("button[data-layer-folder][aria-expanded]")
    .filter({ hasText: "タンク" });
  await expect(created).toBeVisible();
  const id = (await created.getAttribute("data-layer-folder"))!;
  await created.focus();
  await page.keyboard.press("F2");
  const rename = dialog(page, "フォルダー名を変更");
  await rename.getByLabel("フォルダー名", { exact: true }).fill("   ");
  await rename.getByRole("button", { name: "名前を変更", exact: true }).click();
  await expect(rename.getByRole("alert")).toBeVisible();
  await rename.getByLabel("フォルダー名", { exact: true }).fill("タンク");
  await rename.getByRole("button", { name: "名前を変更", exact: true }).click();
  const result = await saved(page);
  expect(result.screens[0].folders.find((f: any) => f.id === id)).toMatchObject(
    { name: "タンク", parentId: rootId },
  );
  await button(page, "元に戻す").click();
  await expect(folder(page, id)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  await expect(folder(page, id)).toBeVisible();
});
test("membership moves hidden objects explicitly and supports root, Undo and unchanged geometry", async ({
  page,
}) => {
  await start(page, true);
  await row(page, objectId).click();
  const modal = await assign(page);
  await expect(modal).toContainText("非表示 1 件");
  await modal.getByLabel("移動先", { exact: true }).selectOption(emptyId);
  await modal.getByRole("button", { name: "所属を変更", exact: true }).click();
  let result = await saved(page);
  expect(result.screens[0].objects[0]).toEqual({
    ...sample.screens[0].objects[0],
    folderId: emptyId,
    visible: false,
  });
  await button(page, "元に戻す").click();
  result = await saved(page);
  expect(result.screens[0].objects[0].folderId).toBe(leafId);
  const root = await assign(page);
  await root.getByLabel("移動先", { exact: true }).selectOption("");
  await root.getByRole("button", { name: "所属を変更", exact: true }).click();
  result = await saved(page);
  expect(result.screens[0].objects[0].folderId).toBeUndefined();
  expect(result.screens[0].objects[0].visible).toBe(false);
});
test("folder focus preserves placement selection and directs Delete to empty-folder validation", async ({
  page,
}) => {
  await start(page);
  await row(page, objectId).click();
  await folder(page, leafId).focus();
  await page.keyboard.press("Control+d");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.keyboard.press("Delete");
  const remove = dialog(page, "空のフォルダーを削除");
  await expect(remove).toContainText("配置 1 件・子フォルダー 0 件");
  await expect(
    remove.getByRole("button", { name: "削除", exact: true }),
  ).toBeDisabled();
  await remove.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(folder(page, leafId)).toBeFocused();
  await expect(row(page, objectId)).toHaveAttribute("aria-pressed", "true");
  await action(page, emptyId, "空のフォルダーを削除");
  await dialog(page, "空のフォルダーを削除")
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await expect(folder(page, emptyId)).toHaveCount(0);
  await button(page, "元に戻す").click();
  await expect(folder(page, emptyId)).toBeVisible();
});
test("search temporarily expands paths, finds empty folders, and restores disclosure", async ({
  page,
}) => {
  await start(page);
  await folder(page, rootId).click();
  await expect(row(page, objectId)).toHaveCount(0);
  const search = page.getByRole("searchbox", {
    name: "レイヤーを検索",
    exact: true,
  });
  await search.fill("ポンプ");
  await expect(row(page, objectId)).toBeVisible();
  await expect(
    page.getByText("検索結果を展開中", { exact: false }),
  ).toBeVisible();
  await button(page, "検索を解除").click();
  await expect(folder(page, rootId)).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, objectId)).toHaveCount(0);
  await search.fill("空");
  await expect(folder(page, emptyId)).toBeVisible();
  await expect(
    page.getByText("一致する配置はありません。", { exact: true }),
  ).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("folder parent selection excludes descendants and leaves drawing data unchanged", async ({
  page,
}) => {
  await start(page);
  await action(page, rootId, "親フォルダーを変更");
  const move = dialog(page, "親フォルダーを変更");
  await expect(move.getByRole("option")).toHaveCount(2);
  await move.getByLabel("親フォルダー", { exact: true }).selectOption(emptyId);
  await move.getByRole("button", { name: "親を変更", exact: true }).click();
  const result = await saved(page);
  expect(result.screens[0].folders[0].parentId).toBe(emptyId);
  expect(result.screens[0].objects[0]).toEqual({
    ...sample.screens[0].objects[0],
    folderId: leafId,
  });
  await expect(row(page, objectId)).toBeVisible();
});
test("folder dialogs protect existing drafts, IME and background shortcuts", async ({
  page,
}) => {
  await start(page);
  await row(page, objectId).click();
  await page.getByLabel("配置名", { exact: true }).fill("保持する配置名");
  await button(page, "ルートにフォルダーを作成").click();
  const guard = dialog(page, "未適用の入力があります");
  await guard.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "保持する配置名",
  );
  await button(page, "ルートにフォルダーを作成").click();
  await guard
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  const create = dialog(page, "フォルダーを作成");
  const name = create.getByLabel("フォルダー名", { exact: true });
  await name.fill("変換中");
  await name.dispatchEvent("compositionstart");
  await name.press("Enter");
  await expect(create).toBeVisible();
  await name.dispatchEvent("compositionend");
  await create.getByRole("button", { name: "作成", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+d");
  await expect(create).toBeVisible();
  await create.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "保持する配置名",
  );
  await button(page, "元に戻す").click();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue("");
});
for (const theme of ["light", "dark"] as const)
  test(`folder controls remain keyboard reachable in ${theme} at narrow width`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await folder(page, leafId).focus();
    await page.keyboard.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "子フォルダーを作成", exact: true })
      .click();
    const create = dialog(page, "フォルダーを作成");
    await expect(
      create.getByLabel("親フォルダー", { exact: true }),
    ).toHaveValue(leafId);
    await create.getByLabel("フォルダー名", { exact: true }).fill("計器");
    const confirm = create.getByRole("button", { name: "作成", exact: true });
    async function contrast() {
      return confirm.evaluate((element) => {
        const css = getComputedStyle(element);
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return (
            channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          );
        };
        const a = luminance(css.color),
          b = luminance(css.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    }
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await confirm.hover();
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await confirm.click();
    await expect(
      page
        .locator("button[data-layer-folder][aria-expanded]")
        .filter({ hasText: "計器" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("locked membership is unavailable while folder organization remains independent", async ({
  page,
}) => {
  await start(page);
  await row(page, objectId).click();
  await button(page, "ロック：rectangle · 3").click();
  await row(page, objectId).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "配置の所属を変更", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await folder(page, leafId).focus();
  await page.keyboard.press("F2");
  const rename = dialog(page, "フォルダー名を変更");
  await rename
    .getByLabel("フォルダー名", { exact: true })
    .fill("ロックとは独立した整理");
  await rename.getByRole("button", { name: "名前を変更", exact: true }).click();
  const result = await saved(page);
  expect(result.screens[0].objects[0].locked).toBe(true);
  expect(result.screens[0].objects[0].folderId).toBe(leafId);
  expect(result.screens[0].folders[1].name).toBe("ロックとは独立した整理");
});
test("canvas selection opens ancestry while collapsing and searching preserve Inspector drafts", async ({
  page,
}) => {
  await start(page);
  await folder(page, rootId).click();
  await page
    .locator(`.sheet > svg [data-object-id="${objectId}"]`)
    .click({ position: { x: 30, y: 30 } });
  await expect(folder(page, rootId)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, objectId)).toHaveAttribute("aria-pressed", "true");
  // Explicitly clicking the same canvas selection also reveals it again.
  await folder(page, rootId).click();
  await page
    .locator(`.sheet > svg [data-object-id="${objectId}"]`)
    .click({ position: { x: 30, y: 30 } });
  await expect(folder(page, rootId)).toHaveAttribute("aria-expanded", "true");
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("保持する入力");
  await folder(page, rootId).click();
  await expect(row(page, objectId)).toHaveCount(0);
  await expect(name).toHaveValue("保持する入力");
  await page
    .getByRole("searchbox", { name: "レイヤーを検索", exact: true })
    .fill("一致しない検索");
  await expect(
    page.getByRole("status").filter({ hasText: "選択中の配置は検索条件外" }),
  ).toBeVisible();
  await expect(name).toHaveValue("保持する入力");
  await button(page, "検索を解除").click();
  await expect(folder(page, rootId)).toHaveAttribute("aria-expanded", "false");
  await expect(name).toHaveValue("保持する入力");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("importing a new generation closes an uncommitted folder dialog", async ({
  page,
}) => {
  await start(page);
  await button(page, "ルートにフォルダーを作成").click();
  const create = dialog(page, "フォルダーを作成");
  await create
    .getByLabel("フォルダー名", { exact: true })
    .fill("古い世代の入力");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(create).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  const result = await saved(page);
  expect(result.screens[0].folders).toEqual([]);
});
test("shared definition folders organize internal objects without changing parent placements", async ({
  page,
}) => {
  await start(page);
  const project = JSON.parse(
    await readFile("examples/process.project.json", "utf8"),
  );
  project.symbols[0].folders = [{ id: leafId, name: "構成図形", order: 0 }];
  for (const object of project.symbols[0].objects) object.folderId = leafId;
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "symbol-folders.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const child = project.symbols[0].objects[0];
  await page
    .locator(`button[data-layer-id="${child.id}"]`)
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "配置の所属を変更", exact: true })
    .click();
  const move = dialog(page, "配置の所属を変更");
  await expect(move).toContainText("対象：ポンプ");
  await expect(
    move.getByRole("button", { name: "所属を変更", exact: true }),
  ).toBeDisabled();
  await move.getByLabel("移動先", { exact: true }).selectOption("");
  await move.getByRole("button", { name: "所属を変更", exact: true }).click();
  const result = await saved(page);
  expect(result.symbols[0].objects[0].folderId).toBeUndefined();
  expect(result.symbols[0].objects[1].folderId).toBe(leafId);
  expect(result.screens).toEqual(project.screens);
  await button(page, "元に戻す").click();
  expect((await saved(page)).symbols[0]).toEqual(project.symbols[0]);
});
test("mixed membership requires an explicit destination and never defaults to root", async ({
  page,
}) => {
  await start(page);
  await row(page, objectId).click();
  await row(page, sample.screens[0].objects[1].id).click({
    modifiers: ["Shift"],
  });
  const modal = await assign(page);
  const target = modal.getByLabel("移動先", { exact: true });
  await expect(modal).toContainText("現在の所属：複数の所属");
  await expect(target).toHaveValue("__choose__");
  const confirm = modal.getByRole("button", {
    name: "所属を変更",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await target.press("Enter");
  await expect(modal).toBeVisible();
  await target.selectOption("");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const result = await saved(page);
  expect(result.screens[0].objects[0].folderId).toBeUndefined();
  expect(result.screens[0].objects[1]).toEqual(sample.screens[0].objects[1]);
  await button(page, "元に戻す").click();
  expect((await saved(page)).screens[0].objects[0].folderId).toBe(leafId);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
