import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const area = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
}
for (const zoom of ["0.25", "1", "4"]) {
  test(`arrow keys move in design units at ${zoom}, preserve viewport and undo each key`, async ({
    page,
  }) => {
    await start(page);
    await page.getByLabel("表示倍率", { exact: true }).selectOption(zoom);
    await area(page).focus();
    const before = await area(page).evaluate((el) => ({
      x: el.scrollLeft,
      y: el.scrollTop,
    }));
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("x", { exact: true })).toHaveValue("101");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.getByLabel("y", { exact: true })).toHaveValue("180");
    expect(
      await area(page).evaluate((el) => ({
        x: el.scrollLeft,
        y: el.scrollTop,
      })),
    ).toEqual(before);
    await page.keyboard.press("Control+z");
    await expect(page.getByLabel("y", { exact: true })).toHaveValue("170");
    await page.keyboard.press("Control+z");
    await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
    await expect(button(page, "元に戻す")).toBeDisabled();
  });
}
test("snapped group nudges preserve relative geometry and Shift advances ten grid steps", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("x", { exact: true }).fill("3");
  await page.getByLabel("x", { exact: true }).press("Enter");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const positions = () =>
    svg
      .locator('[data-selected="true"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("transform")));
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  expect(await positions()).toEqual([
    "translate(10 170)",
    "translate(577 190)",
  ]);
  await page.keyboard.press("Shift+ArrowRight");
  expect(await positions()).toEqual([
    "translate(110 170)",
    "translate(677 190)",
  ]);
  await page.keyboard.press("Control+z");
  expect(await positions()).toEqual([
    "translate(10 170)",
    "translate(577 190)",
  ]);
});
test("draft confirmation cancels or applies the captured nudge, and IME does not edit", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("テキスト", { exact: true });
  await input.fill("未適用のテキスト");
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await button(page, "キャンセル").click();
  await expect(input).toHaveValue("未適用のテキスト");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await button(page, "適用して続行").click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("101");
  await button(page, "元に戻す").click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(input).toHaveValue("未適用のテキスト");
  await area(page).dispatchEvent("keydown", {
    key: "ArrowRight",
    isComposing: true,
    bubbles: true,
  });
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
});
test("layer navigation, native numeric input, resize handles, preview and pan keep their key behavior", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("ArrowRight"); // focus stays in the layer list
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  const x = page.getByLabel("x", { exact: true });
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Enter");
  await expect(x).toHaveValue("100");
  const handle = page.getByRole("button", {
    name: "サイズ変更 e（方向キーで変更）",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("261");
  await expect(x).toHaveValue("100");
  await button(page, "パンツール").click();
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(x).toHaveValue("100");
  await button(page, "表示プレビュー").click();
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await expect(x).toHaveValue("100");
});
test("shared definition editing uses the same design-unit movement and continuous placement blocks it", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const row = page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "polyline · 0", exact: true })
    .first();
  await row.click();
  const x = page.getByLabel("x", { exact: true });
  const before = Number(await x.inputValue());
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(x).toHaveValue(String(before + 1));
  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue(String(before));
  await button(page, "画面へ戻る").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const initial = await x.inputValue();
  await button(page, "連続配置ツール").click();
  await area(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(x).toHaveValue(initial);
});
