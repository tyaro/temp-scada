import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("shared definition edits update placements across screens and survive history and JSON", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "部品");
  await button("ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button("画面を複製").click();
  await button("定義を編集").click();
  await expect(page.getByRole("note")).toContainText("2 配置で共有");
  await expect(button("ポンプを追加")).toHaveCount(0);
  await expect(button("定義を削除")).toBeDisabled();
  await page.getByLabel("Symbol 名", { exact: true }).fill("循環ポンプ");
  await button("Symbol 設定を適用").click();
  await selectPanel(page, "部品");
  await button("Rectangle を追加").click();
  let numericChanges = 0;
  for (const [name, value] of [
    ["x", "10"],
    ["y", "20"],
    ["width", "30"],
    ["height", "25"],
  ]) {
    const input = page.getByLabel(name, { exact: true });
    if (Number(await input.inputValue()) !== Number(value)) numericChanges++;
    await input.fill(value);
  }
  await button("変更を適用").click();
  const symbolCanvas = page.getByRole("img", {
    name: "循環ポンプ",
    exact: true,
  });
  const childCount = await symbolCanvas.locator("[data-object-id]").count();
  // Added shape plus each changed numeric value; equal values are not undo entries.
  for (let i = 0; i < 1 + numericChanges; i++) await button("元に戻す").click();
  await expect(symbolCanvas.locator("[data-object-id]")).toHaveCount(
    childCount - 1,
  );
  for (let i = 0; i < 1 + numericChanges; i++) await button("やり直す").click();
  await expect(symbolCanvas.locator("[data-object-id]")).toHaveCount(
    childCount,
  );
  await button("画面へ戻る").click();
  const screens = page.getByRole("navigation", { name: "画面一覧" });
  for (const name of ["プロセス画面", "プロセス画面 コピー"]) {
    await selectPanel(page, "プロジェクト");
    await screens.getByRole("button", { name, exact: true }).click();
    await expect(
      page
        .getByRole("img", { name, exact: true })
        .locator("[data-symbol-id] > g"),
    ).toHaveCount(childCount);
  }
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(1);
  expect(saved.symbols[0].name).toBe("循環ポンプ");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "symbols.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await selectPanel(page, "プロジェクト");
  await button("定義を編集").click();
  await expect(
    page
      .getByRole("img", { name: "循環ポンプ", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(childCount);
});
test("custom definition creation, duplication, placement, guarded deletion and undo fallback", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "プロジェクト");
  await button("Symbol 定義を作成").click();
  await expect(
    page.getByRole("img", { name: "Symbol 1", exact: true }),
  ).toBeVisible();
  await button("元に戻す").click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await button("やり直す").click();
  await button("定義を編集").click();
  await selectPanel(page, "部品");
  await button("Ellipse を追加").click();
  await selectPanel(page, "プロジェクト");
  await button("定義を複製").click();
  await expect(
    page
      .getByRole("img", { name: "Symbol 1 コピー", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(2);
  page.once("dialog", (d) => d.dismiss());
  await button("定義を削除").click();
  await expect(page.getByRole("note")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await button("定義を削除").click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await button("定義を編集").click();
  await button("画面へ戻る").click();
  await button("画面に配置").click();
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-symbol-id]"),
  ).toHaveCount(1);
  await expect(button("定義を削除")).toBeDisabled();
  await button("表示プレビュー").click();
  await expect(button("Symbol 定義を作成")).toHaveCount(0);
});
