import { chooseTheme } from "./helpers/designer";
import { test, expect } from "@playwright/test";

test("menubar navigates across Banto menus and returns focus on Escape", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByRole("menubar", { name: "Designer メニューバー" });
  const file = bar.getByRole("menuitem", { name: "ファイル", exact: true });
  const edit = bar.getByRole("menuitem", { name: "編集", exact: true });
  await file.focus();
  await file.press("ArrowRight");
  await expect(edit).toBeFocused();
  await edit.press("End");
  await expect(
    bar.getByRole("menuitem", { name: "ヘルプ", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(file).toBeFocused();
  await file.press("ArrowDown");
  const popup = page.getByRole("menu", { name: "ファイル", exact: true });
  await expect(popup.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(popup.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("menu", { name: "編集", exact: true }),
  ).toBeVisible();
  // Preview mode disables all edit items; the menu still closes with Escape.
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await expect(edit).toHaveAttribute("aria-expanded", "false");
  await edit.press("ArrowLeft");
  await file.press(" ");
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(popup.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(file).toBeFocused();
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await file.press("ArrowUp");
  await expect(popup.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
});

test("hidden menubar releases height, persists and restores through the permanent menu without losing drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const name = page.getByRole("textbox", { name: "画面名", exact: true });
  await name.fill("未適用の画面名");
  const bar = page.getByRole("menubar");
  const before = (await page.locator("main").boundingBox())!;
  await bar.getByRole("menuitem", { name: "表示", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "メニューバーを隠す", exact: true })
    .click();
  await expect(bar).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "メニュー", exact: true }),
  ).toBeFocused();
  expect((await page.locator("main").boundingBox())!.y).toBeLessThan(before.y);
  await expect(name).toHaveValue("未適用の画面名");
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menu", { name: "常設メニュー" })
    .getByRole("menuitem", { name: "メニューバーを表示", exact: true })
    .click();
  await expect(bar).toBeVisible();
  await expect(name).toHaveValue("未適用の画面名");
  await bar.getByRole("menuitem", { name: "表示", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "メニューバーを隠す", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("banto.ui.scada.designer.menubar"),
      ),
    )
    .toBe("false");
  await page.reload();
  await expect(bar).toHaveCount(0);
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "メニューバーを表示", exact: true })
    .click();
  await expect(bar).toBeVisible();
});

test("menu commands share draft protection, edit history and preview restrictions", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByRole("menubar");
  await bar.getByRole("menuitem", { name: "挿入", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Rectangle を追加", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await bar.getByRole("menuitem", { name: "挿入", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Rectangle を追加", exact: true })
    .click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  const x = page.getByLabel("色", { exact: true });
  await x.fill("#aabbcc");
  await bar.getByRole("menuitem", { name: "編集", exact: true }).click();
  await page.getByRole("menuitem", { name: "元に戻す", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(x).toHaveValue("#aabbcc");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await bar.getByRole("menuitem", { name: "編集", exact: true }).click();
  await page.getByRole("menuitem", { name: "元に戻す", exact: true }).click();
  await dialog
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
});

for (const theme of ["ライト", "ダーク"]) {
  test(`menus remain usable at desktop sizes in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await chooseTheme(page, theme === "ライト" ? "light" : "dark");
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .getByRole("menubar")
        .getByRole("menuitem", { name: "ヘルプ", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "操作ガイド・アプリ情報" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "操作ガイド・アプリ情報" }),
      ).toBeInViewport();
      await page
        .getByRole("button", { name: "閉じる", exact: true })
        .last()
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`menubar-${width}.png`),
        animations: "disabled",
      });
    }
  });
}
