import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process-light.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const paint = (page: Page, id: string) =>
  page.locator(
    `.sheet > svg [data-object-id="${id}"] > [data-object-rotation]`,
  );
async function start(page: Page, project: any = structuredClone(sample)) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "alpha.json",
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
for (const theme of ["light", "dark"])
  test(`shape fill and stroke alpha stay independent from placement opacity in ${theme}`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample),
      object = project.screens[0].objects.find(
        (o: any) => o.shape.type === "rectangle",
      );
    object.shape.paint.stroke = { color: "#334155", width: 4, alpha: 0.8 };
    object.opacity = 0.6;
    await start(page, project);
    await chooseTheme(page, theme);
    await row(page, object.id).click();
    await page.getByLabel("色の不透明度（%）", { exact: true }).fill("25");
    await page.getByLabel("色の不透明度（%）", { exact: true }).press("Enter");
    const group = paint(page, object.id),
      rect = group.locator(":scope > rect");
    await expect(group).toHaveAttribute("opacity", "0.6");
    await expect(rect).toHaveAttribute("fill-opacity", "0.25");
    await expect(rect).toHaveAttribute("stroke-opacity", "0.8");
    const alpha = page.getByLabel("枠線の不透明度（%）", { exact: true });
    await alpha.fill("40");
    await expect(rect).toHaveAttribute("stroke-opacity", "0.8");
    await button(page, "塗りと枠線を適用").click();
    await expect(rect).toHaveAttribute("stroke-opacity", "0.4");
    await button(page, "元に戻す").click();
    await expect(rect).toHaveAttribute("stroke-opacity", "0.8");
    await expect(rect).toHaveAttribute("fill-opacity", "0.25");
    await button(page, "やり直す").click();
    const next = await saved(page),
      stored = next.screens[0].objects.find((o: any) => o.id === object.id);
    expect(stored.opacity).toBe(0.6);
    expect(stored.colorAlpha).toBe(0.25);
    expect(stored.shape.paint.stroke.alpha).toBe(0.4);
    await page.getByLabel("塗り", { exact: true }).selectOption("false");
    await button(page, "塗りと枠線を適用").click();
    await expect(
      page.getByLabel("色の不透明度（%）", { exact: true }),
    ).toBeDisabled();
    await expect(rect).toHaveAttribute("fill", "none");
    expect(
      (await saved(page)).screens[0].objects.find(
        (o: any) => o.id === object.id,
      ).colorAlpha,
    ).toBe(0.25);
    await page.getByLabel("塗り", { exact: true }).selectOption("true");
    await button(page, "塗りと枠線を適用").click();
    await expect(rect).toHaveAttribute("fill-opacity", "0.25");
  });
test("line and arrow share one color-alpha composition and transparent paint retains its hit area", async ({
  page,
}) => {
  const project = await start(page),
    object = project.screens[0].objects.find(
      (o: any) => o.shape.type === "polyline" && o.shape.arrow === "end",
    );
  await row(page, object.id).click();
  const input = page.getByLabel("色の不透明度（%）", { exact: true });
  await input.fill("50");
  await input.press("Enter");
  const group = paint(page, object.id);
  await expect(group).toHaveAttribute("opacity", "0.5");
  expect(
    await group.locator("polyline").getAttribute("stroke-opacity"),
  ).toBeNull();
  expect(
    await group.locator("polygon").getAttribute("fill-opacity"),
  ).toBeNull();
  await input.fill("0");
  await input.press("Enter");
  await expect(group).toHaveAttribute("opacity", "0");
  await expect(
    page.locator(
      `.sheet > svg [data-object-id="${object.id}"] > polyline[stroke="transparent"]`,
    ),
  ).toBeAttached();
  const point = await page.locator(".sheet > svg").evaluate((el) => {
    const p = new DOMPoint(820, 355).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await row(page, project.screens[0].objects[0].id).click();
  await page.mouse.click(point.x, point.y);
  await expect(row(page, object.id)).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(
      `.minimap [data-object-id="${object.id}"] > [data-object-rotation]`,
    ),
  ).toHaveAttribute("opacity", "0");
  await button(page, "表示プレビュー").click();
  await expect(paint(page, object.id)).toHaveAttribute("opacity", "0");
});
test("Symbol mode round trip keeps saved alpha and child paint while monochrome composites after overlap", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects.find(
      (o: any) => o.shape.type === "symbol",
    ),
    definition = project.symbols.find(
      (s: any) => s.id === object.shape.symbolId,
    );
  object.opacity = 0.5;
  object.colorAlpha = 0.4;
  definition.objects[0].opacity = 0.8;
  definition.objects[0].colorAlpha = 0.25;
  await start(page, project);
  await row(page, object.id).click();
  const group = paint(page, object.id),
    child = group.locator("svg > g").first();
  await expect(group).toHaveAttribute("opacity", "0.2");
  await expect(child).toHaveAttribute("opacity", "0.2");
  expect(
    await child.locator("polyline").getAttribute("stroke-opacity"),
  ).toBeNull();
  await page
    .getByLabel("色の使い方", { exact: true })
    .selectOption("definition");
  await button(page, "色の使い方を適用").click();
  await expect(group).toHaveAttribute("opacity", "0.5");
  const alpha = page.getByLabel("色の不透明度（%）", { exact: true });
  await expect(alpha).toBeDisabled();
  await expect(alpha).toHaveValue("40");
  await page
    .getByLabel("色の使い方", { exact: true })
    .selectOption("monochrome");
  await button(page, "色の使い方を適用").click();
  await expect(group).toHaveAttribute("opacity", "0.2");
  await expect(alpha).toHaveValue("40");
  const next = await saved(page);
  expect(next.symbols).toEqual(project.symbols);
  expect(
    next.screens[0].objects.find((o: any) => o.id === object.id).colorAlpha,
  ).toBe(0.4);
});
test("default paint submits without creating alpha fields/history and invalid numeric alpha can be cancelled", async ({
  page,
}) => {
  const project = await start(page),
    object = project.screens[0].objects.find(
      (o: any) => o.shape.type === "rectangle",
    );
  await row(page, object.id).click();
  await button(page, "塗りと枠線を適用").click();
  await button(page, "変更を適用").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  const alpha = page.getByLabel("色の不透明度（%）", { exact: true });
  await alpha.fill("-1");
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-invalid", "true");
  await alpha.press("Escape");
  await expect(alpha).toHaveValue("100");
  expect((await saved(page)).screens).toEqual(project.screens);
});
test("overlapping Symbol primitives retain uniform final alpha instead of multiplying opacity per child", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects.find(
      (o: any) => o.shape.type === "symbol",
    ),
    definition = project.symbols.find(
      (s: any) => s.id === object.shape.symbolId,
    );
  definition.width = 100;
  definition.height = 100;
  definition.objects = definition.objects
    .slice(0, 2)
    .map((child: any, index: number) => ({
      ...child,
      x: index * 25,
      y: 0,
      width: 75,
      height: 100,
      shape: { type: "rectangle", paint: { fillEnabled: true, stroke: null } },
    }));
  object.width = 100;
  object.height = 100;
  object.colorAlpha = 0.4;
  object.opacity = 0.5;
  await start(page, project);
  const alphas = await paint(page, object.id).evaluate(async (element) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${element.outerHTML}</svg>`;
    const image = new Image();
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [10, 40, 90].map((x) => context.getImageData(x, 50, 1, 1).data[3]);
  });
  expect(alphas).toEqual([51, 51, 51]);
});
