import { test, expect } from "@playwright/test";
import { chooseTheme, selectPanel, chooseMenuItem } from "./helpers/designer";

for (const theme of ["light", "dark"])
  test(`compact header and global toolbar keep every requested control in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await chooseTheme(page, theme);
    const header = page.locator(".app-header");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(44);
    await expect(header).not.toContainText("ローカルファイル編集");
    await expect(header.getByRole("combobox")).toHaveCount(0);
    const toolbar = page.getByRole("toolbar", {
      // The same toolbar is named for the mode (編集 / 表示確認).
      name: /^(共通編集|表示確認)ツールバー$/,
    });
    await page.getByRole("button", { name: "編集", exact: true }).click();
    for (const label of [
      "グリッド表示",
      "グリッドにスナップ",
      "グリッド間隔",
      "表示倍率",
    ]) {
      await expect(toolbar.getByLabel(label, { exact: true })).toBeVisible();
    }
    for (const name of [
      "選択ツール",
      "パンツール",
      "縮小",
      "拡大",
      "全体表示",
    ]) {
      await expect(
        toolbar.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    for (const name of ["編集", "表示プレビュー"])
      await expect(
        header.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await expect(header.getByTestId("save-state")).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "画面プレビュー", exact: true })
        .getByRole("group", { name: "キャンバス表示", exact: true }),
    ).toHaveCount(0);
    const canvas = page.getByRole("region", {
      name: "画面プレビュー",
      exact: true,
    });
    await expect(
      canvas.getByRole("heading", { name: "プロセス画面" }),
    ).toHaveCount(0);
    await expect(canvas).not.toContainText("SCREEN ·");
    await toolbar.getByLabel("グリッド表示", { exact: true }).check();
    await toolbar.getByLabel("グリッドにスナップ", { exact: true }).check();
    await toolbar
      .getByLabel("グリッド間隔", { exact: true })
      .selectOption("20");
    await toolbar
      .getByRole("button", { name: "パンツール", exact: true })
      .click();
    await expect(
      toolbar.getByRole("button", { name: "パンツール", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await toolbar
      .getByRole("button", { name: "選択ツール", exact: true })
      .click();
    await toolbar.getByLabel("表示倍率", { exact: true }).selectOption("1");
    await toolbar.getByRole("button", { name: "拡大", exact: true }).click();
    await expect(toolbar.getByLabel("表示倍率", { exact: true })).toHaveValue(
      "1.5",
    );
    await toolbar.getByRole("button", { name: "縮小", exact: true }).click();
    await expect(toolbar.getByLabel("表示倍率", { exact: true })).toHaveValue(
      "1",
    );
    await toolbar
      .getByRole("button", { name: "全体表示", exact: true })
      .click();
    await expect(toolbar.getByLabel("表示倍率", { exact: true })).toHaveValue(
      "fit",
    );
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await expect(
      canvas.getByRole("heading", { name: "プロセス画面" }),
    ).toHaveCount(0);
    await expect(canvas).not.toContainText("SCREEN ·");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    expect(
      (await page
        .getByRole("region", { name: "キャンバス操作領域", exact: true })
        .boundingBox())!.height,
    ).toBeGreaterThan(600);
    for (const width of [1280, 650, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });

test("toolbar mode changes retain draft protection and save status remains visible without auxiliary panels", async ({
  page,
}) => {
  await page.goto("/");
  const toolbar = page.getByRole("toolbar", {
    // The same toolbar is named for the mode (編集 / 表示確認).
    name: /^(共通編集|表示確認)ツールバー$/,
  });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#aabbcc");
  await chooseMenuItem(page, "表示", "補助パネルをすべて隠す");
  const state = page.getByTestId("save-state");
  await expect(state).toBeVisible();
  await expect(state).toContainText("未適用の入力あり · 1 フォーム");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  // 離れたら確定: 未適用の入力は確認なしで適用されてプレビューへ移る
  await expect(
    page.getByRole("button", { name: "表示プレビュー", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(state).not.toContainText("未適用の入力あり");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await downloading;
  await expect(state).toContainText("書き出し要求後の変更なし");
  await expect(state).not.toContainText("未適用の入力あり");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(toolbar).toBeVisible();
  await expect(state).toBeVisible();
  await expect(
    page.getByRole("button", { name: "表示プレビュー", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    toolbar.getByRole("group", { name: "編集履歴", exact: true }),
  ).toHaveCount(0);
});

test("theme icon exposes all modes by keyboard and leaves current editing intact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("画面名", { exact: true }).fill("未適用の画面名");
  const icon = page.getByRole("button", { name: "テーマを変更", exact: true });
  await icon.focus();
  await icon.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "テーマ", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  await expect(
    menu.getByRole("menuitem", { name: "ライト", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "OS に合わせる", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(icon).toHaveAttribute("data-theme-mode", "system");
  await expect(icon).toHaveAttribute("title", "テーマ：OS に合わせる");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の画面名",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the header row holds mode and save state so the 1440px toolbar stays on one row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const header = page.locator(".app-header");
  await expect(
    header.getByRole("group", { name: "表示モード", exact: true }),
  ).toBeVisible();
  await expect(header.getByTestId("save-state")).toBeVisible();
  await expect(header).toContainText("0 件選択");
  const height = async (selector: string) =>
    (await page.locator(selector).boundingBox())!.height;
  expect(await height(".app-header")).toBeLessThanOrEqual(36);
  expect(await height('[role="toolbar"]')).toBeLessThanOrEqual(48);
  await page.screenshot({
    path: "test-results/header-1440.png",
    clip: { x: 0, y: 0, width: 1440, height: 120 },
  });
});
