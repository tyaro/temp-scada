import { test, expect, type Page } from "@playwright/test";
const trigger = (p: Page) =>
  p.getByRole("button", { name: "メニュー", exact: true });
const popup = (p: Page) =>
  p.getByRole("menu", { name: "常設メニュー", exact: true });
async function start(p: Page) {
  await p.setViewportSize({ width: 960, height: 480 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
}
async function bounds(p: Page) {
  const b = (await popup(p).boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(p.viewportSize()!.height);
}
test("long permanent menu fits the viewport and keeps keyboard and wheel scrolling open", async ({
  page,
}) => {
  await start(page);
  await trigger(page).press("ArrowUp");
  await expect(popup(page)).toBeVisible();
  await bounds(page);
  const last = popup(page).getByRole("menuitem", {
    name: "操作ガイド・アプリ情報",
    exact: true,
  });
  await expect(last).toBeFocused();
  await expect
    .poll(() => popup(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Home");
  await expect(popup(page).getByRole("menuitem").first()).toBeFocused();
  await popup(page).hover();
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => popup(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});
test("an open menu remeasures available height before Banto repositions on resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await trigger(page).click();
  await expect(popup(page)).toBeVisible();
  await page.setViewportSize({ width: 960, height: 480 });
  await expect(popup(page)).toBeVisible();
  await expect
    .poll(async () => {
      const b = (await popup(page).boundingBox())!;
      return b.y + b.height;
    })
    .toBeLessThanOrEqual(480);
  await bounds(page);
  await page.keyboard.press("End");
  await expect(
    popup(page).getByRole("menuitem", {
      name: "操作ガイド・アプリ情報",
      exact: true,
    }),
  ).toBeFocused();
});
test("outside canvas scrolling still dismisses a bounded menu", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await trigger(page).click();
  await expect(popup(page)).toBeVisible();
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .evaluate((el) => {
      el.scrollTop += 80;
    });
  await expect(popup(page)).toHaveCount(0);
});
