import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const name = (page: Page) => page.getByLabel("配置名", { exact: true });
const layers = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧" });
async function start(page: Page, project: object = minimal) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function download(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await waiting;
  return JSON.parse(await readFile((await file.path())!, "utf8"));
}
test("names are guarded drafts, searchable without hiding the canvas, and undoable after falling outside the query", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const canvas = page.getByRole("img", { name: "プロセス画面", exact: true });
  await name(page).fill("  P-101 原水ポンプ A  ");
  await page.getByLabel("x", { exact: true }).focus();
  await expect(
    layers(page).getByRole("button", { name: "rectangle · 3", exact: true }),
  ).toBeVisible();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "変更を適用").click();
  await expect(name(page)).toHaveValue("P-101 原水ポンプ A");
  const named = layers(page).getByRole("button", {
    name: "P-101 原水ポンプ A",
    exact: true,
  });
  await expect(named).toHaveAttribute("aria-pressed", "true");
  await expect(named).toHaveAttribute("title", /rectangle · 3/);
  const search = page.getByLabel("レイヤーを検索", { exact: true });
  await search.fill("原水ポンプ");
  await name(page).fill("P-102 送水ポンプ");
  await button(page, "変更を適用").click();
  await expect(named).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "選択中の配置は検索条件外" }),
  ).toBeVisible();
  await expect(name(page)).toHaveValue("P-102 送水ポンプ");
  await expect(canvas.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(canvas.locator("[data-object-id]")).toHaveCount(3);
  await button(page, "元に戻す").click();
  await expect(named).toHaveAttribute("aria-pressed", "true");
  await expect(name(page)).toHaveValue("P-101 原水ポンプ A");
  await search.fill("rectangle");
  await expect(named).toBeVisible();
  await search.fill("rectangle · 3");
  await expect(named).toBeVisible();
});
test("names keep native text editing and draft cancel/discard; normalized no-ops add no history", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await name(page).fill("保存しない名前");
  await name(page).dispatchEvent("compositionstart");
  await name(page).dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await expect(button(page, "元に戻す")).toBeDisabled();
  await name(page).dispatchEvent("compositionend");
  await layers(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(name(page)).toHaveValue("保存しない名前");
  await layers(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(name(page)).toHaveValue("");
  await name(page).fill("   ");
  await button(page, "変更を適用").click();
  await expect(name(page)).toHaveValue("");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await name(page).fill("円");
  await button(page, "変更を適用").click();
  await name(page).fill(" 円 ");
  await button(page, "変更を適用").click();
  await expect(name(page)).toHaveValue("円");
  await button(page, "元に戻す").click();
  await expect(name(page)).toHaveValue("");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("duplicate names survive duplication and JSON; clearing restores fallback without changing Text or binding", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await name(page).fill("TK-101 液位");
  await page
    .getByLabel("表示タグ（外部名）", { exact: true })
    .fill("Exact.Tag.Name");
  await button(page, "変更を適用").click();
  await button(page, "選択図形を複製").click();
  await expect(
    layers(page).getByRole("button", { name: "TK-101 液位", exact: true }),
  ).toHaveCount(2);
  const project = await download(page);
  expect(project.manifest.schemaVersion).toBe("0.11.0");
  const named = project.screens[0].objects.filter(
    (o: any) => o.name === "TK-101 液位",
  );
  expect(named).toHaveLength(2);
  expect(named[0].id).not.toBe(named[1].id);
  expect(
    named.every(
      (o: any) =>
        o.shape.text === "BANTO / SCADA — Sample" &&
        o.shape.binding.externalName === "Exact.Tag.Name",
    ),
  ).toBe(true);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "names.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await layers(page)
    .getByRole("button", { name: "TK-101 液位", exact: true })
    .first()
    .click();
  await name(page).fill("");
  await button(page, "変更を適用").click();
  await expect(
    layers(page).getByRole("button", { name: "text · 5", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("Exact.Tag.Name");
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "BANTO / SCADA — Sample",
  );
});
test("Symbol placement names and definition-child names have separate scopes and named usages", async ({
  page,
}) => {
  await start(page, processSample);
  await layers(page)
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await name(page).fill("P-101 原水ポンプ A");
  await button(page, "変更を適用").click();
  await expect(
    page
      .getByLabel("参照する Symbol 定義", { exact: true })
      .locator("option:checked"),
  ).toContainText("ポンプ");
  await button(page, "参照する Symbol 定義を編集").click();
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "polyline · 0", exact: true })
    .click();
  await name(page).fill("ポンプ本体線");
  await button(page, "変更を適用").click();
  await expect(
    layers(page).getByRole("button", { name: "ポンプ本体線", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("共有定義内の名前は同じ定義を使う全配置で共用します。", {
      exact: false,
    }),
  ).toBeVisible();
  const result = await download(page);
  expect(result.screens[0].objects[10].name).toBe("P-101 原水ポンプ A");
  expect(result.symbols[0].name).toBe("ポンプ");
  expect(result.symbols[0].objects[0].name).toBe("ポンプ本体線");
});

test("named Symbol and Text usage search navigates by IDs even with equal names", async ({
  page,
}) => {
  const project: any = structuredClone(processSample);
  project.screens[0].objects[10].name = "送水設備";
  project.screens[0].objects[6].name = "送水設備";
  project.screens[0].objects[6].shape.binding = { externalName: "Exact.Level" };
  await start(page, project);
  await selectPanel(page, "プロジェクト");
  await button(page, "共有定義：ポンプ").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "使用先を確認", exact: true })
    .click();
  const usages = page.getByRole("region", {
    name: "共有定義の使用先",
    exact: true,
  });
  await page
    .getByLabel("共有定義の使用先を検索", { exact: true })
    .fill("送水設備");
  await usages
    .getByRole("button", { name: /送水設備（Symbol 10） を表示$/ })
    .click();
  await expect(name(page)).toHaveValue("送水設備");
  await expect(
    page.getByLabel("参照する Symbol 定義", { exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Project のタグ参照" })
    .click();
  await page.getByLabel("タグ参照を検索", { exact: true }).fill("送水設備");
  const references = page.getByRole("region", {
    name: "Project のタグ参照",
    exact: true,
  });
  await expect(references).toContainText("Exact.Level");
  await references
    .getByRole("button", { name: /送水設備（Text 6） を編集$/ })
    .click();
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("Exact.Level");
  await expect(name(page)).toHaveValue("送水設備");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
