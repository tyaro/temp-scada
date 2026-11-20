import { test, expect, type Page } from "@playwright/test";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme, mainCanvas } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 面の図形の文字（#305 L2）: Inspector の「文字」フォームでの作成・書式・削除・IME・未適用の保護・絞込み。
const rect = minimal.screens[0].objects[0],
  ellipse = minimal.screens[0].objects[1];
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const form = (page: Page) =>
  page.getByRole("form", { name: "図形の文字", exact: true });
const field = (page: Page, name: string) =>
  form(page).getByLabel(name, { exact: true });
const text = (page: Page) => field(page, "図形の文言");
const lines = (page: Page, id = rect.id) =>
  mainCanvas(page).locator(
    `[data-object-id="${id}"] [data-shape-label] [data-text-content]`,
  );
const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });

async function start(page: Page, theme = "light") {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "label.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(minimal)),
  });
  await chooseTheme(page, theme);
  await selectPanel(page, "レイヤー");
  await row(page, rect.id).click();
}

for (const theme of ["light", "dark"] as const)
  test(`shape label is created, styled, removed and undone from the inspector in ${theme}`, async ({
    page,
  }) => {
    await start(page, theme);
    // label が無い間は既定値を出す。
    await expect(field(page, "図形の文字サイズ")).toHaveValue("16");
    await expect(field(page, "図形の文字の太さ")).toHaveValue("normal");
    await expect(field(page, "図形の文字揃え")).toHaveValue("center");
    await expect(field(page, "図形の文字の折返し")).toHaveValue("word");
    // Enter は改行で、確定しない。
    await text(page).fill("工程");
    await text(page).press("Enter");
    await text(page).pressSequentially("A");
    await expect(text(page)).toHaveValue("工程\nA");
    await expect(lines(page)).toHaveCount(0);
    await text(page).press("Control+Enter");
    await expect(lines(page)).toHaveCount(2);
    await expect(lines(page).first()).toHaveText("工程");
    await expect(lines(page).first()).toHaveAttribute("font-size", "16");
    // 書式と色は「文字を適用」で確定する。
    await field(page, "図形の文字サイズ").fill("20");
    await field(page, "図形の文字の太さ").selectOption("bold");
    await field(page, "図形の文字揃え").selectOption("left");
    await field(page, "図形の文字色").fill("#ff0000");
    await form(page)
      .getByRole("button", { name: "文字を適用", exact: true })
      .click();
    await expect(lines(page).first()).toHaveAttribute("font-size", "20");
    await expect(lines(page).first()).toHaveAttribute("font-weight", "bold");
    await expect(lines(page).first()).toHaveAttribute("fill", "#ff0000");
    // 空にして確定すると消え、元に戻すで戻る。
    await text(page).fill("");
    await text(page).press("Control+Enter");
    await expect(lines(page)).toHaveCount(0);
    await expect(field(page, "図形の文字サイズ")).toHaveValue("16");
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(lines(page)).toHaveCount(2);
    await expect(lines(page).first()).toHaveAttribute("font-size", "20");
    await expect(text(page)).toHaveValue("工程\nA");
    // レイヤーの絞込みで文言から見つかる。
    await page.getByLabel("レイヤーを検索", { exact: true }).fill("工程");
    await expect(row(page, rect.id)).toBeVisible();
    await expect(row(page, ellipse.id)).toHaveCount(0);
  });

test("shape label does not commit while composing with an IME", async ({
  page,
}) => {
  await start(page);
  await text(page).fill("ポンプ");
  await text(page).dispatchEvent("compositionstart");
  await text(page).press("Control+Enter");
  await field(page, "図形の文字サイズ").press("Enter");
  await expect(lines(page)).toHaveCount(0);
  await text(page).dispatchEvent("compositionend");
  await text(page).press("Control+Enter");
  await expect(lines(page)).toHaveCount(1);
  await expect(lines(page)).toHaveText("ポンプ");
});

test("unapplied shape label drafts are prevalidated and applied on leaving", async ({
  page,
}) => {
  await start(page);
  await text(page).fill("未確定");
  await field(page, "図形の文字サイズ").fill("0");
  await row(page, ellipse.id).click();
  // 不正な値はダイアログなしで止まり、選択も書きかけもそのまま残る。
  await expect(prompt(page)).toHaveCount(0);
  await expect(row(page, rect.id)).toHaveAttribute("aria-pressed", "true");
  await expect(text(page)).toHaveValue("未確定");
  await expect(lines(page)).toHaveCount(0);
  await field(page, "図形の文字サイズ").fill("24");
  // 離れたら確定: 直した値は確認なしで適用される。
  await row(page, ellipse.id).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(row(page, ellipse.id)).toHaveAttribute("aria-pressed", "true");
  await expect(lines(page)).toHaveText("未確定");
  await expect(lines(page)).toHaveAttribute("font-size", "24");
  await expect(text(page)).toHaveValue("");
});
