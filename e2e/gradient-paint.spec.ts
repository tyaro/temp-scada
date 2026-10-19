import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import process from "../examples/process-light.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
const target = sample.screens[0].objects[0];
const form = (p: Page) =>
  p.getByRole("form", { name: "塗りと枠線", exact: true });
const btn = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const row = (p: Page, id = target.id) =>
  p.locator(`button[data-layer-id="${id}"]`);
const node = (p: Page, id = target.id) =>
  p.locator(`.sheet > svg [data-object-id="${id}"] > [data-object-rotation]`);
async function start(p: Page, project: object = sample, id = target.id) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await btn(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "gradient.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(p, "レイヤー");
  await row(p, id).click();
}
async function setGradient(p: Page) {
  await form(p)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("linearGradient");
  await form(p)
    .getByLabel("グラデーションの始点の色", { exact: true })
    .fill("#ee8800");
  await form(p)
    .getByLabel("グラデーションの終点の色", { exact: true })
    .fill("#2266cc");
  await form(p)
    .getByLabel("グラデーションの始点の不透明度（%）", { exact: true })
    .fill("25");
  await form(p)
    .getByLabel("グラデーションの終点の不透明度（%）", { exact: true })
    .fill("80");
  await form(p).getByLabel("グラデーションの角度", { exact: true }).fill("405");
  await btn(p, "塗りと枠線を適用").click();
}
async function saved(p: Page) {
  const wait = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
for (const theme of ["light", "dark"]) {
  test(`gradient applies atomically, survives none, Undo, resize, save and preview in ${theme}`, async ({
    page,
  }) => {
    const project = structuredClone(sample);
    project.screens[0].objects[0].width = 200;
    project.screens[0].objects[0].height = 100;
    project.screens[0].objects[0].rotation = 30;
    await start(page, project);
    await chooseTheme(page, theme);
    await setGradient(page);
    const gradient = node(page).locator("linearGradient");
    await expect(gradient).toHaveAttribute("gradientUnits", "userSpaceOnUse");
    expect(Number(await gradient.getAttribute("x1"))).toBeCloseTo(25, 10);
    await expect(gradient.locator("stop").first()).toHaveAttribute(
      "stop-opacity",
      "0.25",
    );
    await expect(gradient.locator("stop").last()).toHaveAttribute(
      "stop-opacity",
      "0.8",
    );
    await expect(
      form(page).getByLabel("グラデーションの角度", { exact: true }),
    ).toHaveValue("45");
    const snapshot = await saved(page),
      paint = snapshot.screens[0].objects[0].shape.paint;
    expect(paint.fill.paint).toEqual({
      type: "linearGradient",
      angle: 45,
      start: { color: "#ee8800", alpha: 0.25 },
      end: { color: "#2266cc", alpha: 0.8 },
    });
    expect(snapshot.screens[0].objects[0].fill).toBeUndefined();
    await form(page).getByLabel("塗り", { exact: true }).selectOption("false");
    await btn(page, "塗りと枠線を適用").click();
    await expect(node(page).locator(":scope > rect")).toHaveAttribute(
      "fill",
      "none",
    );
    expect(
      (await saved(page)).screens[0].objects[0].shape.paint.fill.paint,
    ).toEqual(paint.fill.paint);
    await btn(page, "元に戻す").click();
    await expect(node(page).locator(":scope > rect")).toHaveAttribute(
      "fill",
      /^url\(#/,
    );
    await page.getByLabel("width", { exact: true }).fill("300");
    await page.getByLabel("width", { exact: true }).press("Enter");
    const ref = await node(page).locator(":scope > rect").getAttribute("fill");
    expect(ref).toMatch(/^url\(#/);
    expect(
      Number(await gradient.getAttribute("x2")) -
        Number(await gradient.getAttribute("x1")),
    ).toBeCloseTo(200, 8);
    await btn(page, "表示プレビュー").click();
    await expect(node(page).locator("stop").last()).toHaveAttribute(
      "stop-opacity",
      "0.8",
    );
  });
}
test("paint type conversion uses current colors, preserves local drafts and blocks invalid or IME partial changes", async ({
  page,
}) => {
  await start(page);
  await form(page).getByLabel("塗りの色", { exact: true }).fill("#123456");
  await form(page)
    .getByLabel("塗りの不透明度（%）", { exact: true })
    .fill("40");
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("linearGradient");
  await expect(
    form(page).getByLabel("グラデーションの終点の色", { exact: true }),
  ).toHaveValue("#123456");
  await expect(
    form(page).getByLabel("グラデーションの終点の不透明度（%）", {
      exact: true,
    }),
  ).toHaveValue("40");
  const angle = form(page).getByLabel("グラデーションの角度", { exact: true });
  await angle.fill("0x10");
  await btn(page, "塗りと枠線を適用").click();
  await expect(node(page).locator("linearGradient")).toHaveCount(0);
  await expect(angle).toHaveValue("0x10");
  await angle.fill("90");
  await angle.dispatchEvent("compositionstart");
  await angle.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(node(page).locator("linearGradient")).toHaveCount(0);
  await angle.dispatchEvent("compositionend");
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("solid");
  await expect(form(page).getByLabel("塗りの色", { exact: true })).toHaveValue(
    "#123456",
  );
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("linearGradient");
  await expect(angle).toHaveValue("90");
  await btn(page, "塗りと枠線を適用").click();
  await form(page)
    .getByLabel("塗りの種類", { exact: true })
    .selectOption("solid");
  await expect(
    form(page).getByLabel("塗りの不透明度（%）", { exact: true }),
  ).toHaveValue("40");
  await btn(page, "塗りと枠線を適用").click();
  await expect(node(page).locator(":scope > rect")).toHaveAttribute(
    "fill",
    "#123456",
  );
});
test("repeated Symbol instances and minimap use unique gradient references and preserve monochrome stop alpha", async ({
  page,
}) => {
  const project: any = structuredClone(process),
    definition = project.symbols[0],
    first = project.screens[0].objects.find(
      (o: any) =>
        o.shape.type === "symbol" && o.shape.symbolId === definition.id,
    );
  const old = definition.objects[0];
  definition.objects = [
    {
      id: old.id,
      x: 0,
      y: 0,
      rotation: 0,
      width: definition.width,
      height: definition.height,
      order: old.order,
      shape: {
        type: "rectangle",
        paint: {
          fill: {
            enabled: true,
            paint: {
              type: "linearGradient",
              angle: 45,
              start: { color: "#ee8800", alpha: 0.25 },
              end: { color: "#2266cc", alpha: 0.8 },
            },
          },
          stroke: null,
        },
      },
    },
  ];
  const second = {
    ...first,
    id: "0199f111-0000-7000-8000-000000000001",
    x: first.x + 180,
    order: Math.max(...project.screens[0].objects.map((o: any) => o.order)) + 1,
    shape: { ...first.shape, colorMode: "definition" },
  };
  project.screens[0].objects.push(second);
  first.shape.colorMode = "monochrome";
  first.colorAlpha = 0.4;
  first.opacity = 0.5;
  await start(page, project, first.id);
  await expect(node(page, first.id)).toHaveAttribute("opacity", "0.2");
  await expect(node(page, first.id).locator("stop").first()).toHaveAttribute(
    "stop-color",
    first.fill,
  );
  await expect(node(page, first.id).locator("stop").last()).toHaveAttribute(
    "stop-opacity",
    "0.8",
  );
  await expect(node(page, second.id).locator("stop").first()).toHaveAttribute(
    "stop-color",
    "#ee8800",
  );
  const gradients = page.locator("linearGradient");
  expect(await gradients.count()).toBeGreaterThan(3);
  const ids = await gradients.evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  const refs = await page
    .locator('rect[fill^="url(#"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("fill")!.slice(5, -1)),
    );
  expect(refs.every((id) => ids.includes(id))).toBe(true);
});
test("enabled gradient explains why bulk RGB is unavailable", async ({
  page,
}) => {
  await start(page);
  await setGradient(page);
  await row(page, sample.screens[0].objects[1].id).click({
    modifiers: ["Shift"],
  });
  const colors = page.getByRole("form", {
    name: "選択した配置の色",
    exact: true,
  });
  await expect(colors).toContainText("グラデーション");
  await expect(colors.getByLabel("適用する色", { exact: true })).toBeDisabled();
});
