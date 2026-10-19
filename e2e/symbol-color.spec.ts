import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-color.project.json" with { type: "json" };
import minimal from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const placements = sample.screens[0].objects.filter(
  (object) => object.shape.type === "symbol",
);
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const canvas = (page: Page) => page.locator(".sheet > svg");
const modeForm = (page: Page) =>
  page.getByRole("form", { name: "Symbolの色の使い方", exact: true });
const mode = (page: Page) =>
  modeForm(page).getByLabel("色の使い方", { exact: true });
const modeApply = (page: Page) =>
  modeForm(page).getByRole("button", { name: "色の使い方を適用", exact: true });
const colors = (page: Page) =>
  page.getByRole("form", { name: "選択した配置の色", exact: true });
const confirm = (page: Page) =>
  colors(page).getByRole("checkbox", { name: /共有定義の色を使うSymbol/ });
const svgSymbol = (root: Locator, id: string) =>
  root.locator(
    `[data-object-id="${id}"] > [data-object-rotation] > svg[data-symbol-id]`,
  );
async function paints(svg: Locator) {
  return svg
    .locator("rect,ellipse,text[data-text-content],polyline,polygon")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.getAttribute(
          node.tagName.toLowerCase() === "polyline" ? "stroke" : "fill",
        ),
      ),
    );
}
const expectedPaints = sample.symbols[0].objects
  .filter((object) => object.visible !== false)
  .flatMap((object) =>
    object.shape.type === "polyline" && object.shape.arrow === "end"
      ? [object.fill, object.fill]
      : [
          object.shape.type === "rectangle" || object.shape.type === "ellipse"
            ? object.shape.paint.fill.paint.color
            : object.fill,
        ],
  );
async function start(page: Page, project: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "colors.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
for (const theme of ["light", "dark"] as const)
  test(`definition colors match editor, preview and minimap in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await expect(svgSymbol(canvas(page), placements[1].id)).toHaveAttribute(
      "data-symbol-color-mode",
      "definition",
    );
    expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
      expectedPaints,
    );
    expect(await paints(svgSymbol(canvas(page), placements[0].id))).toEqual(
      expectedPaints.map(() => placements[0].fill),
    );
    await expect(
      svgSymbol(canvas(page), placements[1].id).locator(":scope > g"),
    ).toHaveCount(8);
    expect(
      await paints(
        svgSymbol(button(page, "ミニマップで表示位置を移動"), placements[1].id),
      ),
    ).toEqual(expectedPaints);
    await button(page, "表示プレビュー").click();
    expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
      expectedPaints,
    );
    expect(await paints(svgSymbol(canvas(page), placements[0].id))).toEqual(
      expectedPaints.map(() => placements[0].fill),
    );
  });
test("mode drafts preserve fill, disabled color never corrupts other properties, and same mode is a no-op", async ({
  page,
}) => {
  await start(page);
  await row(page, placements[1].id).click();
  await expect(mode(page)).toHaveValue("definition");
  await expect(
    page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
  ).toBeDisabled();
  await page.getByLabel("x", { exact: true }).fill("480");
  await page.getByLabel("x", { exact: true }).press("Enter");
  await mode(page).selectOption("monochrome");
  expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
    expectedPaints,
  );
  await row(page, placements[0].id).click();
  await prompt(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(mode(page)).toHaveValue("monochrome");
  await modeApply(page).click();
  expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
    expectedPaints.map(() => placements[1].fill),
  );
  await expect(
    page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
  ).toBeEnabled();
  let result = await exported(page);
  expect(
    result.screens[0].objects.find((o: any) => o.id === placements[1].id),
  ).toEqual({
    ...placements[1],
    x: 480,
    shape: { ...placements[1].shape, colorMode: "monochrome" },
  });
  await button(page, "元に戻す").click();
  await expect(mode(page)).toHaveValue("definition");
  await modeApply(page).click();
  await button(page, "元に戻す").click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue(
    String(placements[1].x),
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  result = await exported(page);
  expect(result.screens).toEqual(sample.screens);
});
test("common color needs explicit monochrome conversion and undoes mode plus color together", async ({
  page,
}) => {
  await start(page);
  await row(page, placements[0].id).click();
  await row(page, placements[1].id).click({ modifiers: ["Shift"] });
  await expect(confirm(page)).not.toBeChecked();
  await colors(page).getByLabel("適用する色", { exact: true }).fill("#123456");
  const apply = colors(page).getByRole("button", {
    name: "選択した配置に色を適用",
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await row(page, placements[2].id).click();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
    expectedPaints,
  );
  await confirm(page).check();
  await apply.click();
  for (const object of placements.slice(0, 2))
    expect(await paints(svgSymbol(canvas(page), object.id))).toEqual(
      expectedPaints.map(() => "#123456"),
    );
  const result = await exported(page);
  expect(result.symbols).toEqual(sample.symbols);
  await button(page, "元に戻す").click();
  await expect(confirm(page)).not.toBeChecked();
  expect((await exported(page)).screens).toEqual(sample.screens);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("mode and object drafts apply together only after validation, without implicit fill conversion", async ({
  page,
}) => {
  await start(page);
  await row(page, placements[0].id).click();
  await mode(page).selectOption("definition");
  await page.getByLabel("配置名", { exact: true }).fill("配色を確認する配置");
  await row(page, placements[1].id).click();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  let result = await exported(page);
  expect(
    result.screens[0].objects.find((o: any) => o.id === placements[0].id),
  ).toEqual({
    ...placements[0],
    name: "配色を確認する配置",
    shape: { ...placements[0].shape, colorMode: "definition" },
  });
  await button(page, "元に戻す").click();
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await row(page, placements[0].id).click();
  await mode(page).selectOption("definition");
  await page.getByLabel("width", { exact: true }).fill("0");
  await row(page, placements[1].id).click();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect(await paints(svgSymbol(canvas(page), placements[0].id))).toEqual(
    expectedPaints.map(() => placements[0].fill),
  );
});
test("shared child paint changes affect definition-mode placements while monochrome stays independent", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await expect(page.getByRole("note")).toContainText("共有定義の色");
  await selectPanel(page, "レイヤー");
  await row(page, sample.symbols[0].objects[0].id).click();
  await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#ff7700");
  await button(page, "塗りと枠線を適用").click();
  await button(page, "画面へ戻る").click();
  const changed = [...expectedPaints];
  changed[0] = "#ff7700";
  for (const object of placements.slice(1))
    expect(await paints(svgSymbol(canvas(page), object.id))).toEqual(changed);
  expect(await paints(svgSymbol(canvas(page), placements[0].id))).toEqual(
    expectedPaints.map(() => placements[0].fill),
  );
  await button(page, "元に戻す").click();
  expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
    expectedPaints,
  );
});
test("locked modes and mixed color conversion are disabled; hidden placement conversion stays hidden", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.screens[0].objects.find(
    (o: any) => o.id === placements[1].id,
  ).locked = true;
  project.screens[0].objects.find(
    (o: any) => o.id === placements[2].id,
  ).visible = false;
  await start(page, project);
  await row(page, placements[1].id).click();
  await expect(mode(page)).toBeDisabled();
  await expect(modeApply(page)).toBeDisabled();
  await row(page, placements[0].id).click({ modifiers: ["Shift"] });
  await expect(confirm(page)).toBeDisabled();
  await button(page, `ロック解除：${placements[1].name}`).click();
  await row(page, placements[1].id).click();
  await row(page, placements[2].id).click({ modifiers: ["Shift"] });
  await expect(colors(page)).toContainText("非表示 1 件");
  await colors(page).getByLabel("適用する色", { exact: true }).fill("#abcdef");
  await confirm(page).check();
  await colors(page)
    .getByRole("button", { name: "選択した配置に色を適用", exact: true })
    .click();
  const result = await exported(page);
  expect(
    result.screens[0].objects.find((o: any) => o.id === placements[2].id),
  ).toMatchObject({
    visible: false,
    fill: "#abcdef",
    shape: { colorMode: "monochrome" },
  });
  await expect(
    canvas(page).locator(`[data-object-id="${placements[2].id}"]`),
  ).toHaveCount(0);
});
test("native same/cross-project clipboard and screen duplication preserve mode and original fill", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  await row(page, placements[1].id).click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  let result = await exported(page);
  expect(result.screens[0].objects.at(-1)).toMatchObject({
    fill: placements[1].fill,
    shape: { colorMode: "definition" },
  });
  await selectPanel(page, "プロジェクト");
  await button(page, "画面を複製").click();
  result = await exported(page);
  expect(
    result.screens[1].objects
      .filter((o: any) => o.shape.type === "symbol")
      .map((o: any) => [o.shape.colorMode, o.fill]),
  ).toEqual(
    result.screens[0].objects
      .filter((o: any) => o.shape.type === "symbol")
      .map((o: any) => [o.shape.colorMode, o.fill]),
  );
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "target.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(minimal)),
  });
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+v");
  result = await exported(page);
  expect(result.screens[0].objects.at(-1)).toMatchObject({
    fill: placements[1].fill,
    shape: { colorMode: "definition" },
  });
  expect(result.symbols[0].objects).toEqual(sample.symbols[0].objects);
});
test("file menu opens the color sample through existing draft protection", async ({
  page,
}) => {
  await start(page, minimal);
  await row(page, minimal.screens[0].objects[0].id).click();
  await page.getByLabel("配置名", { exact: true }).fill("保持する入力");
  await fileCommand(page, "Symbol配色サンプルを開く");
  await prompt(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await fileCommand(page, "Symbol配色サンプルを開く");
  await prompt(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: sample.manifest.name, exact: true }),
  ).toBeVisible();
  expect(await paints(svgSymbol(canvas(page), placements[1].id))).toEqual(
    expectedPaints,
  );
});
for (const theme of ["light", "dark"] as const)
  test(`mode and explicit conversion controls fit narrow ${theme} panels`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await row(page, placements[1].id).click();
    await mode(page).selectOption("monochrome");
    await modeApply(page).click();
    await row(page, placements[2].id).click({ modifiers: ["Shift"] });
    await colors(page)
      .getByLabel("適用する色", { exact: true })
      .fill("#008f76");
    await confirm(page).check();
    await colors(page)
      .getByRole("button", { name: "選択した配置に色を適用", exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
