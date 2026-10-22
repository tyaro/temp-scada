import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import symbol from "../examples/symbol-color.project.json" with { type: "json" };
import embedded from "../examples/embedded-screen.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const form = (page: Page) =>
  page.getByRole("form", { name: "選択した配置の不透明度", exact: true });
const input = (page: Page) =>
  form(page).getByLabel("適用する不透明度（%）", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した配置に不透明度を適用",
    exact: true,
  });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "opacity.json",
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
  test(`mixed opacity applies once, zero stays reachable and blank is unchanged in ${theme}`, async ({
    page,
  }) => {
    const fixture = structuredClone(sample);
    Object.assign(fixture.screens[0].objects[0], { opacity: 0.4 });
    await start(page, fixture);
    await chooseTheme(page, theme);
    await two(page);
    await expect(form(page)).toContainText("現在の不透明度：混在");
    await expect(input(page)).toHaveValue("");
    await expect(apply(page)).toBeDisabled();
    await input(page).fill("37.5");
    await input(page).press("Tab");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await input(page).press("Enter");
    await expect(input(page)).toHaveValue("");
    await expect(form(page)).toContainText("現在の不透明度：37.5%");
    let result = await saved(page);
    expect(result.screens[0].objects).toEqual(
      fixture.screens[0].objects.map((o, i) =>
        i < 2 ? { ...o, opacity: 0.375 } : o,
      ),
    );
    await input(page).fill("37.5");
    await apply(page).click();
    await button(page, "元に戻す").click();
    await expect(form(page)).toContainText("混在");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
    await input(page).fill("0");
    await apply(page).click();
    await expect(form(page)).toContainText("現在の不透明度：0%");
    await row(page, sample.screens[0].objects[0].id).click();
    await expect(page.getByLabel("不透明度（%）", { exact: true })).toHaveValue(
      "0",
    );
    result = await saved(page);
    expect(
      result.screens[0].objects.slice(0, 2).every((o: any) => o.opacity === 0),
    ).toBe(true);
  });
test("invalid and composing values preserve the draft, selection changes are guarded, and other form drafts remain separate", async ({
  page,
}) => {
  await start(page);
  await two(page);
  await input(page).fill("101");
  await apply(page).click();
  await expect(input(page)).toHaveValue("101");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await input(page).fill("25");
  await input(page).dispatchEvent("compositionstart");
  await input(page).press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await input(page).dispatchEvent("compositionend");
  await row(page, sample.screens[0].objects[2].id).click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(input(page)).toHaveValue("25");
  await page.getByLabel("適用する色", { exact: true }).fill("#123456");
  await apply(page).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(input(page)).toHaveValue("25");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("適用する色", { exact: true }).fill("");
  await apply(page).click();
  await expect(input(page)).toHaveValue("");
  await page.getByLabel("適用する色", { exact: true }).fill("#123456");
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await row(page, sample.screens[0].objects[2].id).click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  const result = await saved(page);
  expect(
    result.screens[0].objects.slice(0, 2).map((o: any) => o.opacity),
  ).toEqual([0.25, 0.25]);
  expect(result.screens[0].objects[0].shape.paint).toEqual(
    sample.screens[0].objects[0].shape.paint,
  );
});
test("definition-colored Symbols keep modes and internal colors; embedded Views retain source identity", async ({
  page,
}) => {
  for (const fixture of [symbol, embedded]) {
    await start(page, fixture);
    const ids = fixture.screens[0].objects.slice(0, 2).map((o) => o.id);
    await two(page, ids);
    await input(page).fill("50");
    await apply(page).click();
    const result = await saved(page);
    expect(result.symbols).toEqual(fixture.symbols);
    expect(result.screens[0].objects).toEqual(
      fixture.screens[0].objects.map((o, i) =>
        i < 2 ? { ...o, opacity: 0.5 } : o,
      ),
    );
    expect(result.screens.slice(1)).toEqual(fixture.screens.slice(1));
  }
});

test("locked selections reject the whole edit while hidden unlocked placements remain explicitly editable", async ({
  page,
}) => {
  const fixture = structuredClone(sample);
  Object.assign(fixture.screens[0].objects[0], { visible: false });
  Object.assign(fixture.screens[0].objects[1], { locked: true });
  await start(page, fixture);
  await two(page);
  await expect(form(page)).toContainText("うち非表示 1 件");
  await expect(input(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
  delete (fixture.screens[0].objects[1] as any).locked;
  await start(page, fixture);
  await two(page);
  await input(page).fill("25");
  await apply(page).click();
  const result = await saved(page);
  expect(result.screens[0].objects[0]).toEqual({
    ...fixture.screens[0].objects[0],
    opacity: 0.25,
  });
  expect(result.screens[0].objects[1]).toEqual({
    ...fixture.screens[0].objects[1],
    opacity: 0.25,
  });
});
