import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("screen CRUD, history fallback and multiple-screen file round-trip", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "画面を追加", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const screens = page.getByRole("navigation", { name: "画面一覧" });
  await expect(button("画面を削除")).toBeDisabled();
  await button("画面を追加").click();
  await expect(
    page
      .getByRole("img", { name: "画面 2", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(0);
  await button("元に戻す").click();
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toBeVisible();
  await button("やり直す").click();
  await screens.getByRole("button", { name: "画面 2", exact: true }).click();
  await page.getByLabel("画面名", { exact: true }).fill("洗浄工程");
  await page.getByLabel("画面の幅", { exact: true }).fill("1200");
  await page.getByLabel("画面の高さ", { exact: true }).fill("700");
  await button("画面設定を適用").click();
  await expect(
    page.getByRole("img", { name: "洗浄工程", exact: true }),
  ).toHaveAttribute("viewBox", "0 0 1200 700");
  await button("ポンプを追加").click();
  await button("配管を追加").click();
  await button("画面を複製").click();
  await expect(
    page
      .getByRole("img", { name: "洗浄工程 コピー", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(2);
  page.once("dialog", (d) => d.dismiss());
  await button("画面を削除").click();
  await expect(screens.getByRole("button")).toHaveCount(3);
  page.once("dialog", (d) => d.accept());
  await button("画面を削除").click();
  await expect(screens.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toBeVisible();
  await button("元に戻す").click();
  await expect(screens.getByRole("button")).toHaveCount(3);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.screens).toHaveLength(3);
  expect(saved.symbols).toHaveLength(1);
  expect(saved.screens[1].objects[0].id).not.toBe(
    saved.screens[2].objects[0].id,
  );
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "screens.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(button("元に戻す")).toBeDisabled();
  await button("表示プレビュー").click();
  for (const name of ["洗浄工程", "洗浄工程 コピー"]) {
    await screens.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("img", { name, exact: true }).locator("[data-object-id]"),
    ).toHaveCount(2);
  }
  await expect(button("画面を削除")).toHaveCount(0);
});
