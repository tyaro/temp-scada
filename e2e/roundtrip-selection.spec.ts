import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// F-1: 編集 → 表示プレビュー → 編集、画面 → Symbol 定義 → 画面 の往復で、選択と表示位置を戻す。
const PUMP = "0199f200-0000-7000-8000-000000000020";
const VALVE = "0199f200-0000-7000-8000-000000000021";
const RECT = "0199f200-0000-7000-8000-000000000014";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const placement = (page: Page, id: string) =>
  page.locator(`.sheet > svg > [data-object-id="${id}"]`);
const count = (page: Page) => page.locator(".selection-count");
const scroll = (page: Page) =>
  viewport(page).evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openProject(page, "examples/process.project.json");
  await button(page, "編集").click();
  await expect(viewport(page)).toBeVisible();
}

test("selection survives an edit → preview → edit round trip", async ({
  page,
}) => {
  await start(page);
  await placement(page, VALVE).click();
  await placement(page, RECT).click({ modifiers: ["Shift"] });
  await expect(count(page)).toHaveText("2 件選択");
  await button(page, "表示プレビュー").click();
  await expect(count(page)).toHaveCount(0);
  await button(page, "編集").click();
  await expect(count(page)).toHaveText("2 件選択");
  await expect(placement(page, VALVE)).toHaveAttribute("data-selected", "true");
  await expect(placement(page, RECT)).toHaveAttribute("data-selected", "true");
  // 選択の復元は Undo 履歴に入らない。
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("returning from a symbol definition restores zoom, position, selection and the left tab", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await placement(page, PUMP).click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  await placement(page, PUMP).evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "center" }),
  );
  await expect(placement(page, PUMP)).toBeInViewport();
  // スクロールの記録（onscroll）が落ち着くのを待つ。
  await expect.poll(() => scroll(page)).toEqual(await scroll(page));
  const before = await scroll(page);
  expect(before.left + before.top).toBeGreaterThan(0);

  await button(page, "参照する Symbol 定義を編集").click();
  await expect(page.getByRole("note")).toContainText("Symbol 定義を編集中");
  await expect(
    page.getByRole("tab", { name: "レイヤー", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await button(page, "画面へ戻る").click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("2");
  await expect
    .poll(async () => {
      const after = await scroll(page);
      return (
        Math.abs(after.left - before.left) <= 1 &&
        Math.abs(after.top - before.top) <= 1
      );
    })
    .toBe(true);
  await expect(placement(page, PUMP)).toBeInViewport();
  await expect(count(page)).toHaveText("1 件選択");
  await expect(placement(page, PUMP)).toHaveAttribute("data-selected", "true");
  await expect(
    page.getByRole("tab", { name: "レイヤー", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
