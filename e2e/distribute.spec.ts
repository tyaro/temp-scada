import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import type { Project } from "../apps/banto-scada/src/lib/project";
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const horizontal = "中心を水平方向に等間隔";
const vertical = "中心を垂直方向に等間隔";
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const row = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name, exact: true });
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "distribution.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await selectPanel(page, "レイヤー");
}
async function selectAll(page: Page) {
  await viewport(page).focus();
  await page.keyboard.press("Control+a");
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await waiting;
  return JSON.parse(await readFile((await file.path())!, "utf8"));
}
test("three placements distribute by centers with fixed endpoints, ignore snap and keep one Undo including semantic no-ops", async ({
  page,
}) => {
  await start(page);
  await row(page, "rectangle · 3").click();
  await expect(button(page, horizontal)).toBeDisabled();
  await row(page, "ellipse · 4").click({ modifiers: ["Shift"] });
  await expect(button(page, horizontal)).toBeDisabled();
  await selectAll(page);
  await expect(button(page, horizontal)).toBeEnabled();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
  await button(page, horizontal).click();
  const result = await exported(page);
  expect(result.screens[0].objects[0]).toEqual(sample.screens[0].objects[0]);
  expect(result.screens[0].objects[1]).toEqual(sample.screens[0].objects[1]);
  expect(result.screens[0].objects[2]).toEqual({
    ...sample.screens[0].objects[2],
    x: 185,
  });
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("1");
  await button(page, horizontal).click();
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  expect((await exported(page)).screens).toEqual(result.screens);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "distributed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(result)),
  });
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
});
test("vertical context action validates pending color before mutation, applies it separately, and preserves orthogonal coordinates", async ({
  page,
}) => {
  await start(page);
  await selectAll(page);
  const color = page.getByLabel("適用する色", { exact: true });
  await color.fill("#12");
  await button(page, vertical).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(color).toHaveValue("#12");
  await color.fill("#123456");
  await row(page, "rectangle · 3").click({ button: "right" });
  await page
    .getByRole("menu", { name: "選択図形（3 件） の操作", exact: true })
    .getByRole("menuitem", { name: vertical, exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  const result = await exported(page);
  expect(result.screens[0].objects[0]).toEqual({
    ...sample.screens[0].objects[0],
    fill: "#123456",
    y: 85,
  });
  expect(result.screens[0].objects[1]).toEqual({
    ...sample.screens[0].objects[1],
    fill: "#123456",
  });
  expect(result.screens[0].objects[2]).toEqual({
    ...sample.screens[0].objects[2],
    fill: "#123456",
  });
  await button(page, "元に戻す").click();
  const colored = await exported(page);
  expect(colored.screens[0].objects).toEqual(
    sample.screens[0].objects.map((o) => ({ ...o, fill: "#123456" })),
  );
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("locked selections reject the whole action and explicit hidden selection stays hidden while included", async ({
  page,
}) => {
  const fixture = structuredClone(sample) as unknown as Project;
  fixture.screens[0].objects[2].visible = false;
  fixture.screens[0].objects[0].locked = true;
  await start(page, fixture);
  await row(page, "rectangle · 3").click();
  await row(page, "ellipse · 4").click({ modifiers: ["Shift"] });
  await row(page, "text · 5").click({ modifiers: ["Shift"] });
  await expect(button(page, horizontal)).toBeDisabled();
  await button(page, "ロック解除：rectangle · 3").click();
  await expect(button(page, horizontal)).toBeEnabled();
  await expect(
    page.getByRole("toolbar", { name: "共通編集ツールバー", exact: true }),
  ).toContainText("非表示 1");
  await button(page, horizontal).click();
  const result = await exported(page);
  expect(result.screens[0].objects[2]).toMatchObject({
    x: 185,
    visible: false,
  });
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(2);
});
test("shared definition distribution changes only its children and is reversible", async ({
  page,
}) => {
  await start(page, processSample);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectAll(page);
  await button(page, horizontal).click();
  const result = await exported(page);
  expect(result.screens).toEqual(processSample.screens);
  expect(result.symbols[0].objects).not.toEqual(
    processSample.symbols[0].objects,
  );
  await button(page, "元に戻す").click();
  expect((await exported(page)).symbols).toEqual(processSample.symbols);
});
for (const theme of ["light", "dark"])
  test(`distribution is keyboard reachable in a narrow toolbar in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await selectAll(page);
    await button(page, horizontal).focus();
    await page.keyboard.press("Enter");
    await expect(button(page, horizontal)).toBeFocused();
    expect((await exported(page)).screens[0].objects[2].x).toBe(185);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
