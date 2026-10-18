import { test, expect } from "@playwright/test";
test("Banto theme persists, follows OS changes and leaves Project colors unchanged", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const svg = page.getByRole("img", { name: "プロセス画面" });
  const original = await svg
    .locator("[data-object-id] rect")
    .first()
    .getAttribute("fill");
  await page.getByLabel("テーマ", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const bodyColor = await page
    .locator("body")
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  const tokenColor = await page
    .locator("html")
    .evaluate((e) => getComputedStyle(e).getPropertyValue("--banto-bg").trim());
  expect(bodyColor).not.toBe("");
  expect(tokenColor).not.toBe("");
  await page.reload();
  await expect(page.getByLabel("テーマ", { exact: true })).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByLabel("テーマ", { exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkColor = await page
    .locator("body")
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(darkColor).not.toBe(bodyColor);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(svg.locator("[data-object-id] rect").first()).toHaveAttribute(
    "fill",
    original!,
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "Rectangle を追加" }).click();
  await expect(page.locator(".toast-host")).toContainText("変更を適用しました");
  await expect(
    page.getByRole("heading", { name: "プロパティ", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/scada-banto-light.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("unavailable browser storage does not prevent local editing", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByLabel("テーマ", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("alert")).toContainText("このタブだけに適用");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "Ellipse を追加" }).click();
  await expect(
    page.getByRole("img", { name: "プロセス画面" }).locator("[data-object-id]"),
  ).toHaveCount(4);
});
