import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";

test("draws arrows at the start, end or both ends of a pipe", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await selectPanel(page, "プロジェクト");
  await fileCommand(page, "工程図サンプルを開く");
  const svg = page.getByRole("img", {
    name: "循環設備（静的サンプル）",
    exact: true,
  });
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "配管を追加" }).click();
  await page.getByLabel("頂点", { exact: true }).fill("0,0\n100,0\n100,60");
  await page.getByLabel("線幅", { exact: true }).fill("2");
  const arrow = page.getByLabel("矢印", { exact: true });
  await expect(arrow.locator("option")).toHaveText([
    "なし",
    "始点",
    "終点",
    "両端",
  ]);
  const pipe = svg.locator("[data-object-id]").last();
  for (const [value, heads] of [
    ["both", ["0,0 8,-4 8,4", "100,60 96,52 104,52"]],
    ["start", ["0,0 8,-4 8,4"]],
    ["end", ["100,60 96,52 104,52"]],
    ["none", []],
  ] as const) {
    await arrow.selectOption(value);
    await page.getByRole("button", { name: "変更を適用" }).click();
    const polygons = pipe.locator("polygon");
    await expect(polygons).toHaveCount(heads.length);
    for (let i = 0; i < heads.length; i++)
      await expect(polygons.nth(i)).toHaveAttribute("points", heads[i]);
  }
  await page.getByRole("button", { name: "元に戻す" }).first().click();
  await expect(pipe.locator("polygon")).toHaveCount(1);
  expect(errors).toEqual([]);
});
