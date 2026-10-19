import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import type { Project } from "../apps/banto-scada/src/lib/project";
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const colorForm = (page: Page) =>
  page.getByRole("form", { name: "選択した配置の色", exact: true });
const code = (page: Page) =>
  colorForm(page).getByLabel("適用する色", { exact: true });
const apply = (page: Page) =>
  colorForm(page).getByRole("button", {
    name: "選択した配置に色を適用",
    exact: true,
  });
const row = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name, exact: true });
const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "colors.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await selectPanel(page, "レイヤー");
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const download = await waiting;
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}
async function selectTwo(page: Page) {
  await row(page, "rectangle · 3").click();
  await row(page, "ellipse · 4").click({ modifiers: ["Shift"] });
}
test("mixed colors stay unspecified until Apply, allow clearing and invalid text, then undo all targets together", async ({
  page,
}) => {
  await start(page);
  await selectTwo(page);
  await expect(colorForm(page)).toContainText("現在の色：混在");
  await expect(code(page)).toHaveValue("");
  await expect(apply(page)).toBeDisabled();
  await colorForm(page)
    .getByRole("button", { name: /青.*#2563eb/ })
    .click();
  await expect(code(page)).toHaveValue("#2563eb");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await code(page).fill("");
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await code(page).fill("#12");
  await apply(page).click();
  await expect(code(page)).toHaveValue("#12");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await code(page).fill("#AABBCC");
  await apply(page).click();
  await expect(code(page)).toHaveValue("");
  await expect(colorForm(page)).toContainText("現在の色：#aabbcc");
  const result = await exported(page);
  expect(
    result.screens[0].objects.slice(0, 2).map((o: { fill: string }) => o.fill),
  ).toEqual(["#aabbcc", "#aabbcc"]);
  expect(result.screens[0].objects[2]).toEqual(sample.screens[0].objects[2]);
  await code(page).fill("#aAbBcC");
  await apply(page).click();
  await button(page, "元に戻す").click();
  await expect(colorForm(page)).toContainText("現在の色：混在");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  await expect(colorForm(page)).toContainText("現在の色：#aabbcc");
});
test("color and movement drafts are prevalidated together and target changes preserve or resolve the whole draft", async ({
  page,
}) => {
  await start(page);
  await selectTwo(page);
  await code(page).fill("#123456");
  await row(page, "text · 5").click();
  await prompt(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(code(page)).toHaveValue("#123456");
  await page.getByLabel("移動量 X", { exact: true }).fill("1e309");
  await row(page, "text · 5").click();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(code(page)).toHaveValue("#123456");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("移動量 X", { exact: true }).fill("10");
  await row(page, "text · 5").click();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(code(page)).toHaveCount(0);
  const result = await exported(page);
  expect(
    result.screens[0].objects
      .slice(0, 2)
      .map((o: { fill: string; x: number }) => [o.fill, o.x]),
  ).toEqual([
    ["#123456", 110],
    ["#123456", 580],
  ]);
  await button(page, "元に戻す").click();
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await selectTwo(page);
  await code(page).fill("#000000");
  await row(page, "text · 5").click();
  await prompt(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("locked selections are read only while hidden unlocked targets can be explicitly colored without reappearing", async ({
  page,
}) => {
  const fixture = structuredClone(sample) as unknown as Project;
  fixture.screens[0].objects[0].visible = false;
  fixture.screens[0].objects[1].locked = true;
  await start(page, fixture);
  await selectTwo(page);
  await expect(code(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
  await button(page, "ロック解除：ellipse · 4").click();
  await expect(code(page)).toBeEnabled();
  await expect(colorForm(page)).toContainText("2 件に適用・うち非表示 1 件");
  await code(page).fill("#000000");
  await apply(page).click();
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(2);
  const result = await exported(page);
  expect(result.screens[0].objects[0]).toMatchObject({
    visible: false,
    fill: "#000000",
  });
  expect(result.screens[0].objects[1].fill).toBe("#000000");
});
test("mixed Text, pipe and Symbol colors change placement tint without touching shared definitions or tag metadata", async ({
  page,
}) => {
  await start(page, processSample);
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+a");
  await code(page).fill("#16a34a");
  await apply(page).click();
  const result = await exported(page);
  expect(result.symbols).toEqual(processSample.symbols);
  expect(result.screens[0].objects).toEqual(
    processSample.screens[0].objects.map((o) => ({
      ...o,
      fill: o.fill.toLowerCase() === "#16a34a" ? o.fill : "#16a34a",
    })),
  );
  await page.getByRole("tab", { name: "プロジェクト", exact: true }).click();
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+a");
  await expect(colorForm(page)).toContainText("共有定義内の図形");
  await code(page).fill("#ea580c");
  await apply(page).click();
  const definitionResult = await exported(page);
  expect(definitionResult.screens).toEqual(result.screens);
  expect(
    definitionResult.symbols[0].objects.every(
      (o: { fill: string }) => o.fill === "#ea580c",
    ),
  ).toBe(true);
});
for (const theme of ["light", "dark"])
  test(`keyboard color presets and form fit the narrow fixed inspector in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await selectTwo(page);
    const black = colorForm(page).getByRole("button", { name: /黒.*#000000/ });
    await black.focus();
    await page.keyboard.press("Enter");
    await expect(code(page)).toHaveValue("#000000");
    await code(page).focus();
    await code(page).dispatchEvent("compositionstart");
    await code(page).dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
    });
    await expect(button(page, "元に戻す")).toBeDisabled();
    await code(page).dispatchEvent("compositionend");
    await code(page).press("Enter");
    await expect(code(page)).toHaveValue("");
    await expect(colorForm(page)).toContainText("現在の色：#000000");
    expect(
      await colorForm(page).evaluate(
        (form) => form.scrollWidth <= form.clientWidth,
      ),
    ).toBe(true);
  });
