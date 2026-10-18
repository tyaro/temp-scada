import { test, expect } from "@playwright/test";
test("desktop workspace keeps properties beside the canvas and scrolls tools independently", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "工程図サンプルを開く", exact: true })
    .click();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Project と部品" });
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: /ポンプ/ })
    .first()
    .click();
  const svg = page.getByRole("img", {
    name: "循環設備（静的サンプル）",
    exact: true,
  });
  const before = (await svg.boundingBox())!;
  const inspector = page.getByRole("complementary", {
    name: "プロパティパネル",
  });
  expect((await inspector.boundingBox())!.x).toBeGreaterThan(
    before.x + before.width,
  );
  await sidebar.evaluate((el) => (el.scrollTop = 0));
  const after = (await svg.boundingBox())!;
  expect(after).toEqual(before);
  await expect(page.getByLabel("x", { exact: true })).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("editor.png") });
  await page
    .getByRole("button", { name: "参照する Symbol 定義を編集", exact: true })
    .click();
  await expect(page.getByRole("note")).toContainText("Symbol 定義を編集中");
  await expect(
    page.getByRole("img", { name: "ポンプ", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button")
    .first()
    .click();
  const vertex = page
    .getByRole("img", { name: "ポンプ", exact: true })
    .locator("[data-vertex-index]")
    .first();
  // 12px の直径と、非拡大の 1.5px の枠線を含む外形。
  expect((await vertex.boundingBox())!.width).toBeCloseTo(13.5, 1);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect
    .poll(async () => (await vertex.boundingBox())!.width)
    .toBeCloseTo(13.5, 1);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("symbol-editor.png") });
});
test("small screens stack editor controls without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "配管を追加", exact: true }).click();
  await expect(page.getByLabel("頂点", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
