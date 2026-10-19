import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { fileCommand, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const draft = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
const projectName = (page: Page) =>
  page.getByLabel("プロジェクト名", { exact: true });
const placementName = (page: Page) =>
  page.getByLabel("配置名", { exact: true });
const layer = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name, exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
}
test("Project name applies metadata only, preserves drafts, trims no-ops and round-trips through history and JSON", async ({
  page,
}) => {
  await start(page);
  await fileCommand(page, "プロジェクト名を変更");
  const name = projectName(page);
  await expect(name).toBeFocused();
  await name.fill("  原水供給設備  ");
  await selectPanel(page, "部品");
  await expect(page.locator("h1")).toHaveText(sample.manifest.name);
  await fileCommand(page, "プロジェクト名を変更");
  await expect(name).toHaveValue("  原水供給設備  ");
  await expect(draft(page)).toHaveCount(0);
  await name.press("Enter");
  await expect(name).toHaveValue("原水供給設備");
  await expect(page.locator("h1")).toHaveText("原水供給設備");
  await name.fill(" 原水供給設備 ");
  await button(page, "プロジェクト名を適用").click();
  await expect(name).toHaveValue("原水供給設備");
  await button(page, "元に戻す").click();
  await expect(name).toHaveValue(sample.manifest.name);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const download = await waiting;
  const result = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(result.manifest.name).toBe("原水供給設備");
  expect(result.manifest.projectId).toBe(sample.manifest.projectId);
  expect(result.screens).toEqual(sample.screens);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "renamed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(result)),
  });
  await expect(page.locator("h1")).toHaveText("原水供給設備");
  await expect(name).toHaveValue("原水供給設備");
});
test("Project draft is guarded across replacement, rejects invalid names and never submits IME Enter", async ({
  page,
}) => {
  await start(page);
  await fileCommand(page, "プロジェクト名を変更");
  const name = projectName(page);
  await name.fill("変換中");
  await name.dispatchEvent("compositionstart");
  await name.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await name
    .locator("..")
    .locator("..")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("h1")).toHaveText(sample.manifest.name);
  await name.dispatchEvent("compositionend");
  await fileCommand(page, "新しいProject");
  await draft(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(name).toHaveValue("変換中");
  await name.fill("   ");
  await button(page, "プロジェクト名を適用").click();
  await expect(name).toHaveValue("   ");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await fileCommand(page, "新しいProject");
  await draft(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.locator("h1")).toHaveText(sample.manifest.name);
  await expect(name).toBeFocused();
  await name.fill("更新名");
  await name.press("Enter");
  await expect(page.locator("h1")).toHaveText("更新名");
});
test("F2 reveals the selected placement name, preserves its draft and targets the focused layer row through the guard", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await layer(page, "rectangle · 3").click();
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "表示", exact: true })
    .getByRole("menuitem", { name: "プロパティを隠す", exact: true })
    .click();
  await expect(placementName(page)).toBeHidden();
  await layer(page, "rectangle · 3").press("F2");
  await expect(placementName(page)).toBeFocused();
  await placementName(page).fill("未確定ポンプ");
  await layer(page, "rectangle · 3").focus();
  await page.keyboard.press("F2");
  await expect(placementName(page)).toHaveValue("未確定ポンプ");
  await expect(draft(page)).toHaveCount(0);
  const ellipse = layer(page, "ellipse · 4");
  await ellipse.focus();
  await page.keyboard.press("F2");
  await draft(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(ellipse).toBeFocused();
  await expect(placementName(page)).toHaveValue("未確定ポンプ");
  await page.keyboard.press("F2");
  await draft(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(layer(page, "未確定ポンプ")).toBeVisible();
  await expect(ellipse).toHaveAttribute("aria-pressed", "true");
  await expect(placementName(page)).toBeFocused();
  await placementName(page).fill("円形タンク");
  await button(page, "変更を適用").click();
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await canvas.focus();
  await page.keyboard.press("F2");
  await expect(placementName(page)).toBeFocused();
  await expect(placementName(page)).toHaveValue("円形タンク");
  expect(
    await placementName(page).evaluate(
      (input) => (input as HTMLInputElement).selectionEnd,
    ),
  ).toBe(5);
});
test("F2 uses the focused screen tab instead of the active screen and reveals hidden Project settings", async ({
  page,
}) => {
  await start(page);
  await button(page, "画面を追加").click();
  await page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "プロジェクト設定" }) })
    .locator("summary")
    .first()
    .click();
  await expect(page.getByLabel("画面名", { exact: true })).toBeHidden();
  const tabs = page.getByRole("navigation", { name: "画面タブ", exact: true });
  const first = tabs.getByRole("button", { name: "プロセス画面", exact: true });
  await first.focus();
  await page.keyboard.press("F2");
  const name = page.getByLabel("画面名", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("未適用工程");
  await first.focus();
  await page.keyboard.press("F2");
  await expect(name).toHaveValue("未適用工程");
  await expect(draft(page)).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "画面 2", exact: true })
    .focus();
  await page.keyboard.press("F2");
  await draft(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("画面 2");
});
test("F2 leaves locked and multiple selections unchanged and ignores IME, repeats, modifiers, inputs and preview", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  const rectangle = layer(page, "rectangle · 3");
  await rectangle.click();
  await button(page, "ロック：rectangle · 3").click();
  await rectangle.focus();
  await page.keyboard.press("F2");
  await expect(rectangle).toBeFocused();
  await expect(placementName(page)).toBeDisabled();
  await button(page, "ロック解除：rectangle · 3").click();
  await rectangle.click();
  await layer(page, "ellipse · 4").click({ modifiers: ["Shift"] });
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await canvas.focus();
  await page.keyboard.press("F2");
  await expect(canvas).toBeFocused();
  await expect(placementName(page)).toHaveCount(0);
  await rectangle.click();
  await rectangle.focus();
  for (const detail of [
    { isComposing: true },
    { repeat: true },
    { ctrlKey: true },
    { shiftKey: true },
  ])
    await rectangle.dispatchEvent("keydown", { key: "F2", ...detail });
  await expect(rectangle).toBeFocused();
  await placementName(page).fill("入力中");
  await placementName(page).press("F2");
  await expect(placementName(page)).toHaveValue("入力中");
  await button(page, "変更を適用").click();
  await button(page, "表示プレビュー").click();
  const first = page
    .getByRole("navigation", { name: "画面タブ", exact: true })
    .locator("[data-screen-tab]")
    .first();
  await first.focus();
  await page.keyboard.press("F2");
  await expect(first).toBeFocused();
  await expect(button(page, "編集")).toHaveAttribute("aria-pressed", "false");
});
test("F1 opens a single existing guide, restores focus, and cannot stack on another dialog", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  const rectangle = layer(page, "rectangle · 3");
  await rectangle.click();
  await placementName(page).fill("保持する入力");
  await rectangle.focus();
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", {
    name: "操作ガイド・アプリ情報",
    exact: true,
  });
  await expect(help).toBeVisible();
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(rectangle).toBeFocused();
  await expect(placementName(page)).toHaveValue("保持する入力");
  await layer(page, "ellipse · 4").click();
  await expect(draft(page)).toBeVisible();
  await page.keyboard.press("F1");
  await expect(help).toHaveCount(0);
  await expect(draft(page)).toBeVisible();
});
