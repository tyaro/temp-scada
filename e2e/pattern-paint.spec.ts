import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import process from "../examples/process-light.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
const target = sample.screens[0].objects[0],
  form = (p: Page) => p.getByRole("form", { name: "塗りと枠線", exact: true }),
  button = (p: Page, name: string) =>
    p.getByRole("button", { name, exact: true }),
  row = (p: Page, id = target.id) => p.locator(`button[data-layer-id="${id}"]`),
  node = (p: Page, id = target.id) =>
    p.locator(`.sheet > svg [data-object-id="${id}"] > [data-object-rotation]`);
async function start(p: Page, project: object = sample, id = target.id) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "pattern.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(p, "レイヤー");
  await row(p, id).click();
}
async function stage(p: Page) {
  await form(p)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("pattern");
  await form(p)
    .getByLabel("模様の種類", { exact: true })
    .selectOption("crosshatch");
  await form(p).getByLabel("模様の間隔", { exact: true }).fill("12");
  await form(p).getByLabel("模様の太さ", { exact: true }).fill("4");
  await form(p).getByLabel("模様の角度", { exact: true }).fill("405");
  await form(p).getByLabel("模様の色", { exact: true }).fill("#22aa66");
  await form(p).getByLabel("模様の不透明度（%）", { exact: true }).fill("50");
}
async function saved(p: Page) {
  const wait = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
for (const theme of ["light", "dark"])
  test(`pattern preview stays staged, then survives none, resize, rotation, Undo and save in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await stage(page);
    const preview = page.getByRole("img", {
      name: "模様の見本（未適用）",
      exact: true,
    });
    await expect(preview.locator("pattern")).toHaveAttribute(
      "patternTransform",
      "rotate(45)",
    );
    await expect(preview.locator("path")).toHaveAttribute(
      "fill-opacity",
      "0.5",
    );
    await expect(node(page).locator(":scope > rect")).toHaveAttribute(
      "fill",
      target.shape.paint.fill.paint.color,
    );
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "塗りと枠線を適用").click();
    const pattern = node(page).locator("pattern");
    await expect(pattern).toHaveAttribute("patternTransform", "rotate(45)");
    await expect(pattern).toHaveAttribute("width", "12");
    const project = await saved(page),
      paint = project.screens[0].objects[0].shape.paint;
    expect(paint.fill.paint).toEqual({
      type: "pattern",
      kind: "crosshatch",
      spacing: 12,
      size: 4,
      angle: 45,
      foreground: { color: "#22aa66", alpha: 0.5 },
      background: null,
    });
    await form(page).getByLabel("塗り", { exact: true }).selectOption("false");
    await button(page, "塗りと枠線を適用").click();
    await expect(node(page).locator(":scope > rect")).toHaveAttribute(
      "fill",
      "none",
    );
    expect(
      (await saved(page)).screens[0].objects[0].shape.paint.fill.paint,
    ).toEqual(paint.fill.paint);
    await button(page, "元に戻す").click();
    await page.getByLabel("width", { exact: true }).fill("300");
    await page.getByLabel("width", { exact: true }).press("Enter");
    await page.getByLabel("回転角度", { exact: true }).fill("30");
    await page.getByLabel("回転角度", { exact: true }).press("Enter");
    await expect(pattern).toHaveAttribute("width", "12");
    await expect(pattern).toHaveAttribute("patternTransform", "rotate(45)");
    await button(page, "表示プレビュー").click();
    await expect(node(page).locator("pattern > path")).toHaveAttribute(
      "fill-opacity",
      "0.5",
    );
  });
test("pattern kind and fill type preserve drafts; background clearing is explicit and invalid ratios block all forms", async ({
  page,
}) => {
  await start(page);
  await stage(page);
  await form(page)
    .getByLabel("模様の種類", { exact: true })
    .selectOption("dots");
  await expect(
    form(page).getByLabel("模様の太さ", { exact: true }),
  ).toHaveValue("3");
  await expect(
    form(page).getByLabel("模様の角度", { exact: true }),
  ).toHaveValue("0");
  await form(page)
    .getByLabel("模様の種類", { exact: true })
    .selectOption("crosshatch");
  await expect(
    form(page).getByLabel("模様の太さ", { exact: true }),
  ).toHaveValue("4");
  await expect(
    form(page).getByLabel("模様の角度", { exact: true }),
  ).toHaveValue("405");
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("linearGradient");
  await expect(
    form(page).getByLabel("グラデーションの始点の色", { exact: true }),
  ).toHaveValue("#22aa66");
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("pattern");
  await expect(
    form(page).getByLabel("模様の太さ", { exact: true }),
  ).toHaveValue("4");
  await form(page)
    .getByLabel("模様の背景", { exact: true })
    .selectOption("true");
  await form(page).getByLabel("模様の背景色", { exact: true }).fill("#eeeeff");
  await form(page)
    .getByLabel("模様の背景の不透明度（%）", { exact: true })
    .fill("25");
  await form(page)
    .getByLabel("模様の背景", { exact: true })
    .selectOption("false");
  await form(page)
    .getByLabel("模様の背景", { exact: true })
    .selectOption("true");
  await expect(
    form(page).getByLabel("模様の背景の不透明度（%）", { exact: true }),
  ).toHaveValue("25");
  await form(page).getByLabel("模様の太さ", { exact: true }).fill("7");
  await page.getByLabel("配置名", { exact: true }).fill("未適用");
  await row(page, sample.screens[0].objects[1].id).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(node(page).locator("pattern")).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "未適用",
  );
  await form(page).getByLabel("模様の太さ", { exact: true }).fill("4");
  await row(page, sample.screens[0].objects[1].id).click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await row(page).click();
  expect(
    (await saved(page)).screens[0].objects[0].shape.paint.fill.paint.background,
  ).toEqual({ color: "#eeeeff", alpha: 0.25 });
  await form(page)
    .getByLabel("模様の背景", { exact: true })
    .selectOption("false");
  await button(page, "塗りと枠線を適用").click();
  expect(
    (await saved(page)).screens[0].objects[0].shape.paint.fill.paint.background,
  ).toBeNull();
});
test("crossings and tile boundaries have the same actual alpha after placement composition; transparent cells remain selectable", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects[0];
  object.width = 240;
  object.height = 120;
  object.opacity = 0.6;
  object.shape.paint.fill.paint = {
    type: "pattern",
    kind: "crosshatch",
    spacing: 12,
    size: 4,
    angle: 0,
    foreground: { color: "#22aa66", alpha: 0.5 },
    background: null,
  };
  await start(page, project);
  const raster = () =>
    node(page).evaluate(async (element) => {
      const image = new Image();
      image.src =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">${element.outerHTML}</svg>`,
        );
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 120;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return [
        [6, 6],
        [1, 6],
        [12, 6],
        [1, 1],
      ].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
    });
  expect(await raster()).toEqual([77, 77, 77, 0]);
  await form(page)
    .getByLabel("模様の背景", { exact: true })
    .selectOption("true");
  await form(page).getByLabel("模様の背景色", { exact: true }).fill("#22aa66");
  await form(page)
    .getByLabel("模様の背景の不透明度（%）", { exact: true })
    .fill("50");
  await button(page, "塗りと枠線を適用").click();
  // Same RGB and semi-transparent alpha still accumulate foreground over background.
  expect(await raster()).toEqual([115, 115, 115, 77]);
  const point = await page.locator(".sheet > svg").evaluate((svg) => {
    const point = new DOMPoint(101, 171).matrixTransform(
      (svg as SVGSVGElement).getScreenCTM()!,
    );
    return { x: point.x, y: point.y };
  });
  await row(page, sample.screens[0].objects[1].id).click();
  await page.mouse.click(point.x, point.y);
  await expect(row(page)).toHaveAttribute("aria-pressed", "true");
});
test("pattern Symbols preserve alpha under monochrome and use unique renderer IDs; bulk RGB explains the refusal", async ({
  page,
}) => {
  const project: any = structuredClone(process),
    definition = project.symbols[0],
    first = project.screens[0].objects.find(
      (o: any) =>
        o.shape.type === "symbol" && o.shape.symbolId === definition.id,
    ),
    child = definition.objects[0];
  definition.objects = [
    {
      id: child.id,
      order: child.order,
      x: 0,
      y: 0,
      rotation: 0,
      width: definition.width,
      height: definition.height,
      shape: {
        type: "ellipse",
        paint: {
          fill: {
            enabled: true,
            paint: {
              type: "pattern",
              kind: "dots",
              spacing: 12,
              size: 3,
              angle: 0,
              foreground: { color: "#22aa66", alpha: 0.5 },
              background: { color: "#eeeeff", alpha: 0.25 },
            },
          },
          stroke: null,
        },
      },
    },
  ];
  first.shape.colorMode = "monochrome";
  first.colorAlpha = 0.4;
  first.opacity = 0.5;
  project.screens[0].objects.push({
    ...first,
    id: "0199f111-0000-7000-8000-000000000001",
    order: Math.max(...project.screens[0].objects.map((o: any) => o.order)) + 1,
    x: first.x + 180,
    shape: { ...first.shape, colorMode: "definition" },
  });
  await start(page, project, first.id);
  await expect(node(page, first.id)).toHaveAttribute("opacity", "0.2");
  await expect(node(page, first.id).locator("pattern > path")).toHaveAttribute(
    "fill",
    first.fill,
  );
  await expect(node(page, first.id).locator("pattern > path")).toHaveAttribute(
    "fill-opacity",
    "0.5",
  );
  await expect(node(page, first.id).locator("pattern > rect")).toHaveAttribute(
    "fill-opacity",
    "0.25",
  );
  const ids = await page
    .locator("pattern")
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(ids.length).toBeGreaterThan(3);
  expect(new Set(ids).size).toBe(ids.length);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "minimal.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await row(page).click();
  await stage(page);
  await button(page, "塗りと枠線を適用").click();
  await row(page, sample.screens[0].objects[1].id).click({
    modifiers: ["Shift"],
  });
  const colors = page.getByRole("form", {
    name: "選択した配置の色",
    exact: true,
  });
  await expect(colors).toContainText("模様");
  await expect(colors.getByLabel("適用する色", { exact: true })).toBeDisabled();
});
for (const theme of ["light", "dark"])
  test(`pattern controls scroll within a narrow ${theme} inspector and IME cannot apply partial input`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await stage(page);
    const angle = form(page).getByLabel("模様の角度", { exact: true });
    await angle.dispatchEvent("compositionstart");
    await angle.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    await expect(node(page).locator("pattern")).toHaveCount(0);
    await angle.dispatchEvent("compositionend");
    await button(page, "塗りと枠線を適用").scrollIntoViewIfNeeded();
    await expect(button(page, "塗りと枠線を適用")).toBeInViewport();
    expect(
      await form(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await button(page, "塗りと枠線を適用").click();
    await expect(node(page).locator("pattern")).toHaveAttribute("width", "12");
  });
