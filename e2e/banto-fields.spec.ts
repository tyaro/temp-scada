import { expect, test } from "@playwright/test";
import { chooseTheme, selectPanel } from "./helpers/designer";

for (const theme of ["light", "dark"]) {
  test(`Banto field styles reach form, search and toolbar controls in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "部品");
    await page
      .getByRole("button", { name: "Rectangle を追加", exact: true })
      .click();

    const controls = [
      page.getByLabel("表示倍率", { exact: true }),
      page.getByLabel("グリッド間隔", { exact: true }),
      page.getByPlaceholder("部品を検索", { exact: true }),
      page.locator('[data-editor-form="shape-paint"] select[name="fillType"]'),
      page.locator('.placement-name input[name="name"]'),
    ];
    for (const control of controls) {
      await expect(control).toHaveClass(/banto-field-control/);
      const style = await control.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          background: computed.backgroundColor,
          top: computed.borderTopWidth,
          bottom: computed.borderBottomWidth,
        };
      });
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.top).toBe("0px");
      expect(Number.parseFloat(style.bottom)).toBeGreaterThan(0);
    }
  });
}
