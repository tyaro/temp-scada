import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("searches basic/builtin/shared parts without changing the project and places shared definitions", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", { name: "部品パレット" });
  const search = palette.getByRole("searchbox", { name: "部品を検索" });
  await search.fill("ＰＵＭＰ");
  await expect(button("ポンプを追加")).toBeVisible();
  await expect(button("Rectangle を追加")).toHaveCount(0);
  await expect(button("元に戻す")).toBeDisabled();
  await button("ポンプを追加").click();
  await search.fill("ポンプ");
  await palette
    .getByRole("button", { name: "ポンプ を配置", exact: true })
    .click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  await expect(palette.locator("svg")).toHaveCount(2);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.symbols).toHaveLength(1);
  expect(saved.manifest.projectRevision).toBe(3);
  await button("元に戻す").click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(1);
  await search.fill("存在しない部品");
  await expect(palette).toContainText("一致する部品がありません");
  await button("検索をクリア").click();
  await expect(button("Rectangle を追加")).toBeVisible();
});
test("search is keyboard-safe and symbol definitions expose only primitive parts", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "プロジェクト");
  await button("Symbol 定義を作成").click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", { name: "部品パレット" });
  await expect(palette).toContainText("定義内は基本図形のみ");
  await expect(button("ポンプを追加")).toHaveCount(0);
  await expect(palette.getByRole("button", { name: /を配置/ })).toHaveCount(0);
  const search = palette.getByRole("searchbox", { name: "部品を検索" });
  await search.fill("テキスト");
  await search.press("Control+a");
  await search.press("Control+d");
  await expect(
    page
      .getByRole("img", { name: "Symbol 1", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(1);
  await button("Text を追加").click();
  await expect(
    page
      .getByRole("img", { name: "Symbol 1", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(2);
  await button("画面へ戻る").click();
  await button("表示プレビュー").click();
  await expect(palette).toHaveCount(0);
});
