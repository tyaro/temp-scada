import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("duplicate placements, undo/redo and stacking order survive file round-trip", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加" }).click();
  await page.getByRole("button", { name: "選択図形を複製" }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  const copyId = await svg
    .locator("[data-object-id]")
    .last()
    .getAttribute("data-object-id");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  const copy = svg.locator(`[data-object-id="${copyId}"]`);
  await copy.click();
  await page.getByRole("button", { name: "最背面へ", exact: true }).click();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-object-id]").last()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project JSON を保存");
  const downloaded = await downloading;
  const json = await readFile((await downloaded.path())!, "utf8"),
    saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(1);
  expect(saved.manifest.projectRevision).toBe(8);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "history.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "やり直す", exact: true }),
  ).toBeDisabled();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(page.getByRole("group", { name: "編集履歴" })).toHaveCount(0);
});
test("keyboard history ignores inputs, clears redo on a new edit and is inactive in preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "Rectangle を追加" }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const x = page.getByLabel("x", { exact: true });
  await x.focus();
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await page.getByRole("button", { name: "Rectangle を追加" }).focus();
  await page.keyboard.press("Control+d");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await page.keyboard.press("Control+Shift+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Text を追加" }).click();
  await expect(
    page.getByRole("button", { name: "やり直す", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
});
