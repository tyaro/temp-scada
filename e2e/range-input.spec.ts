import { test, expect } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
test("range selection commits a focused number before starting, keeps invalid input, and adds no selection history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
  await selectPanel(page, "レイヤー");
  const rectangle = page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true });
  await rectangle.click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  async function drag() {
    const points = await svg.evaluate((el) =>
      [
        { x: 80, y: 150 },
        { x: 730, y: 370 },
      ].map((p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform(
          (el as SVGSVGElement).getScreenCTM()!,
        );
        return { x: q.x, y: q.y };
      }),
    );
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
    await page.mouse.up();
  }
  await page.getByLabel("x", { exact: true }).fill("110");
  await drag();
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await rectangle.click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("x", { exact: true }).fill("NaN");
  await drag();
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("NaN");
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("NaN");
  await page.getByLabel("x", { exact: true }).press("Escape");
  await page.getByLabel("x", { exact: true }).dispatchEvent("compositionstart");
  await page.getByLabel("x", { exact: true }).fill("220");
  await drag();
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(prompt).not.toBeVisible();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("220");
  await page.getByLabel("x", { exact: true }).dispatchEvent("compositionend");
});
