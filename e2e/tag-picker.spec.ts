import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "タグを選択", exact: true });
const field = (page: Page) =>
  page.getByLabel("表示タグ（外部名）", { exact: true });
const tag = (page: Page, name: RegExp) =>
  dialog(page).getByRole("treeitem", { name });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
}
test("candidate inspection stays local; explicit choice changes only draft until Apply and Undo", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("テキスト", { exact: true }).fill("保持する文字");
  await button(page, "タグを選択").click();
  await expect(dialog(page)).toContainText("サンプル候補・Hub未接続");
  await expect(dialog(page)).toContainText(
    "プロセス画面 ／ Text · 5 ／ 表示タグ",
  );
  await expect(button(page, "選択して入力")).toBeDisabled();
  await tag(page, /原水タンク 液位/).click();
  await expect(
    dialog(page).getByRole("region", { name: "タグの詳細" }),
  ).toContainText("Demo.Water.Tank01.Level");
  await expect(field(page)).toHaveValue("");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "選択して入力").click();
  await expect(dialog(page)).toBeHidden();
  await expect(field(page)).toHaveValue("Demo.Water.Tank01.Level");
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する文字",
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(button(page, "タグを選択")).toBeFocused();
  await button(page, "変更を適用").click();
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toContainText("未接続");
  await button(page, "元に戻す").click();
  await expect(field(page)).toHaveValue("");
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "BANTO / SCADA — Sample",
  );
});
test("search, incompatible types, hidden candidates and IME cannot accidentally choose a tag", async ({
  page,
}) => {
  await start(page);
  await field(page).fill("keep.manual");
  await button(page, "タグを選択").click();
  await expect(tag(page, /運転状態/)).toHaveCount(0);
  await tag(page, /原水タンク 液位/).click();
  const search = dialog(page).getByLabel("タグ候補を検索", { exact: true });
  await search.fill("圧力");
  await search.press("Enter");
  await expect(button(page, "選択して入力")).toBeDisabled();
  await expect(field(page)).toHaveValue("keep.manual");
  await expect(tag(page, /原水ポンプ 吐出圧力/)).toBeVisible();
  await search.fill("存在しないタグ");
  await expect(dialog(page).getByRole("status")).toContainText(
    "一致するタグ候補はありません",
  );
  await search.fill("");
  await dialog(page).getByLabel("互換タグのみ", { exact: true }).uncheck();
  await tag(page, /運転状態/).click();
  await expect(dialog(page)).toContainText("型が不適合です");
  await expect(button(page, "選択して入力")).toBeDisabled();
  await tag(page, /運転状態/).press("Enter");
  await expect(dialog(page)).toBeVisible();
  await tag(page, /原水タンク 液位/).focus();
  await tag(page, /原水タンク 液位/).dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toHaveValue("keep.manual");
  await search.focus();
  await search.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
  });
  await expect(dialog(page)).toBeVisible();
  await search.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(field(page)).toHaveValue("keep.manual");
  await expect(button(page, "タグを選択")).toBeFocused();
});
test("tree arrows inspect metadata hierarchy, folder Enter only expands, and tag Enter confirms", async ({
  page,
}) => {
  await start(page);
  await button(page, "タグを選択").click();
  const water = tag(page, /サンプル水処理/);
  await water.focus();
  await water.press("Enter");
  await expect(water).toHaveAttribute("aria-expanded", "false");
  await expect(dialog(page)).toBeVisible();
  await water.press("ArrowRight");
  await water.press("ArrowRight");
  await expect(tag(page, /タンク$/)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tag(page, /原水タンク 液位/)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(tag(page, /原水タンク 温度/)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expect(field(page)).toHaveValue("Demo.Water.Tank01.Temperature");
});
test("double click chooses; dialog shortcuts and same-ID project reload cannot mutate an old target", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("x", { exact: true }).fill("101");
  await page.getByLabel("x", { exact: true }).press("Enter");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("101");
  await expect(button(page, "元に戻す")).toBeEnabled();
  await button(page, "タグを選択").click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("101");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+s");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("101");
  await tag(page, /搬送数/).dblclick();
  await expect(field(page)).toHaveValue("Demo.Line.WorkCount");
  await button(page, "タグを選択").click();
  await button(page, "キャンセル").click();
  await expect(field(page)).toHaveValue("Demo.Line.WorkCount");
  // Reset through the existing draft/history path before testing a clean reload.
  await button(page, "元に戻す").click();
  await button(page, "入力を破棄して続行").click();
  await button(page, "タグを選択").click();
  await tag(page, /原水タンク 液位/).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "same-ids.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(dialog(page)).toBeHidden();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await expect(field(page)).toHaveValue("");
});
for (const theme of ["light", "dark"]) {
  test(`tag picker fits ${theme} at desktop and narrow widths without creating changes`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await button(page, "タグを選択").click();
    for (const width of [1920, 1280, 600]) {
      await page.setViewportSize({ width, height: 800 });
      const box = await dialog(page).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      await expect(button(page, "選択して入力")).toBeVisible();
    }
    await button(page, "キャンセル").click();
    await expect(button(page, "元に戻す")).toBeDisabled();
  });
}

test("folder double click toggles once and search keeps ancestor keyboard navigation", async ({
  page,
}) => {
  await start(page);
  await button(page, "タグを選択").click();
  const water = tag(page, /サンプル水処理/);
  await water.dblclick();
  await expect(water).toHaveAttribute("aria-expanded", "false");
  await water.dblclick();
  await expect(water).toHaveAttribute("aria-expanded", "true");
  await dialog(page).getByLabel("タグ候補を検索", { exact: true }).fill("液位");
  const level = tag(page, /原水タンク 液位/);
  await level.focus();
  await level.press("ArrowLeft");
  await expect(tag(page, /タンク$/)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(water).toBeFocused();
  await expect(button(page, "選択して入力")).toBeDisabled();
});
test("native search undo stays local while row undo cannot affect background values", async ({
  page,
}) => {
  await start(page);
  const x = page.getByLabel("x", { exact: true });
  await x.fill("101");
  await x.press("Enter");
  await button(page, "タグを選択").click();
  const search = dialog(page).getByLabel("タグ候補を検索", { exact: true });
  await search.focus();
  await search.press("ControlOrMeta+z");
  await expect(x).toHaveValue("101");
  await search.fill("液位");
  await search.press("ControlOrMeta+z");
  await expect(search).toHaveValue("");
  await expect(x).toHaveValue("101");
  await search.press("ControlOrMeta+Shift+z");
  await expect(search).toHaveValue("液位");
  await expect(x).toHaveValue("101");
  if (process.platform !== "darwin") {
    // Ctrl+Y is a separate app shortcut and a native redo key outside macOS.
    await search.press("Control+z");
    await expect(search).toHaveValue("");
    await search.press("Control+y");
    await expect(search).toHaveValue("液位");
    await expect(x).toHaveValue("101");
  }
  await tag(page, /原水タンク 液位/).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(x).toHaveValue("101");
  if (process.platform !== "darwin") {
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    await expect(x).toHaveValue("101");
  }
  await button(page, "キャンセル").click();
  await expect(field(page)).toHaveValue("");
});
