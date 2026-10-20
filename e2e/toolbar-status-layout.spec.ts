import { test, expect } from "@playwright/test";
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`save and draft state preserve toolbar height across viewport widths in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await chooseTheme(page, theme);
    await selectPanel(page, "レイヤー");
    await page
      .getByRole("navigation", { name: "図形一覧", exact: true })
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await page.evaluate(() => document.fonts.ready);
    const toolbar = page.getByRole("toolbar", {
        name: "共通編集ツールバー",
        exact: true,
      }),
      status = page.getByTestId("save-state"),
      x = page.getByLabel("x", { exact: true });
    const height = () =>
      toolbar.evaluate((el) => el.getBoundingClientRect().height);
    for (const [index, width] of [
      1920, 1840, 1760, 1680, 1600, 1440, 1280, 1100, 900, 650,
    ].entries()) {
      await page.setViewportSize({ width, height: 1080 });
      const baseline = await height();
      await x.fill(String(320 + index));
      await expect(status).toContainText("未適用の入力あり");
      expect(await height(), `draft at ${width}px`).toBe(baseline);
      await x.press("Enter");
      await expect(status).not.toContainText("未適用の入力あり");
      expect(await height(), `commit at ${width}px`).toBe(baseline);
    }
    const before = await height(),
      pending = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    await pending;
    await expect(status).toContainText("書き出し要求後の変更なし");
    expect(await height()).toBe(before);
  });
