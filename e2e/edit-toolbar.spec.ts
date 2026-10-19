import { test, expect, type Page } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";

const toolbar = (page: Page) =>
  page.getByRole("toolbar", { name: "共通編集ツールバー", exact: true });
const button = (page: Page, name: string) =>
  toolbar(page).getByRole("button", { name, exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
async function edit(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
}
async function menu(page: Page, name: string) {
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function selectTwo(page: Page) {
  await selectPanel(page, "レイヤー");
  const list = page.getByRole("navigation", { name: "図形一覧" });
  await list
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await list
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
}

// These operations must stay usable even when every auxiliary panel is hidden.
test("toolbar reflects selection cardinality and edits with all panels hidden", async ({
  page,
}) => {
  await edit(page);
  for (const name of ["選択図形を複製", "選択図形を削除", "最前面へ", "左揃え"])
    await expect(button(page, name)).toBeDisabled();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const properties = page.getByRole("complementary", {
    name: "プロパティパネル",
    exact: true,
  });
  await expect(
    properties.getByRole("button", { name: "選択図形を複製" }),
  ).toHaveCount(0);
  await expect(button(page, "最前面へ")).toBeEnabled();
  await expect(button(page, "左揃え")).toBeDisabled();
  await menu(page, "補助パネルをすべて隠す");
  await button(page, "選択図形を複製").click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  const copy = await svg(page)
    .locator('[data-selected="true"]')
    .getAttribute("data-object-id");
  await button(page, "最背面へ").click();
  await expect(svg(page).locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copy!,
  );
  await button(page, "元に戻す").click();
  await expect(svg(page).locator("[data-object-id]").last()).toHaveAttribute(
    "data-object-id",
    copy!,
  );
  await button(page, "選択図形を削除").click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await button(page, "元に戻す").click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await button(page, "すべて選択").click();
  await expect(button(page, "最前面へ")).toBeDisabled();
  await expect(button(page, "左揃え")).toBeEnabled();
  await button(page, "選択解除").click();
  await expect(button(page, "選択図形を削除")).toBeDisabled();
});

test("toolbar alignment and menu alignment share draft protection and one-step history", async ({
  page,
}) => {
  await edit(page);
  await selectTwo(page);
  const positions = () =>
    svg(page)
      .locator("[data-object-id]")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const m = (n as SVGGElement).transform.baseVal.consolidate()!.matrix;
          return { x: m.e, y: m.f };
        }),
      );
  const before = await positions();
  await page.getByLabel("移動量 X", { exact: true }).fill("10");
  await menu(page, "補助パネルをすべて隠す");
  await button(page, "左揃え").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(await positions()).toEqual(before);
  await button(page, "左揃え").click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  const aligned = await positions();
  expect(aligned[0].x).toBe(aligned[1].x);
  await button(page, "元に戻す").click();
  expect(await positions()).toEqual(before);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "左揃え", exact: true }).click();
  expect(await positions()).toEqual(aligned);
  await button(page, "元に戻す").click();
  expect(await positions()).toEqual(before);
});

test("toolbar keyboard navigation skips unavailable actions and preserves editor inputs", async ({
  page,
}) => {
  await edit(page);
  await button(page, "すべて選択").focus();
  await page.keyboard.press("ArrowRight");
  await expect(button(page, "すべて選択")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(svg(page).locator('[data-selected="true"]')).toHaveCount(3);
  await page.keyboard.press("End");
  await expect(button(page, "中心を垂直方向に等間隔")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(button(page, "すべて選択")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(button(page, "中心を垂直方向に等間隔")).toBeFocused();
  await button(page, "選択解除").click();
  await selectPanel(page, "プロジェクト");
  const name = page.getByLabel("画面名", { exact: true });
  await name.focus();
  await name.press("Home");
  await expect(name).toBeFocused();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(
    toolbar(page).getByRole("group", { name: "編集履歴", exact: true }),
  ).toHaveCount(0);
  await expect(toolbar(page)).toBeVisible();
});

for (const theme of ["light", "dark"])
  test(`toolbar stays accessible in ${theme} with narrow and desktop layouts`, async ({
    page,
  }) => {
    await edit(page);
    await chooseTheme(page, theme);
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [650, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(toolbar(page)).toBeInViewport();
      await expect(button(page, "下揃え")).toBeInViewport();
      await expect(button(page, "中心を垂直方向に等間隔")).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await expect(
      toolbar(page).getByRole("group", { name: "編集履歴", exact: true }),
    ).toHaveCount(0);
    await expect(toolbar(page)).toBeVisible();
  });
