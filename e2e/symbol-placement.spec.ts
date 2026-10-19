import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process.project.json" with { type: "json" };

test("replaces a symbol reference only after apply, preserving placement and respecting draft cancellation", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await selectPanel(page, "プロジェクト");
  await button("工程図サンプルを開く").click();
  await button("編集").click();
  const object = sample.screens[0].objects.find(
    (o) => o.shape.type === "symbol",
  )!;
  const sourceId = (object.shape as { symbolId: string }).symbolId;
  const target = sample.symbols.find(
    (definition) => definition.id !== sourceId,
  )!;
  const svg = page.getByRole("img", {
    name: "循環設備（静的サンプル）",
    exact: true,
  });
  const placement = svg.locator(`[data-object-id="${object.id}"]`);
  await placement.click();
  const geometry = await placement.getAttribute("transform");
  const selector = page.getByLabel("参照する Symbol 定義", { exact: true });
  await selector.selectOption(target.id);
  await expect(placement.locator("[data-symbol-id]")).toHaveAttribute(
    "data-symbol-id",
    sourceId,
  );
  await button("表示プレビュー").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(selector).toHaveValue(target.id);
  await button("変更を適用").click();
  await expect(placement.locator("[data-symbol-id]")).toHaveAttribute(
    "data-symbol-id",
    target.id,
  );
  await expect(placement).toHaveAttribute("transform", geometry!);
  await expect(page.getByLabel("width", { exact: true })).toHaveValue(
    String((object as { width: number }).width),
  );
  await button("元に戻す").click();
  await expect(selector).toHaveValue(sourceId);
  await button("やり直す").click();
  await expect(selector).toHaveValue(target.id);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.symbols).toEqual(sample.symbols);
  expect(saved.screens[0].objects.find((o: any) => o.id === object.id)).toEqual(
    { ...object, shape: { type: "symbol", symbolId: target.id } },
  );
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "replaced.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(placement.locator("[data-symbol-id]")).toHaveAttribute(
    "data-symbol-id",
    target.id,
  );
  await button("表示プレビュー").click();
  await expect(selector).toHaveCount(0);
});

test("deep copies a definition for one placement, edits it independently and undoes the copy atomically", async ({
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
  const screens = page.getByRole("navigation", { name: "画面一覧" });
  const list = page.getByRole("navigation", { name: "図形一覧" });
  await selectPanel(page, "レイヤー");
  await list.getByRole("button", { name: /^ポンプ/ }).click();
  const originalSymbol = await page
    .getByLabel("参照する Symbol 定義", { exact: true })
    .inputValue();
  await button("定義を複製してこの配置に適用").click();
  await expect(page.getByRole("note")).toContainText("1 配置で共有");
  await expect(page.getByLabel("Symbol 名", { exact: true })).toHaveValue(
    "ポンプ コピー",
  );
  await button("元に戻す").click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await selectPanel(page, "レイヤー");
  await list.getByRole("button", { name: /^ポンプ/ }).click();
  await expect(
    page.getByLabel("参照する Symbol 定義", { exact: true }),
  ).toHaveValue(originalSymbol);
  await button("やり直す").click();
  const uniqueSymbol = await page
    .getByLabel("参照する Symbol 定義", { exact: true })
    .inputValue();
  expect(uniqueSymbol).not.toBe(originalSymbol);
  await button("参照する Symbol 定義を編集").click();
  const originalCount = await page
    .getByRole("img", { name: "ポンプ コピー", exact: true })
    .locator("[data-object-id]")
    .count();
  await selectPanel(page, "部品");
  await button("Rectangle を追加").click();
  await button("画面へ戻る").click();
  await expect(
    page
      .getByRole("region", { name: "キャンバス操作領域", exact: true })
      .locator(`[data-symbol-id="${uniqueSymbol}"] > g`),
  ).toHaveCount(originalCount + 1);
  await selectPanel(page, "プロジェクト");
  await screens
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "キャンバス操作領域", exact: true })
      .locator(`[data-symbol-id="${originalSymbol}"] > g`),
  ).toHaveCount(originalCount);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(2);
  expect(saved.screens[0].objects.at(-1).shape.symbolId).toBe(originalSymbol);
  expect(saved.screens[1].objects.at(-1).shape.symbolId).toBe(uniqueSymbol);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "unique.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await selectPanel(page, "プロジェクト");
  await screens
    .getByRole("button", { name: "プロセス画面 コピー", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "キャンバス操作領域", exact: true })
      .locator(`[data-symbol-id="${uniqueSymbol}"] > g`),
  ).toHaveCount(originalCount + 1);
});
