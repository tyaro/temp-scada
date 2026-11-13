import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";

async function addPipe(page: Page, vertices: string) {
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "配管を追加" }).click();
  await page.getByLabel("頂点", { exact: true }).fill(vertices);
  await page.getByLabel("線幅", { exact: true }).fill("2");
  await page.getByLabel("X", { exact: true }).fill("40");
  await page.getByLabel("Y", { exact: true }).fill("40");
  await page.getByRole("button", { name: "変更を適用" }).click();
}

test("draws a junction dot where a pipe ends on another pipe, but not for a continuation", async ({
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
  const dots = svg.locator("circle[data-line-junction]");
  const before = await dots.count();
  await page.getByRole("button", { name: "編集", exact: true }).click();

  await addPipe(page, "0,0\n200,0");
  await expect(dots).toHaveCount(before);
  await addPipe(page, "100,0\n100,80");
  const branch = svg.locator("[data-object-id]").last();
  const branchId = await branch.getAttribute("data-object-id");
  const dot = svg.locator(`circle[data-line-junction="${branchId}"]`);
  await expect(dot).toHaveCount(1);
  await expect(dot).toHaveAttribute("cx", "140");
  await expect(dot).toHaveAttribute("cy", "40");
  await expect(dot).toHaveAttribute("r", "3");
  // 点は後に描かれる線の直後に置き、選択の対象にしない。
  expect(
    await dot.evaluate(
      (el) => el.previousElementSibling?.getAttribute("data-object-id") ?? "",
    ),
  ).toBe(branchId);
  await expect(dot).toHaveAttribute("pointer-events", "none");

  // 表示プレビュー（モックの読取）でも同じ点を描く。
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(svg.locator("circle[data-line-junction]")).toHaveCount(
    before + 1,
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();

  // 端点同士の継ぎ足しでは描かない。
  const vertices = page.getByLabel("頂点", { exact: true });
  await expect(vertices).toHaveValue("100,0\n100,80");
  await vertices.fill("200,0\n300,0");
  await page.getByRole("button", { name: "変更を適用" }).click();
  await expect(dots).toHaveCount(before);
  expect(errors).toEqual([]);
});
