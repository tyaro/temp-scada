import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const a = "0199fc00-0000-7000-8000-000000001001",
  b = "0199fc00-0000-7000-8000-000000001002";
const rectangle = sample.screens[0].objects[0].id,
  ellipse = sample.screens[0].objects[1].id;
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const svg = (page: Page) => page.locator(".sheet > svg");
const paint = (page: Page, id: string, tag: string) =>
  svg(page).locator(
    `[data-object-id="${id}"] > [data-object-rotation] > ${tag}`,
  );
function fixture(): any {
  const project: any = structuredClone(sample);
  for (const object of project.screens[0].objects.slice(0, 2))
    object.shape.paint.stroke = { color: "#334155", width: 4 };
  for (const [index, id] of [a, b].entries())
    project.screens[0].objects.push({
      id,
      order: 6 + index,
      x: 100,
      y: 380 + index * 55,
      rotation: 0,
      fill: "#2563eb",
      name: `配管${index + 1}`,
      shape: {
        type: "polyline",
        points: [
          { x: 0, y: 0 },
          { x: 300, y: 0 },
        ],
        strokeWidth: 4,
        arrow: "end",
      },
    });
  return project;
}
async function start(page: Page, project = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "styles.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  return project;
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
async function applyLine(page: Page, style: string) {
  await page.getByLabel("線種", { exact: true }).selectOption(style);
  await button(page, "変更を適用").click();
}
for (const theme of ["light", "dark"])
  test(`single line style is staged, scales with width, preserves arrow and survives preview/JSON in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await row(page, a).click();
    const line = paint(page, a, "polyline");
    await page.getByLabel("線種", { exact: true }).selectOption("dashed");
    await expect(line).not.toHaveAttribute("stroke-dasharray");
    await button(page, "変更を適用").click();
    await expect(line).toHaveAttribute("stroke-dasharray", "16 8");
    await expect(line).toHaveAttribute("stroke-linecap", "butt");
    await expect(paint(page, a, "polygon")).not.toHaveAttribute(
      "stroke-dasharray",
    );
    await page.getByLabel("線幅", { exact: true }).fill("6");
    await page.getByLabel("線幅", { exact: true }).press("Enter");
    await expect(line).toHaveAttribute("stroke-dasharray", "24 12");
    await button(page, "元に戻す").click();
    await expect(line).toHaveAttribute("stroke-dasharray", "16 8");
    await button(page, "やり直す").click();
    await expect(
      page.locator('.minimap svg [data-object-id="' + a + '"] polyline'),
    ).toHaveAttribute("stroke-dasharray", "24 12");
    const next = await saved(page);
    expect(next.manifest.schemaVersion).toBe("0.15.0");
    expect(
      next.screens[0].objects.find((o: any) => o.id === a).shape,
    ).toMatchObject({ lineStyle: "dashed", strokeWidth: 6, arrow: "end" });
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles({
        name: "saved.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(next)),
      });
    await button(page, "表示プレビュー").click();
    await expect(line).toHaveAttribute("stroke-dasharray", "24 12");
  });
test("outlined shapes use shared presets without changing fill or dimensions, including explicit-solid no-op", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].shape.paint.stroke.lineStyle = "solid";
  await start(page, project);
  await row(page, rectangle).click();
  await button(page, "塗りと枠線を適用").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("枠線の線種", { exact: true }).selectOption("dotted");
  await button(page, "塗りと枠線を適用").click();
  const shape = paint(page, rectangle, "rect");
  await expect(shape).toHaveAttribute("stroke-dasharray", "0 8");
  await expect(shape).toHaveAttribute("stroke-linecap", "round");
  const next = await saved(page);
  expect(next.screens[0].objects[0]).toEqual({
    ...project.screens[0].objects[0],
    shape: {
      ...project.screens[0].objects[0].shape,
      paint: {
        ...project.screens[0].objects[0].shape.paint,
        stroke: { color: "#334155", width: 4, lineStyle: "dotted" },
      },
    },
  });
  await page.getByLabel("枠線の線種", { exact: true }).selectOption("solid");
  await button(page, "塗りと枠線を適用").click();
  await expect(shape).not.toHaveAttribute("stroke-dasharray");
  await row(page, ellipse).click();
  await page.getByLabel("枠線の線種", { exact: true }).selectOption("dashed");
  await button(page, "塗りと枠線を適用").click();
  await expect(paint(page, ellipse, "ellipse")).toHaveAttribute(
    "stroke-dasharray",
    "16 8",
  );
});
test("bulk line styles include hidden objects, preserve untouched properties, reset drafts and use one Undo", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects.find((o: any) => o.id === b).visible = false;
  await start(page, project);
  await row(page, a).click();
  await row(page, b).click({ modifiers: ["Shift"] });
  const style = page.getByLabel("適用する線種", { exact: true });
  await expect(style).toHaveValue("");
  await style.selectOption("dotted");
  await button(page, "選択した線・配管に適用").click();
  await expect(style).toHaveValue("");
  const next = await saved(page);
  expect(next.screens[0].objects).toEqual(
    project.screens[0].objects.map((o: any) =>
      [a, b].includes(o.id)
        ? { ...o, shape: { ...o.shape, lineStyle: "dotted" } }
        : o,
    ),
  );
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).screens).toEqual(project.screens);
});
test("bulk outline style requires explicit absent-stroke creation and does not erase styles on width edits", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].shape.paint.stroke = null;
  await start(page, project);
  await row(page, rectangle).click();
  await row(page, ellipse).click({ modifiers: ["Shift"] });
  const style = page.getByLabel("適用する枠線の線種", { exact: true });
  await style.selectOption("dashed");
  await expect(button(page, "選択した矩形・楕円の枠線に適用")).toBeDisabled();
  await page
    .getByLabel("適用する枠線", { exact: true })
    .selectOption("enabled");
  await page.getByLabel("適用する枠線色", { exact: true }).fill("#334155");
  await page.getByLabel("適用する枠線幅", { exact: true }).fill("4");
  await button(page, "選択した矩形・楕円の枠線に適用").click();
  await expect(style).toHaveValue("");
  await page.getByLabel("適用する枠線幅", { exact: true }).fill("8");
  await button(page, "選択した矩形・楕円の枠線に適用").click();
  const next = await saved(page);
  expect(
    next.screens[0].objects
      .slice(0, 2)
      .every(
        (o: any) =>
          o.shape.paint.stroke.lineStyle === "dashed" &&
          o.shape.paint.stroke.width === 8,
      ),
  ).toBe(true);
  await style.selectOption("solid");
  await page.getByLabel("適用する枠線", { exact: true }).selectOption("none");
  await expect(button(page, "選択した矩形・楕円の枠線に適用")).toBeDisabled();
  await button(page, "指定を解除").click();
  await expect(style).toHaveValue("");
  await expect(button(page, "選択した矩形・楕円の枠線に適用")).toBeDisabled();
});
test("staged style participates in input protection; cancelled transitions keep it and locked selections cannot apply", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects.find((o: any) => o.id === b).locked = true;
  await start(page, project);
  await row(page, a).click();
  await page.getByLabel("線種", { exact: true }).selectOption("dotted");
  await page.getByLabel("線幅", { exact: true }).fill("6");
  await page.getByLabel("線幅", { exact: true }).press("Enter");
  await expect(page.getByLabel("線種", { exact: true })).toHaveValue("dotted");
  await expect(paint(page, a, "polyline")).toHaveAttribute("stroke-width", "6");
  await expect(paint(page, a, "polyline")).not.toHaveAttribute(
    "stroke-dasharray",
  );
  await button(page, "表示プレビュー").click();
  const guard = page.getByRole("dialog", { name: "未適用の入力があります" });
  await guard.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("線種", { exact: true })).toHaveValue("dotted");
  await expect(paint(page, a, "polyline")).not.toHaveAttribute(
    "stroke-dasharray",
  );
  await button(page, "変更を適用").click();
  await row(page, b).click();
  await expect(page.getByLabel("線種", { exact: true })).toBeDisabled();
  await row(page, a).click({ modifiers: ["Shift"] });
  await expect(page.getByLabel("適用する線種", { exact: true })).toBeDisabled();
});
test("dotted gaps keep continuous hit regions and changing rotation or color preserves style", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects.find((o: any) => o.id === a).shape.lineStyle =
    "dotted";
  await start(page, project);
  const point = await svg(page).evaluate((el) => {
    const p = new DOMPoint(104, 380).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(row(page, a)).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("回転角度", { exact: true }).fill("33");
  await page.getByLabel("回転角度", { exact: true }).press("Enter");
  await expect(paint(page, a, "polyline")).toHaveAttribute(
    "stroke-dasharray",
    "0 8",
  );
  await page.getByLabel("色", { exact: true }).fill("#ff0000");
  await button(page, "変更を適用").click();
  await expect(paint(page, a, "polyline")).toHaveAttribute("stroke", "#ff0000");
  await expect(paint(page, a, "polyline")).toHaveAttribute(
    "stroke-dasharray",
    "0 8",
  );
});
test("definition line style propagates through both symbol color modes without changing placement geometry", async ({
  page,
}) => {
  const project = fixture(),
    child = {
      ...structuredClone(
        project.screens[0].objects.find((o: any) => o.id === a),
      ),
      id: "0199fc00-0000-7000-8000-000000001003",
      x: 0,
      y: 20,
    };
  project.symbols = [
    {
      id: "0199fc00-0000-7000-8000-000000001004",
      name: "線の定義",
      width: 320,
      height: 60,
      folders: [],
      objects: [child],
    },
  ];
  for (let i = 0; i < 2; i++)
    project.screens[0].objects.push({
      id: `0199fc00-0000-7000-8000-00000000100${5 + i}`,
      order: 10 + i,
      x: 400,
      y: 200 + i * 100,
      width: 320,
      height: 60,
      rotation: 0,
      fill: "#10b981",
      shape: {
        type: "symbol",
        symbolId: project.symbols[0].id,
        colorMode: i ? "definition" : "monochrome",
      },
    });
  await start(page, project);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await row(page, child.id).click();
  await applyLine(page, "dashed");
  await button(page, "画面へ戻る").click();
  await expect(
    svg(page).locator('[data-symbol-id] polyline[stroke-dasharray="16 8"]'),
  ).toHaveCount(2);
  const next = await saved(page);
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects[0].shape.lineStyle).toBe("dashed");
});
