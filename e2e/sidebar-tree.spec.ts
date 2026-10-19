import { test, expect, type Page } from "@playwright/test";
import { chooseTheme, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const section = (page: Page, label: string) =>
  page.locator("details.tree-section").filter({
    has: page
      .locator("summary")
      .filter({ hasText: new RegExp(`^.*${label}.*$`) }),
  });
const layers = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
}
test("project branches keep mounted drafts and reopen invalid settings and rename targets", async ({
  page,
}) => {
  await start(page);
  const settings = section(page, "プロジェクト設定");
  const name = page.getByRole("textbox", { name: "画面名", exact: true });
  await name.fill("");
  await settings.locator("summary").click();
  await expect(name).toBeHidden();
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await button(page, "適用して続行").click();
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("");
  await expect(name).toBeFocused();
  await name.fill("変更した画面");
  await button(page, "画面設定を適用").click();
  await settings.locator("summary").click();
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "変更した画面", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前変更", exact: true }).click();
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
});
test("layer search keeps selection, drafts, stacking order, context actions and tab state", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  const search = page.getByRole("searchbox", { name: "レイヤーを検索" });
  await layers(page)
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await page.getByLabel("テキスト", { exact: true }).fill("未適用");
  const root = page.locator("#designer-panel-layers details.tree-section");
  await root.locator("summary").click();
  await expect(layers(page)).toBeHidden();
  await search.fill("RECTANGLE");
  await expect(layers(page)).toBeVisible();
  await expect(layers(page).locator("[data-layer-id]")).toHaveCount(1);
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "未適用",
  );
  await search.fill("text");
  const row = layers(page).getByRole("button", {
    name: "text · 5",
    exact: true,
  });
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "text · 5 の操作", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await selectPanel(page, "部品");
  await selectPanel(page, "レイヤー");
  await expect(search).toHaveValue("text");
  await search.fill("存在しない配置");
  await expect(
    page.getByText("一致する配置はありません。", { exact: true }),
  ).toBeVisible();
  await search.fill("");
  await expect(layers(page).locator("[data-layer-id]")).toHaveText([
    "rectangle · 3",
    "ellipse · 4",
    "text · 5",
  ]);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("project tag reference branch opens the existing usages panel and preserves search across themes", async ({
  page,
}) => {
  await start(page);
  await page
    .getByLabel("Project を開く", { exact: true })
    .setInputFiles("examples/tag-binding.project.json");
  await expect(
    section(page, "タグ参照").getByRole("button", {
      name: "タグ参照一覧を開く",
    }),
  ).toBeEnabled();
  await button(page, "タグ参照一覧を開く").click();
  await expect(
    page.getByRole("region", { name: "タグ参照パネル", exact: true }),
  ).toBeVisible();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("searchbox", { name: "レイヤーを検索" })
    .fill("PLC01.Fast.Tank01.Level");
  await expect(layers(page).locator("[data-layer-id]")).toHaveCount(1);
  await chooseTheme(page, "dark");
  await expect(layers(page).locator("[data-layer-id]")).toHaveCount(1);
  await button(page, "表示プレビュー").click();
  await expect(
    page.getByRole("searchbox", { name: "レイヤーを検索" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "画面一覧" }),
  ).toBeVisible();
});
