import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const form = (page: Page) =>
  page.getByRole("form", {
    name: "選択した線・配管のスタイルを変更",
    exact: true,
  });
const width = (page: Page) =>
  form(page).getByLabel("適用する線幅", { exact: true });
const arrow = (page: Page) =>
  form(page).getByLabel("適用する矢印", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した線・配管に適用",
    exact: true,
  });
const lines = sample.screens[0].objects.filter(
  (object) => object.shape.type === "polyline",
);
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "lines.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await selectPanel(page, "レイヤー");
}
async function selectLines(page: Page, ids = lines.map((object) => object.id)) {
  for (const [i, id] of ids.entries())
    await row(page, id).click({ modifiers: i ? ["Shift"] : [] });
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
test("line styles remain unspecified until Apply, change only styles and undo once", async ({
  page,
}) => {
  await start(page);
  await selectLines(page);
  await expect(width(page)).toHaveValue("");
  await expect(arrow(page)).toHaveValue("");
  await expect(apply(page)).toBeDisabled();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  const viewport = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await viewport.evaluate((element) => {
    element.scrollLeft = 160;
    element.scrollTop = 80;
  });
  await expect
    .poll(() =>
      viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]),
    )
    .toEqual([160, 80]);
  await width(page).fill("3.5");
  await arrow(page).focus();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await arrow(page).selectOption("end");
  await apply(page).click();
  await expect(width(page)).toHaveValue("");
  await expect(arrow(page)).toHaveValue("");
  await expect(apply(page)).toBeDisabled();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("2");
  await expect
    .poll(() =>
      viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]),
    )
    .toEqual([160, 80]);
  await expect(page.locator('.sheet > svg [data-selected="true"]')).toHaveCount(
    lines.length,
  );
  const result = await exported(page);
  expect(result.screens[0].objects).toEqual(
    sample.screens[0].objects.map((object) =>
      object.shape.type === "polyline"
        ? {
            ...object,
            shape: { ...object.shape, strokeWidth: 3.5, arrow: "end" },
          }
        : object,
    ),
  );
  await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(sample.screens);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  expect((await exported(page)).screens).toEqual(result.screens);
});
test("width-only and arrow-only edits preserve unspecified fields and same values add no history", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  const targets = project.screens[0].objects.filter(
    (object: any) => object.shape.type === "polyline",
  );
  for (const [i, object] of targets.entries()) {
    object.shape.strokeWidth = 4;
    object.shape.arrow = i ? "none" : "end";
  }
  await start(page, project);
  await selectLines(page);
  await expect(
    page.getByText("現在の線幅：4 · 矢印：混在", { exact: true }),
  ).toBeVisible();
  await width(page).fill("4");
  await apply(page).click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await width(page).fill("0.5");
  await apply(page).click();
  let result = await exported(page);
  expect(
    result.screens[0].objects
      .filter((object: any) => object.shape.type === "polyline")
      .map((object: any) => object.shape.arrow),
  ).toEqual(targets.map((object: any) => object.shape.arrow));
  await arrow(page).selectOption("none");
  await apply(page).click();
  result = await exported(page);
  for (const object of result.screens[0].objects)
    if (object.shape.type === "polyline")
      expect(object.shape).toMatchObject({ strokeWidth: 0.5, arrow: "none" });
});
test("invalid line input blocks other pending forms before any model change", async ({
  page,
}) => {
  await start(page);
  await selectLines(page);
  await width(page).fill("0");
  await page.getByLabel("適用する色", { exact: true }).fill("#112233");
  await page.getByLabel("移動量 X", { exact: true }).fill("10");
  const other = sample.screens[0].objects.find(
    (object) => object.shape.type !== "polyline",
  )!;
  await row(page, other.id).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(prompt).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(width(page)).toHaveValue("0");
  await width(page).fill("3");
  await row(page, other.id).click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  const result = await exported(page);
  for (const original of lines)
    expect(
      result.screens[0].objects.find(
        (object: any) => object.id === original.id,
      ),
    ).toEqual({
      ...original,
      x: original.x + 10,
      fill: "#112233",
      shape: { ...original.shape, strokeWidth: 3 },
    });
  for (let i = 0; i < 3; i++) await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(sample.screens);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("mixed object types explain the restriction while hidden lines remain explicit editable targets", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.screens[0].objects.find(
    (object: any) => object.id === lines[0].id,
  ).visible = false;
  await start(page, project);
  await selectLines(page);
  await expect(
    page.getByRole("region", {
      name: "選択した線・配管のスタイル",
      exact: true,
    }),
  ).toContainText("非表示 1 件");
  await arrow(page).selectOption("end");
  await apply(page).click();
  expect(
    (await exported(page)).screens[0].objects.find(
      (object: any) => object.id === lines[0].id,
    ).visible,
  ).toBe(false);
  await row(
    page,
    sample.screens[0].objects.find(
      (object) => object.shape.type !== "polyline",
    )!.id,
  ).click({ modifiers: ["Shift"] });
  await expect(form(page)).toHaveCount(0);
  await expect(
    page.getByText(/線・配管だけを選択すると編集できます/),
  ).toBeVisible();
});
test("locked line mixtures disable the whole form and IME Enter never submits", async ({
  page,
}) => {
  await start(page);
  await selectLines(page);
  await width(page).fill("2.5");
  await width(page).dispatchEvent("compositionstart");
  await width(page).press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await width(page).dispatchEvent("compositionend");
  await width(page).press("Enter");
  await expect(width(page)).toHaveValue("");
  await button(page, "元に戻す").click();
  await button(page, `ロック：polyline · ${lines[0].order}`).click();
  await expect(width(page)).toBeDisabled();
  await expect(arrow(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
});
test("shared definition line styles preserve parent placements and viewport", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const definition = sample.symbols[0];
  await selectLines(
    page,
    definition.objects.map((object) => object.id),
  );
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  await width(page).fill("2.5");
  await apply(page).click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("2");
  const result = await exported(page);
  expect(result.screens).toEqual(sample.screens);
  expect(result.symbols[1]).toEqual(sample.symbols[1]);
  for (const object of result.symbols[0].objects)
    expect(object.shape.strokeWidth).toBe(2.5);
});
for (const theme of ["light", "dark"] as const)
  test(`line style form is reachable in ${theme} at narrow width`, async ({
    page,
  }) => {
    await start(page);
    await selectLines(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await width(page).fill("4");
    await arrow(page).selectOption("end");
    await apply(page).click();
    await expect(width(page)).toHaveValue("");
    const close = page.getByRole("button", {
      name: "プロパティを隠す",
      exact: true,
    });
    const panelBox = await page
      .getByRole("complementary", { name: "プロパティパネル", exact: true })
      .boundingBox();
    const closeBox = await close.boundingBox();
    expect(closeBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(
      panelBox!.y + 40,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
