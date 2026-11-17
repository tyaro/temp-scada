import {
  addScreen,
  currentScreenAction,
  currentScreenMenuItem,
  fileCommand,
  selectPanel,
} from "./helpers/designer";
import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

/** The active screen's context menu shows each item's limit. */
async function expectScreenItemsDisabled(page: Page, ...names: string[]) {
  for (const name of names) {
    await expect(await currentScreenMenuItem(page, name)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");
  }
}

test("screen order is explicit, applied with pending drafts and preserved by undo and file reload", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const screens = page.getByRole("navigation", { name: "画面一覧" });
  await button("編集").click();
  await expectScreenItemsDisabled(page, "画面を上へ", "画面を下へ");
  await selectPanel(page, "プロジェクト");
  await addScreen(page);
  await addScreen(page);
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "プロセス画面",
    "画面 2",
    "画面 3",
  ]);
  await expectScreenItemsDisabled(page, "画面を下へ");
  await page.getByLabel("画面名", { exact: true }).fill("仕上工程");
  // 離れたら確定: 画面名が確認なしで適用され、そのまま並べ替わる。
  await currentScreenAction(page, "画面を上へ");
  await expect(
    page.getByRole("dialog", { name: "未適用の入力があります" }),
  ).toHaveCount(0);
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "プロセス画面",
    "仕上工程",
    "画面 2",
  ]);
  await expect(
    screens.getByRole("button", { name: "仕上工程", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await button("元に戻す").click();
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "プロセス画面",
    "画面 2",
    "仕上工程",
  ]);
  await button("やり直す").click();
  await currentScreenAction(page, "画面を上へ");
  await expectScreenItemsDisabled(page, "画面を上へ");
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "仕上工程",
    "プロセス画面",
    "画面 2",
  ]);
  await currentScreenAction(page, "画面を下へ");
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "プロセス画面",
    "仕上工程",
    "画面 2",
  ]);
  await currentScreenAction(page, "画面を上へ");
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
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
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "ordered.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(
    page.getByRole("img", { name: "仕上工程", exact: true }),
  ).toBeVisible();
  await expect(button("元に戻す")).toBeDisabled();
  await button("表示プレビュー").click();
  await expect(
    page.getByRole("button", { name: /^操作：画面タブ：/ }),
  ).toHaveCount(0);
  await expect(screens.locator("button[aria-pressed]")).toHaveText([
    "仕上工程",
    "プロセス画面",
    "画面 2",
  ]);
});
