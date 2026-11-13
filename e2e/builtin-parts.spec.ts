import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const palette = (page: Page) =>
  page.getByRole("region", { name: "部品パレット", exact: true });

async function save(page: Page) {
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}

test("finds flow-diagram parts by alias and places them at their own size", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  const search = palette(page).getByRole("searchbox", { name: "部品を検索" });
  await expect(
    palette(page).getByRole("button", { name: /を追加$/ }),
  ).toHaveCount(
    // 基本図形 6 + 組込 11
    17,
  );

  await search.fill("集じん");
  await expect(
    palette(page).getByRole("button", { name: /を追加$/ }),
  ).toHaveCount(1);
  await expect(button(page, "サイクロンを追加")).toBeVisible();
  await button(page, "サイクロンを追加").click();

  await search.fill("column");
  await button(page, "塔を追加").click();

  const project = await save(page);
  const symbols = project.symbols.map(
    (s: { name: string; width: number; height: number }) => [
      s.name,
      s.width,
      s.height,
    ],
  );
  expect(symbols).toEqual([
    ["サイクロン", 100, 120],
    ["塔", 60, 160],
  ]);
  const placed = project.screens[0].objects.slice(-2);
  expect(
    placed.map((o: { width: number; height: number }) => [o.width, o.height]),
  ).toEqual([
    [100, 120],
    [60, 160],
  ]);
});
