import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import symbol from "../examples/symbol-color.project.json" with { type: "json" };
import embedded from "../examples/embedded-screen.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const form = (page: Page) =>
  page.getByRole("form", { name: "選択した配置の幅・高さ", exact: true });
const width = (page: Page) =>
  form(page).getByLabel("適用する幅", { exact: true });
const height = (page: Page) =>
  form(page).getByLabel("適用する高さ", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した配置にサイズを適用",
    exact: true,
  });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "size.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await selectPanel(page, "レイヤー");
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
async function two(
  page: Page,
  ids = sample.screens[0].objects.slice(0, 2).map((o) => o.id),
) {
  await row(page, ids[0]).click();
  await row(page, ids[1]).click({ modifiers: ["ControlOrMeta"] });
}
for (const theme of ["light", "dark"] as const)
  test(`explicit local width preserves rotated centers, unspecified height and supports one Undo in ${theme}`, async ({
    page,
  }) => {
    const fixture = structuredClone(sample);
    fixture.screens[0].objects[0].rotation = 37;
    fixture.screens[0].objects[1].rotation = 110;
    await start(page, fixture);
    await chooseTheme(page, theme);
    await two(page);
    await expect(form(page)).toContainText("現在の幅：混在");
    await expect(width(page)).toHaveValue("");
    await expect(height(page)).toHaveValue("");
    await expect(apply(page)).toBeDisabled();
    await width(page).fill("160");
    await width(page).press("Tab");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await width(page).press("Enter");
    await expect(width(page)).toHaveValue("");
    await expect(form(page)).toContainText("現在の幅：160");
    const result = await saved(page);
    expect(result.screens[0].objects).toEqual(
      fixture.screens[0].objects.map((o, i) =>
        i < 2 ? { ...o, width: 160, x: o.x + (o.width - 160) / 2 } : o,
      ),
    );
    await width(page).fill("160");
    await apply(page).click();
    await button(page, "元に戻す").click();
    await expect(form(page)).toContainText("現在の幅：混在");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
    await expect(form(page)).toContainText("現在の幅：160");
  });
test("invalid values and IME preserve drafts; selection and other pending forms require confirmation", async ({
  page,
}) => {
  await start(page);
  await two(page);
  await width(page).fill("0");
  await apply(page).click();
  await expect(width(page)).toHaveValue("0");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await width(page).fill("120");
  await width(page).dispatchEvent("compositionstart");
  await width(page).press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await width(page).dispatchEvent("compositionend");
  await height(page).fill("80");
  await row(page, sample.screens[0].objects[2].id).click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(width(page)).toHaveValue("120");
  await expect(height(page)).toHaveValue("80");
  await page.getByLabel("適用する不透明度（%）", { exact: true }).fill("50");
  await apply(page).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("適用する不透明度（%）", { exact: true }).fill("");
  await apply(page).click();
  await expect(width(page)).toHaveValue("");
  await expect(height(page)).toHaveValue("");
  const result = await saved(page);
  expect(
    result.screens[0].objects
      .slice(0, 2)
      .every((o: any) => o.width === 120 && o.height === 80),
  ).toBe(true);
  expect(
    result.screens[0].objects
      .slice(0, 2)
      .every((o: any) => o.opacity === undefined),
  ).toBe(true);
});
test("line-containing selections are refused as a whole; hidden placements and locks are explicit", async ({
  page,
}) => {
  await start(page, processSample);
  await page.getByRole("region", { name: "キャンバス操作領域" }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(form(page)).toContainText("線・配管を含むため");
  await expect(width(page)).toBeDisabled();
  await expect(
    page.getByLabel("適用する不透明度（%）", { exact: true }),
  ).toBeEnabled();
  const fixture = structuredClone(sample);
  Object.assign(fixture.screens[0].objects[0], { visible: false });
  Object.assign(fixture.screens[0].objects[1], { locked: true });
  await start(page, fixture);
  await two(page);
  await expect(form(page)).toContainText("うち非表示 1 件");
  await expect(width(page)).toBeDisabled();
  delete (fixture.screens[0].objects[1] as any).locked;
  await start(page, fixture);
  await two(page);
  await height(page).fill("90");
  await apply(page).click();
  const result = await saved(page);
  expect(result.screens[0].objects[0]).toMatchObject({
    visible: false,
    height: 90,
  });
});
test("Symbol and embedded View frames preserve shared internals, modes and sources", async ({
  page,
}) => {
  for (const fixture of [symbol, embedded]) {
    await start(page, fixture);
    await two(
      page,
      fixture.screens[0].objects.slice(0, 2).map((o) => o.id),
    );
    await width(page).fill("160");
    await height(page).fill("80");
    await apply(page).click();
    const result = await saved(page);
    expect(result.symbols).toEqual(fixture.symbols);
    expect(result.screens.slice(1)).toEqual(fixture.screens.slice(1));
    expect(result.screens[0].objects).toEqual(
      fixture.screens[0].objects.map((o, i) =>
        i < 2
          ? {
              ...o,
              width: 160,
              height: 80,
              x: o.x + (o.width - 160) / 2,
              y: o.y + (o.height - 80) / 2,
            }
          : o,
      ),
    );
  }
});
