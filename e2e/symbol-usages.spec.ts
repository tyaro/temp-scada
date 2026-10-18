import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const usages = (page: Page) =>
  page.getByRole("region", { name: "共有定義の使用先", exact: true });
const canvas = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page, duplicate = false) {
  await page.goto("/");
  await button(page, "工程図サンプルを開く").click();
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
  if (duplicate) {
    await button(page, "画面を複製").click();
    await page.getByLabel("画面名", { exact: true }).fill("予備系統");
    await button(page, "画面設定を適用").click();
  }
}
async function show(page: Page, name = "ポンプ") {
  await button(page, `共有定義：${name}`).click({ button: "right" });
  await page
    .getByRole("menu", { name: `共有定義：${name} の操作`, exact: true })
    .getByRole("menuitem", { name: "使用先を確認", exact: true })
    .click();
}

test("usage inspection and search are read-only, preserve drafts and return focus on close", async ({
  page,
}) => {
  await start(page, true);
  await page.getByLabel("画面名", { exact: true }).fill("未適用の画面名");
  const before = await page.getByTestId("save-state").innerText();
  await show(page);
  await expect(usages(page)).toContainText("2 配置 / 2 画面");
  const search = page.getByLabel("共有定義の使用先を検索", { exact: true });
  await expect(search).toBeFocused();
  await search.fill("予備");
  await expect(
    usages(page).getByRole("button", { name: /を表示$/ }),
  ).toHaveCount(1);
  await search.fill("存在しない画面");
  await expect(usages(page)).toContainText("一致する使用先がありません");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の画面名",
  );
  expect(await page.getByTestId("save-state").innerText()).toBe(before);
  await usages(page)
    .getByRole("button", { name: "使用先一覧を閉じる", exact: true })
    .click();
  await expect(button(page, "共有定義：ポンプ")).toBeFocused();
});

test("jumping out of definition editing protects drafts, selects the placement and keeps its zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await start(page, true);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await canvas(page).evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  });
  await button(page, "定義を編集").click();
  await page.getByLabel("Symbol 名", { exact: true }).fill("循環ポンプ");
  await show(page);
  const target = usages(page).getByRole("button", {
    name: "予備系統 の Symbol 10 を表示",
    exact: true,
  });
  await target.click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByRole("note")).toBeVisible();
  await expect(usages(page)).toBeVisible();
  await expect(page.getByLabel("Symbol 名", { exact: true })).toHaveValue(
    "循環ポンプ",
  );
  await target.click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "予備系統", exact: true }),
  ).toBeVisible();
  await expect(canvas(page)).toBeFocused();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("4");
  const selected = page.locator('[data-object-id][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  const viewport = (await canvas(page).boundingBox())!,
    bounds = (await selected.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(viewport.x);
  expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    viewport.x + viewport.width,
  );
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    viewport.y + viewport.height,
  );
  await expect(usages(page)).toContainText("循環ポンプ の使用先");
});

test("usage navigation supports multiple screens, reflects deletion and undo, and preserves search across tabs", async ({
  page,
}) => {
  await start(page, true);
  await button(page, "使用先を確認").click();
  const target = usages(page).getByRole("button", {
    name: "循環設備（静的サンプル） の Symbol 10 を表示",
    exact: true,
  });
  await target.click();
  await expect(
    page.getByRole("img", { name: "循環設備（静的サンプル）", exact: true }),
  ).toBeVisible();
  await button(page, "選択図形を削除").click();
  await expect(usages(page)).toContainText("1 配置 / 1 画面");
  await button(page, "元に戻す").click();
  await expect(usages(page)).toContainText("2 配置 / 2 画面");
  await page.getByLabel("共有定義の使用先を検索", { exact: true }).fill("予備");
  await selectPanel(page, "部品");
  await selectPanel(page, "プロジェクト");
  await expect(
    page.getByLabel("共有定義の使用先を検索", { exact: true }),
  ).toHaveValue("予備");
  await expect(
    usages(page).getByRole("button", { name: /を表示$/ }),
  ).toHaveCount(1);
});

test("a reference changed while applying drafts cancels the old navigation target", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await page
    .getByLabel("参照する Symbol 定義", { exact: true })
    .selectOption({ label: "バルブ · 1 配置" });
  await selectPanel(page, "プロジェクト");
  await show(page);
  await usages(page)
    .getByRole("button", { name: /を表示$/ })
    .click();
  await page
    .getByRole("dialog", { name: "未適用の入力があります" })
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "使用先が変更されたため移動を中止しました。" })
      .first(),
  ).toBeVisible();
  await expect(usages(page)).toContainText(
    "この共有定義を使用している配置はありません",
  );
});

test("empty usage lists are explicit and importing the same project clears the open list", async ({
  page,
}) => {
  await start(page);
  await button(page, "Symbol 定義を作成").click();
  await button(page, "使用先を確認").click();
  await expect(usages(page)).toContainText(
    "この共有定義を使用している配置はありません",
  );
  const pending = page.waitForEvent("download");
  await button(page, "Project JSON を保存").click();
  const file = {
    name: "same.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      await readFile((await (await pending).path())!, "utf8"),
    ),
  };
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles(file);
  await expect(usages(page)).toHaveCount(0);
  await button(page, "共有定義：ポンプ").click();
  await button(page, "使用先を確認").click();
  await expect(usages(page)).toContainText("1 配置 / 1 画面");
  await button(page, "表示プレビュー").click();
  await expect(usages(page)).toHaveCount(0);
});
