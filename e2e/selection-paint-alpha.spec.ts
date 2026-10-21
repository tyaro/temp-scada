import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const form = (page: Page) =>
  page.getByRole("form", { name: "選択した塗り・枠線の不透明度", exact: true });
const fill = (page: Page) =>
  form(page).getByLabel("適用する単色塗りの不透明度（%）", { exact: true });
const stroke = (page: Page) =>
  form(page).getByLabel("適用する枠線の不透明度（%）", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した塗り・枠線に不透明度を適用",
    exact: true,
  });
const row = (page: Page, index: number) =>
  page.locator(
    `button[data-layer-id="${sample.screens[0].objects[index].id}"]`,
  );
function fixture() {
  const p = structuredClone(sample);
  for (const o of p.screens[0].objects.slice(0, 2)) {
    Object.assign(o.shape.paint!, { stroke: { color: "#123456", width: 3 } });
    Object.assign(o, { opacity: 0.8 });
  }
  return p;
}
async function start(page: Page, p = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "alpha.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(p)),
  });
  await selectPanel(page, "レイヤー");
  await row(page, 0).click();
  await row(page, 1).click({ modifiers: ["Control"] });
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
for (const theme of ["light", "dark"] as const)
  test(`independent channels preserve RGB and placement opacity with one undo in ${theme}`, async ({
    page,
  }) => {
    const p = fixture();
    Object.assign(p.screens[0].objects[0].shape.paint!.stroke!, { alpha: 0.4 });
    await start(page, p);
    await chooseTheme(page, theme);
    await expect(form(page)).toContainText("枠線の現在値：混在");
    await expect(apply(page)).toBeDisabled();
    await fill(page).fill("25");
    await stroke(page).fill("37.5");
    await stroke(page).press("Tab");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await stroke(page).press("Enter");
    await expect(fill(page)).toHaveValue("");
    await expect(stroke(page)).toHaveValue("");
    await expect(form(page)).toContainText("単色塗りの現在値：25%");
    let result = await saved(page);
    for (const o of result.screens[0].objects.slice(0, 2)) {
      expect(o.opacity).toBe(0.8);
      expect(o.shape.paint.fill.paint.alpha).toBe(0.25);
      expect(o.shape.paint.stroke).toEqual({
        color: "#123456",
        width: 3,
        alpha: 0.375,
      });
    }
    await fill(page).fill("25");
    await stroke(page).fill("37.5");
    await apply(page).click();
    await button(page, "元に戻す").click();
    await expect(button(page, "元に戻す")).toBeDisabled();
    await expect(form(page)).toContainText("枠線の現在値：混在");
    await button(page, "やり直す").click();
    await fill(page).fill("0");
    await apply(page).click();
    result = await saved(page);
    expect(result.screens[0].objects[0].shape.paint.fill.paint.alpha).toBe(0);
    expect(result.screens[0].objects[0].shape.paint.stroke.alpha).toBe(0.375);
    await row(page, 0).click();
    await expect(
      page.getByLabel("塗りの不透明度（%）", { exact: true }),
    ).toHaveValue("0");
  });
test("invalid and composing input is preserved and guarded separately from other forms", async ({
  page,
}) => {
  await start(page);
  await fill(page).fill("101");
  await apply(page).click();
  await expect(fill(page)).toHaveValue("101");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await fill(page).fill("25");
  await fill(page).dispatchEvent("compositionstart");
  await fill(page).press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await fill(page).dispatchEvent("compositionend");
  await row(page, 2).click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(fill(page)).toHaveValue("25");
  await page.getByLabel("適用する色", { exact: true }).fill("#abcdef");
  await apply(page).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByLabel("適用する色", { exact: true }).fill("");
  await apply(page).click();
  await expect(fill(page)).toHaveValue("");
  await expect(form(page)).toContainText("単色塗りの現在値：25%");
});
test("unsupported selections disable each channel and hidden/locked targets stay explicit", async ({
  page,
}) => {
  let p = fixture();
  p.screens[0].objects[1].shape.paint!.stroke = null;
  await start(page, p);
  await expect(stroke(page)).toBeDisabled();
  await expect(fill(page)).toBeEnabled();
  await fill(page).fill("50");
  await apply(page).click();
  await row(page, 2).click({ modifiers: ["Control"] });
  await expect(fill(page)).toBeDisabled();
  await expect(stroke(page)).toBeDisabled();
  p = fixture();
  Object.assign(p.screens[0].objects[0], { visible: false });
  Object.assign(p.screens[0].objects[1], { locked: true });
  await start(page, p);
  await expect(form(page)).toContainText("うち非表示 1 件");
  await expect(fill(page)).toBeDisabled();
  await expect(stroke(page)).toBeDisabled();
  expect((await saved(page)).screens[0].objects).toEqual(p.screens[0].objects);
});
