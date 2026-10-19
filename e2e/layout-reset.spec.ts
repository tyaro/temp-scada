import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Project と部品", exact: true });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "プロパティパネル", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const divider = (page: Page, name: string) =>
  page.getByRole("separator", { name, exact: true });
const storage = "banto.ui.scada.designer.";
async function menu(page: Page, name: string) {
  await button(page, "メニュー").click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function start(page: Page, bindings = false) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.evaluate((prefix) => {
    localStorage.setItem(
      prefix + "panel-widths",
      JSON.stringify({ left: 360, right: 400 }),
    );
    localStorage.setItem(prefix + "reference-height", "320");
    for (const key of ["menubar", "minimap", "rulers"])
      localStorage.setItem(prefix + key, "false");
    localStorage.setItem(
      prefix + "favorites",
      JSON.stringify(["basic:rectangle"]),
    );
  }, storage);
  await page.reload();
  if (bindings)
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles("examples/tag-binding.project.json");
  await button(page, "編集").click();
}
async function center(page: Page) {
  return viewport(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const p = new DOMPoint(
      box.left + element.clientLeft + element.clientWidth / 2,
      box.top + element.clientTop + element.clientHeight / 2,
    ).matrixTransform(element.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  });
}
async function expectDefaults(page: Page) {
  await expect(sidebar(page)).toBeVisible();
  await expect(inspector(page)).toBeVisible();
  // An empty reference list has no rendered content, but its visibility preference is restored.
  await expect(page.locator("#designer-references-panel")).not.toHaveAttribute(
    "hidden",
    "",
  );
  await expect(page.getByRole("menubar")).toBeVisible();
  await expect(page.getByTestId("ruler-x")).toBeVisible();
  await expect(button(page, "ミニマップで表示位置を移動")).toBeVisible();
  await expect(divider(page, "左パネルの幅")).toHaveAttribute(
    "aria-valuenow",
    "240",
  );
  await expect(divider(page, "プロパティの幅")).toHaveAttribute(
    "aria-valuenow",
    "288",
  );
}
test("standard layout restores hidden regions without resolving drafts, changing context, theme, favorites or Project", async ({
  page,
}) => {
  await start(page);
  await chooseTheme(page, "light");
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("色", { exact: true }).fill("#aabbcc");
  await selectPanel(page, "プロジェクト");
  await page.getByLabel("画面名", { exact: true }).fill("未適用の画面名");
  const tagBranch = page
    .locator("details.tree-section")
    .filter({ has: page.locator("summary", { hasText: "タグ参照" }) });
  await tagBranch.locator("summary").click();
  await selectPanel(page, "レイヤー");
  await page.getByLabel("レイヤーを検索", { exact: true }).fill("rectangle");
  const state = await page.getByTestId("save-state").innerText();
  await menu(page, "タグ参照一覧を隠す");
  await menu(page, "補助パネルをすべて隠す");
  await expect(sidebar(page)).toHaveCount(0);
  await menu(page, "標準レイアウトに戻す");
  await expectDefaults(page);
  await expect(button(page, "メニュー")).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("色", { exact: true })).toHaveValue("#aabbcc");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の画面名",
  );
  await expect(page.getByLabel("レイヤーを検索", { exact: true })).toHaveValue(
    "rectangle",
  );
  await expect(
    page.getByRole("tab", { name: "レイヤー", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.sheet > svg [data-selected="true"]')).toHaveCount(
    1,
  );
  expect(await page.getByTestId("save-state").innerText()).toBe(state);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page
      .getByRole("region", { name: "お気に入り部品", exact: true })
      .getByRole("button", { name: "お気に入り：四角形を配置", exact: true }),
  ).toBeVisible();
  await selectPanel(page, "プロジェクト");
  await expect(tagBranch).not.toHaveAttribute("open", "");
  await page.getByLabel("画面名", { exact: true }).fill(sample.screens[0].name);
  await page
    .getByLabel("色", { exact: true })
    .fill(sample.screens[0].objects[0].fill);
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await waiting;
  expect(JSON.parse(await readFile((await file.path())!, "utf8"))).toEqual(
    sample,
  );
  await menu(page, "補助パネルをすべて隠す");
  await menu(page, "補助パネルを元の表示に戻す");
  await expectDefaults(page);
});
test("restored preferences persist and the expanded reference panel keeps its search and expansion", async ({
  page,
}) => {
  await start(page, true);
  await page.locator("details.references > summary").click();
  await page.getByLabel("タグ参照を検索", { exact: true }).fill("Tank");
  await expect(divider(page, "タグ参照パネルの高さ")).toHaveAttribute(
    "aria-valuenow",
    "320",
  );
  await menu(page, "標準レイアウトに戻す");
  await expect(divider(page, "タグ参照パネルの高さ")).toHaveAttribute(
    "aria-valuenow",
    "240",
  );
  await expect(page.getByLabel("タグ参照を検索", { exact: true })).toHaveValue(
    "Tank",
  );
  await page.reload();
  await button(page, "メニュー").click();
  await expect(
    page.getByRole("menuitem", { name: "標準レイアウトに戻す", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles("examples/tag-binding.project.json");
  await button(page, "編集").click();
  await expectDefaults(page);
  await page.locator("details.references > summary").click();
  await expect(divider(page, "タグ参照パネルの高さ")).toHaveAttribute(
    "aria-valuenow",
    "240",
  );
  expect(
    await page.evaluate(
      (prefix) => localStorage.getItem(prefix + "favorites"),
      storage,
    ),
  ).toBe('["basic:rectangle"]');
});
for (const zoom of ["0.25", "1", "4", "fit"])
  test(`restoring all regions retains ${zoom} viewport mode and manual design center`, async ({
    page,
  }) => {
    await start(page);
    await page.getByLabel("表示倍率", { exact: true }).selectOption(zoom);
    await menu(page, "補助パネルをすべて隠す");
    await expect(sidebar(page)).toHaveCount(0);
    const before = await center(page);
    await menu(page, "標準レイアウトに戻す");
    await expectDefaults(page);
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      zoom,
    );
    if (zoom !== "fit") {
      await expect
        .poll(async () => Math.abs((await center(page)).x - before.x))
        .toBeLessThan(2 / Number(zoom));
      await expect
        .poll(async () => Math.abs((await center(page)).y - before.y))
        .toBeLessThan(2 / Number(zoom));
    } else {
      const fits = await viewport(page).evaluate((element) => {
        const area = element.getBoundingClientRect(),
          sheet = element
            .querySelector(".sheet > svg")!
            .getBoundingClientRect();
        return sheet.width <= area.width + 1 && sheet.height <= area.height + 1;
      });
      expect(fits).toBe(true);
    }
    await expect(button(page, "元に戻す")).toBeDisabled();
  });
test("failed preference writes leave the restored layout usable and report one warning", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("blocked", "QuotaExceededError");
    };
  });
  await menu(page, "標準レイアウトに戻す");
  await expectDefaults(page);
  await expect(
    page.getByText(
      "レイアウトを保存できない項目があります。このタブの復元は維持します。",
      { exact: true },
    ),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      (prefix) => localStorage.getItem(prefix + "panel-widths"),
      storage,
    ),
  ).toBe('{"left":360,"right":400}');
  await selectPanel(page, "部品");
  await button(page, "Rectangle を追加").click();
  await expect(button(page, "元に戻す")).toBeEnabled();
});
test("restore cancels an active divider drag so later pointer movement cannot overwrite the standard size", async ({
  page,
}) => {
  await start(page);
  const handle = divider(page, "左パネルの幅"),
    box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + 50, { steps: 4 });
  await button(page, "メニュー").focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", {
    name: "標準レイアウトに戻す",
    exact: true,
  });
  await item.focus();
  await page.keyboard.press("Enter");
  await page.mouse.move(600, 300, { steps: 3 });
  await page.mouse.up();
  await expectDefaults(page);
});
for (const theme of ["light", "dark"])
  test(`standard layout respects narrow responsive constraints and keeps inputs in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await selectPanel(page, "レイヤー");
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await page.getByLabel("配置名", { exact: true }).fill("保持する入力");
    await menu(page, "補助パネルをすべて隠す");
    await page.setViewportSize({ width: 960, height: 720 });
    await menu(page, "標準レイアウトに戻す");
    await expect(sidebar(page)).toBeVisible();
    await expect(inspector(page)).toBeVisible();
    await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
      "保持する入力",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
