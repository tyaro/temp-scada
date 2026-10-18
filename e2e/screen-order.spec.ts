import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("screen order is explicit, protected by draft handling and preserved by undo and file reload", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const screens = page.getByRole("navigation", { name: "画面一覧" });
  await button("編集").click();
  await expect(button("画面を上へ")).toBeDisabled();
  await expect(button("画面を下へ")).toBeDisabled();
  await selectPanel(page, "プロジェクト");
  await button("画面を追加").click();
  await button("画面を追加").click();
  await expect(screens.getByRole("button")).toHaveText([
    "プロセス画面",
    "画面 2",
    "画面 3",
  ]);
  await expect(button("画面を下へ")).toBeDisabled();
  await page.getByLabel("画面名", { exact: true }).fill("仕上工程");
  await button("画面を上へ").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(screens.getByRole("button")).toHaveText([
    "プロセス画面",
    "画面 2",
    "画面 3",
  ]);
  await button("画面を上へ").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(screens.getByRole("button")).toHaveText([
    "プロセス画面",
    "仕上工程",
    "画面 2",
  ]);
  await expect(
    screens.getByRole("button", { name: "仕上工程", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await button("元に戻す").click();
  await expect(screens.getByRole("button")).toHaveText([
    "プロセス画面",
    "画面 2",
    "仕上工程",
  ]);
  await button("やり直す").click();
  await button("画面を上へ").click();
  await expect(button("画面を上へ")).toBeDisabled();
  await expect(screens.getByRole("button")).toHaveText([
    "仕上工程",
    "プロセス画面",
    "画面 2",
  ]);
  await button("画面を下へ").click();
  await expect(screens.getByRole("button")).toHaveText([
    "プロセス画面",
    "仕上工程",
    "画面 2",
  ]);
  await button("画面を上へ").click();
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.screens.map((s: any) => s.name)).toEqual([
    "仕上工程",
    "プロセス画面",
    "画面 2",
  ]);
  await screens
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "ordered.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(
    page.getByRole("img", { name: "仕上工程", exact: true }),
  ).toBeVisible();
  await expect(button("元に戻す")).toBeDisabled();
  await button("表示プレビュー").click();
  await expect(button("画面を上へ")).toHaveCount(0);
  await expect(screens.getByRole("button")).toHaveText([
    "仕上工程",
    "プロセス画面",
    "画面 2",
  ]);
});
