import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import process from "../examples/process-light.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
const target = sample.screens[0].objects[0];
const form = (p: Page) =>
  p.getByRole("form", { name: "塗りと枠線", exact: true });
const shape = (p: Page) =>
  p.locator(
    `.sheet > svg > [data-object-id="${target.id}"] > [data-object-rotation]`,
  );
async function start(p: Page, project: object = sample, id = target.id) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "radial.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(p, "レイヤー");
  await p.locator(`button[data-layer-id="${id}"]`).click();
}
async function radial(p: Page) {
  await form(p)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("radialGradient");
  for (const [name, value] of [
    ["radialStartColor", "#ff0000"],
    ["radialEndColor", "#0000ff"],
    ["radialStartAlpha", "25"],
    ["radialEndAlpha", "80"],
  ])
    await form(p).locator(`[name="${name}"]`).fill(value);
  await form(p)
    .getByRole("button", { name: "塗りと枠線を適用", exact: true })
    .click();
}
async function save(p: Page) {
  const pending = p.waitForEvent("download");
  await fileCommand(p, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
async function pixels(p: Page, width: number, height: number) {
  const points = await shape(p).evaluate(
    (el, { width, height }) => {
      const m = (el as SVGGElement).getScreenCTM()!;
      return [
        [0.5, 0.5],
        [0.9, 0.85],
        [0.8, 0.5],
        [0.5, 0.8],
      ].map(([x, y]) => {
        const q = new DOMPoint(x * width, y * height).matrixTransform(m);
        return { x: q.x, y: q.y };
      });
    },
    { width, height },
  );
  const encoded = (await p.screenshot()).toString("base64");
  const rgba = await p.evaluate(
    async ({ encoded, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return points.map((q) =>
        Array.from(
          ctx.getImageData(Math.round(q.x), Math.round(q.y), 1, 1).data,
        ),
      );
    },
    { encoded, points },
  );
  for (const [index, expected] of [
    [0, [255, 217, 217, 255]],
    [1, [133, 133, 255, 255]],
  ] as const)
    rgba[index].forEach((v, i) =>
      expect(Math.abs(v - expected[i])).toBeLessThan(10),
    );
  rgba[2].forEach((v, i) => expect(Math.abs(v - rgba[3][i])).toBeLessThan(8));
}
for (const theme of ["light", "dark"] as const)
  test(`${theme}: radial pixels follow a non-square rotated frame, stop alpha and resize`, async ({
    page,
  }) => {
    const project = structuredClone(sample);
    project.screens[0].background = "#ffffff";
    Object.assign(project.screens[0].objects[0], {
      width: 240,
      height: 80,
      rotation: 37,
      opacity: 0.6,
    });
    await start(page, project);
    await chooseTheme(page, theme);
    await radial(page);
    const gradient = shape(page).locator("radialGradient");
    await expect(gradient).toHaveAttribute(
      "gradientUnits",
      "objectBoundingBox",
    );
    await expect(gradient).toHaveAttribute("r", "0.5");
    await expect(gradient).toHaveAttribute("fx", "0.5");
    await expect(gradient).toHaveAttribute("spreadMethod", "pad");
    await pixels(page, 240, 80);
    await page.getByLabel("width", { exact: true }).fill("360");
    await page.getByLabel("width", { exact: true }).press("Enter");
    await page.getByLabel("height", { exact: true }).fill("120");
    await page.getByLabel("height", { exact: true }).press("Enter");
    await pixels(page, 360, 120);
    const result = await save(page);
    expect(result.manifest.schemaVersion).toBe("0.34.0");
    expect(result.screens[0].objects[0].shape.paint.fill.paint).toEqual({
      type: "radialGradient",
      center: { x: 0.5, y: 0.5 },
      radius: 0.5,
      start: { color: "#ff0000", alpha: 0.25 },
      end: { color: "#0000ff", alpha: 0.8 },
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await pixels(page, 360, 120);
  });
test("linear and radial retain independent drafts and both end colors; invalid and IME edits stay uncommitted", async ({
  page,
}) => {
  await start(page);
  const f = form(page),
    kind = f.getByLabel("塗りの種類", { exact: true });
  await kind.selectOption("linearGradient");
  for (const [name, value] of [
    ["fillStartColor", "#ee8800"],
    ["fillEndColor", "#2266cc"],
    ["fillStartAlpha", "25"],
    ["fillEndAlpha", "80"],
    ["fillAngle", "405"],
  ])
    await f.locator(`[name="${name}"]`).fill(value);
  await kind.selectOption("radialGradient");
  await expect(f.locator('[name="radialEndColor"]')).toHaveValue("#2266cc");
  await expect(f.locator('[name="radialEndAlpha"]')).toHaveValue("80");
  await f.locator('[name="radialRadius"]').fill("125");
  await f.locator('[name="radialEndColor"]').fill("#00ff00");
  await kind.selectOption("linearGradient");
  await expect(f.locator('[name="fillEndColor"]')).toHaveValue("#2266cc");
  await expect(f.locator('[name="fillAngle"]')).toHaveValue("405");
  await kind.selectOption("radialGradient");
  await expect(f.locator('[name="radialRadius"]')).toHaveValue("125");
  await expect(f.locator('[name="radialEndColor"]')).toHaveValue("#00ff00");
  const radius = f.locator('[name="radialRadius"]');
  await radius.fill("0");
  await expect(
    f.getByRole("img", {
      name: "放射グラデーションの見本（未適用）",
      exact: true,
    }),
  ).toHaveCount(0);
  await f
    .getByRole("button", { name: "塗りと枠線を適用", exact: true })
    .click();
  await expect(shape(page).locator("radialGradient")).toHaveCount(0);
  await radius.fill("125");
  await radius.dispatchEvent("compositionstart");
  await radius.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(shape(page).locator("radialGradient")).toHaveCount(0);
  await radius.dispatchEvent("compositionend");
  await f
    .getByRole("button", { name: "塗りと枠線を適用", exact: true })
    .click();
  await expect(shape(page).locator("radialGradient")).toHaveAttribute(
    "r",
    "1.25",
  );
  await page.keyboard.press("Control+z");
  await expect(shape(page).locator("radialGradient")).toHaveCount(0);
});
test("repeated Symbol and minimap gradients have distinct IDs and monochrome preserves stop alpha", async ({
  page,
}) => {
  const project: any = structuredClone(process),
    def = project.symbols[0],
    first = project.screens[0].objects.find(
      (o: any) => o.shape.type === "symbol" && o.shape.symbolId === def.id,
    );
  const old = def.objects[0];
  def.objects = [
    {
      id: old.id,
      order: 0,
      x: 0,
      y: 0,
      width: def.width,
      height: def.height,
      rotation: 0,
      shape: {
        type: "rectangle",
        paint: {
          stroke: null,
          fill: {
            enabled: true,
            paint: {
              type: "radialGradient",
              center: { x: 0, y: 1 },
              radius: 2,
              start: { color: "#ee8800", alpha: 0.25 },
              end: { color: "#2266cc", alpha: 0.8 },
            },
          },
        },
      },
    },
  ];
  project.screens[0].objects.push({
    ...structuredClone(first),
    id: "0199f000-0000-7000-8000-000000000099",
    order: 99,
    x: 500,
    y: 400,
  });
  await start(page, project, first.id);
  const gradients = page.locator("radialGradient");
  expect(await gradients.count()).toBeGreaterThan(2);
  const gradientIds = await gradients.evaluateAll((nodes) =>
    nodes.map((n) => n.id),
  );
  expect(new Set(gradientIds).size).toBe(gradientIds.length);
  const monochrome = page.locator(
    `.sheet > svg > [data-object-id="${first.id}"] radialGradient`,
  );
  await expect(monochrome.locator("stop").first()).toHaveAttribute(
    "stop-color",
    first.fill,
  );
  await expect(monochrome.locator("stop").first()).toHaveAttribute(
    "stop-opacity",
    "0.25",
  );
  await expect(monochrome.locator("stop").last()).toHaveAttribute(
    "stop-opacity",
    "0.8",
  );
});
test("embedded screen and preview window share radial painting with separate SVG identities", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    source = project.screens[0];
  source.objects = [structuredClone(target)];
  source.objects[0].shape.paint.fill.paint = {
    type: "radialGradient",
    center: { x: 0.25, y: 0.75 },
    radius: 0.75,
    start: { color: "#ee8800", alpha: 0.25 },
    end: { color: "#2266cc", alpha: 0.8 },
  };
  const view = {
    id: "0199f000-0000-7000-8000-000000000091",
    order: 0,
    x: 20,
    y: 20,
    width: 600,
    height: 400,
    rotation: 0,
    shape: { type: "screenView", screenId: source.id, fit: "contain" },
  };
  project.screens.unshift({
    id: "0199f000-0000-7000-8000-000000000090",
    name: "埋込先",
    width: 960,
    height: 540,
    background: "#ffffff",
    folders: [],
    groups: [],
    objects: [view],
  });
  await start(page, project, view.id);
  const embedded = page.locator(
    `.sheet [data-source-object-id="${target.id}"] radialGradient`,
  );
  await expect(embedded).toHaveAttribute("r", "0.75");
  await expect(embedded).toHaveAttribute("cx", "0.25");
  await expect(
    page.locator('[aria-label="ミニマップ"] radialGradient'),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await picker.locator(`input[value="${source.id}"]`).check();
  await picker.getByRole("button", { name: "小窓を表示", exact: true }).click();
  const popup = page.locator(
    `[data-preview-popup="${source.id}"] radialGradient`,
  );
  await expect(popup).toHaveAttribute("r", "0.75");
  await expect(popup.locator("stop").last()).toHaveAttribute(
    "stop-opacity",
    "0.8",
  );
  const ids = await page
    .locator("radialGradient")
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(2);
});
