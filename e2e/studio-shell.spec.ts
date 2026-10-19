import { test, expect, type Page } from "@playwright/test";
import { chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const strip = (page: Page) =>
  page.getByRole("navigation", { name: "画面タブ", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await button(page, "画面を追加").click();
}
test("screen strip uses guarded switching, manual keyboard activation and existing context actions", async ({
  page,
}) => {
  await start(page);
  await strip(page)
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  const current = strip(page).getByRole("button", {
    name: "プロセス画面",
    exact: true,
  });
  const second = strip(page).getByRole("button", {
    name: "画面 2",
    exact: true,
  });
  await current.focus();
  await current.press("ArrowRight");
  await expect(second).toBeFocused();
  await expect(current).toHaveAttribute("aria-current", "page");
  await page.getByLabel("画面名", { exact: true }).fill("保護する画面名");
  await second.click();
  const dialog = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "保護する画面名",
  );
  await second.click();
  await dialog
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(second).toHaveAttribute("aria-current", "page");
  await expect(
    strip(page).getByRole("button", { name: "保護する画面名", exact: true }),
  ).toBeVisible();
  await second.click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前変更", exact: true }).click();
  await expect(page.getByLabel("画面名", { exact: true })).toBeFocused();
});
test("studio chrome follows Banto themes while Project background and hidden panels retain their contracts", async ({
  page,
}) => {
  await start(page);
  const background = page.getByLabel("画面の背景色", { exact: true });
  const before = await background.inputValue();
  for (const theme of ["light", "dark", "system"]) {
    await chooseTheme(page, theme);
    await expect(background).toHaveValue(before);
    await expect(strip(page)).toBeVisible();
    await expect(page.getByRole("menubar")).toBeVisible();
  }
  await button(page, "左パネルを隠す").click();
  await strip(page)
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await expect(
    strip(page).getByRole("button", { name: "プロセス画面", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "表示プレビュー").click();
  await strip(page)
    .getByRole("button", { name: "画面 2", exact: true })
    .click();
  await expect(
    strip(page).getByRole("button", { name: "画面 2", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    strip(page).getByRole("button", { name: /^操作：/ }),
  ).toHaveCount(0);
});

test("overflowing screen tabs reveal active screens and keyboard targets without page overflow", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  for (let i = 0; i < 16; i++) await button(page, "画面を追加").click();
  const last = strip(page).locator("[data-screen-tab]").last();
  await expect(last).toHaveAttribute("aria-current", "page");
  await expect
    .poll(() => strip(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await last.focus();
  await last.press("Home");
  const first = strip(page).locator("[data-screen-tab]").first();
  await expect(first).toBeFocused();
  await expect(last).toHaveAttribute("aria-current", "page");
  await first.press("Enter");
  await expect(first).toHaveAttribute("aria-current", "page");
  await expect
    .poll(() =>
      first.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const nav = el.closest("nav")!.getBoundingClientRect();
        return rect.left >= nav.left && rect.right <= nav.right;
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
