import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
import sample from "../examples/tag-binding.project.json" with { type: "json" };

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Project と部品", exact: true });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "プロパティパネル", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function menu(page: Page, name: string) {
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function edit(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
}
async function center(page: Page) {
  return viewport(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const point = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
}

test("restore returns the previous panel subset, search, tab, selection and unapplied fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await edit(page);
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  await page.getByLabel("x", { exact: true }).fill("123");
  await page.getByRole("searchbox", { name: "部品を検索" }).fill("rectangle");
  await page.getByRole("button", { name: "名称一覧", exact: true }).click();
  await menu(page, "タグ参照一覧を隠す");
  const before = await page.locator(".toolbar").innerText();
  const width = (await viewport(page).boundingBox())!.width;
  await menu(page, "補助パネルをすべて隠す");
  await expect(sidebar(page)).toHaveCount(0);
  await expect(inspector(page)).toHaveCount(0);
  await expect
    .poll(async () => (await viewport(page).boundingBox())!.width)
    .toBeGreaterThan(width + 500);
  await expect(
    page.getByRole("button", { name: "メニュー", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.locator(".toolbar").innerText()).toBe(before);
  await menu(page, "メニューバーを隠す");
  await menu(page, "補助パネルを元の表示に戻す");
  await expect(sidebar(page)).toBeVisible();
  await expect(inspector(page)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "タグ参照パネル", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "部品", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: "部品を検索" })).toHaveValue(
    "rectangle",
  );
  await expect(
    page.getByRole("button", { name: "名称一覧", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("123");
  await page.getByRole("button", { name: "変更を適用", exact: true }).click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.getByLabel("x", { exact: true })).not.toHaveValue("123");
});

test("hidden invalid screen settings reveal the project tab before validation focus", async ({
  page,
}) => {
  await edit(page);
  await page.getByLabel("画面の幅", { exact: true }).fill("0");
  await selectPanel(page, "部品");
  await menu(page, "補助パネルをすべて隠す");
  await page.keyboard.press("Control+s");
  await page
    .getByRole("dialog", { name: "未適用の入力があります" })
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(sidebar(page)).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "プロジェクト", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("画面の幅", { exact: true })).toBeFocused();
  await expect(page.getByLabel("画面の幅", { exact: true })).toHaveValue("0");
});

test("tag reference visibility retains search and disclosure, individual changes leave the temporary hide mode", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "binding.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const details = page.locator("details.references");
  await details.locator("summary").click();
  await page
    .getByLabel("タグ参照を検索", { exact: true })
    .fill("存在しない参照");
  await page
    .getByRole("button", { name: "タグ参照一覧を隠す", exact: true })
    .click();
  await expect(details).toBeHidden();
  await menu(page, "タグ参照一覧を表示");
  await expect(details).toHaveAttribute("open", "");
  await expect(page.getByLabel("タグ参照を検索", { exact: true })).toHaveValue(
    "存在しない参照",
  );
  await expect(
    page.getByRole("region", { name: "タグ参照パネル", exact: true }),
  ).toBeFocused();
  await menu(page, "補助パネルをすべて隠す");
  await menu(page, "左パネルを表示");
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await expect(
    page.getByRole("menuitem", {
      name: "補助パネルを元の表示に戻す",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "左パネルを隠す", exact: true })
    .click();
  await menu(page, "補助パネルをすべて表示");
  await expect(sidebar(page)).toBeVisible();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByLabel("タグ参照を検索", { exact: true })).toHaveValue(
    "存在しない参照",
  );
});

for (const zoom of [0.25, 1, 4])
  test(`all panel visibility retains the design center at ${zoom * 100}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await edit(page);
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    await viewport(page).evaluate((el) => {
      el.scrollLeft = 90;
      el.scrollTop = 50;
    });
    const before = await center(page);
    for (const action of [
      "補助パネルをすべて隠す",
      "補助パネルを元の表示に戻す",
    ]) {
      await menu(page, action);
      await expect
        .poll(async () => Math.abs((await center(page)).x - before.x))
        .toBeLessThan(1.1 / zoom);
      await expect
        .poll(async () => Math.abs((await center(page)).y - before.y))
        .toBeLessThan(1.1 / zoom);
      await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
        String(zoom),
      );
    }
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
  });

for (const theme of ["light", "dark"])
  test(`panel combinations fit desktop and narrow layouts in ${theme}`, async ({
    page,
  }) => {
    await edit(page);
    await page.getByLabel("テーマ", { exact: true }).selectOption(theme);
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [900, 900],
      [650, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .getByRole("button", { name: "左パネルを隠す", exact: true })
        .click();
      await expect(sidebar(page)).toHaveCount(0);
      await expect(inspector(page)).toBeVisible();
      const preview = await page
        .getByRole("region", { name: "画面プレビュー", exact: true })
        .boundingBox();
      expect(preview!.width).toBeGreaterThan(
        width >= 1100 ? width - 310 : width - 10,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await menu(page, "左パネルを表示");
    }
    await menu(page, "補助パネルをすべて隠す");
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await expect(sidebar(page)).toBeVisible();
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await expect(
      page.getByRole("menuitem", {
        name: "補助パネルを元の表示に戻す",
        exact: true,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await expect(sidebar(page)).toHaveCount(0);
    await menu(page, "補助パネルを元の表示に戻す");
    await expect(sidebar(page)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await expect(sidebar(page)).toBeVisible();
    await expect(inspector(page)).toBeVisible();
  });
