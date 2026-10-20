import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const id = sample.screens[0].objects[2].id;
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page) => page.locator(`button[data-layer-id="${id}"]`);
const textBox = (page: Page) =>
  page.locator(`.sheet > svg [data-object-id="${id}"] svg[data-text-layout]`);
async function start(page: Page, project: any = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "text.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await row(page).click();
  await expect(textBox(page)).not.toHaveAttribute(
    "data-text-layout",
    "pending",
  );
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
async function numeric(page: Page, name: string, value: string) {
  await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByLabel(name, { exact: true }).press("Enter");
}
for (const theme of ["light", "dark"])
  test(`independent text size, weight and alignment persist through undo and preview in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.getByLabel("テキスト", { exact: true }).fill("原水ポンプ A");
    await page.getByLabel("文字の太さ", { exact: true }).selectOption("bold");
    await page.getByLabel("文字揃え", { exact: true }).selectOption("center");
    await numeric(page, "文字サイズ", "24");
    await button(page, "変更を適用").click();
    const painted = textBox(page).locator("[data-text-content]");
    await expect(painted).toHaveText("原水ポンプ A");
    await expect(painted).toHaveAttribute("font-size", "24");
    await expect(painted).toHaveAttribute("font-weight", "bold");
    const centered = await painted.evaluate((el) => {
      const b = (el as SVGGraphicsElement).getBBox();
      return b.x + b.width / 2;
    });
    expect(centered).toBeCloseTo(sample.screens[0].objects[2].width! / 2, 1);
    const before = await saved(page);
    await numeric(page, "height", "80");
    await expect(painted).toHaveAttribute("font-size", "24");
    await button(page, "元に戻す").click();
    expect((await saved(page)).screens).toEqual(before.screens);
    await button(page, "元に戻す").click();
    await expect(page.getByLabel("文字の太さ", { exact: true })).toHaveValue(
      "normal",
    );
    await button(page, "やり直す").click();
    await button(page, "表示プレビュー").click();
    await expect(painted).toHaveText("原水ポンプ A");
    expect((await saved(page)).screens).toEqual(before.screens);
  });
test("static overflow uses grapheme ellipsis, ink stays inside the declared frame and full text is accessible", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects[2];
  object.width = 90;
  object.shape.text = "設備👨‍👩‍👧‍👦・原水移送ポンプ";
  object.shape.style = { fontSize: 20, fontWeight: "bold", align: "right" };
  await start(page, project);
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "ellipsis");
  const painted = textBox(page).locator("[data-text-content]");
  await expect(painted).toHaveText(/…$/);
  await expect(textBox(page)).toHaveAttribute(
    "aria-label",
    new RegExp(object.shape.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const bounds = await painted.evaluate((el) => {
    const b = (el as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height };
  });
  expect(bounds.x).toBeGreaterThanOrEqual(1.99);
  expect(bounds.right).toBeLessThanOrEqual(88.01);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(object.height);
  await expect(
    page.locator(`.sheet > svg [data-object-id="${id}"] > title`),
  ).toContainText(object.shape.text);
  expect((await saved(page)).screens).toEqual(project.screens);
  await numeric(page, "width", "700");
  await expect(painted).toHaveText(object.shape.text);
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "full");
});
test("numeric status is preserved and overflow never paints a shortened value or partial status", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects[2];
  object.width = 65;
  object.shape.style.fontSize = 24;
  object.shape.binding = { externalName: "PLC01.Fast.Value" };
  await start(page, project);
  await expect(textBox(page)).toHaveAttribute("data-tag-state", "disconnected");
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "overflow");
  await expect(textBox(page).locator("[data-text-content]")).toHaveText("###");
  await expect(textBox(page)).toHaveAttribute(
    "aria-label",
    /表示枠に収まりません.*未接続/,
  );
  await numeric(page, "width", "5");
  await expect(textBox(page).locator("[data-text-content]")).toHaveCount(0);
  await expect(textBox(page).locator("path")).toHaveCount(2);
  await numeric(page, "width", "300");
  await expect(textBox(page).locator("[data-text-content]")).toHaveText(
    "-- · 未接続",
  );
  await expect(textBox(page)).toHaveAttribute("data-tag-state", "disconnected");
});
test("short height and empty text have explicit distinct behavior; resizing never shrinks the font", async ({
  page,
}) => {
  await start(page);
  await numeric(page, "height", "10");
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "overflow");
  await expect(textBox(page).locator("[data-text-content]")).toHaveCount(0);
  await page.getByLabel("テキスト", { exact: true }).fill("");
  await button(page, "変更を適用").click();
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "full");
  await expect(textBox(page).locator("path")).toHaveCount(0);
  expect((await saved(page)).screens[0].objects[2].shape.style.fontSize).toBe(
    28,
  );
});
test("invalid size, IME, staged formatting and multiline paste use existing input protection", async ({
  page,
}) => {
  await start(page);
  const size = page.getByLabel("文字サイズ", { exact: true });
  await size.fill("0");
  await size.press("Enter");
  await expect(size).toHaveAttribute("aria-invalid", "true");
  await size.press("Escape");
  await expect(size).toHaveValue("28");
  await size.fill("25");
  await size.dispatchEvent("compositionstart");
  await size.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(button(page, "元に戻す")).toBeDisabled();
  await size.dispatchEvent("compositionend");
  await size.press("Enter");
  await expect(textBox(page).locator("[data-text-content]")).toHaveAttribute(
    "font-size",
    "25",
  );
  const text = page.getByLabel("テキスト", { exact: true });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("first\nsecond"));
  await text.focus();
  await text.press("Control+a");
  await text.press("Control+v");
  await expect(text).toHaveValue("first\nsecond");
  await expect(textBox(page).locator("[data-text-content]")).toHaveText(
    sample.screens[0].objects[2].shape.text!,
  );
  await page.getByLabel("文字の太さ", { exact: true }).selectOption("bold");
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[0].id}"]`)
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("文字の太さ", { exact: true })).toHaveValue(
    "bold",
  );
});
test("rotated text and shared definitions use the same layout without zoom-dependent remeasurement", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects[2];
  object.rotation = 33;
  object.shape.style = { fontSize: 18, fontWeight: "bold", align: "center" };
  const symbolId = "0199fc00-0000-7000-8000-000000000020";
  project.symbols = [
    {
      id: symbolId,
      name: "Text symbol",
      width: 300,
      height: 100,
      folders: [],
      objects: [
        {
          ...structuredClone(object),
          id: "0199fc00-0000-7000-8000-000000000021",
          x: 0,
          y: 0,
          width: 250,
          rotation: 0,
        },
      ],
    },
  ];
  project.screens[0].objects.push({
    id: "0199fc00-0000-7000-8000-000000000022",
    x: 400,
    y: 300,
    width: 300,
    height: 100,
    rotation: 90,
    fill: "#2563eb",
    order: 8,
    shape: { type: "symbol", symbolId, colorMode: "definition" },
  });
  await start(page, project);
  await expect(
    page.locator('.sheet > svg [data-text-layout="full"]'),
  ).toHaveCount(2);
  const before = await textBox(page)
    .locator("[data-text-content]")
    .getAttribute("x");
  await page.evaluate(() => {
    (window as any).__textMeasures = 0;
    const original = SVGGraphicsElement.prototype.getBBox;
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      (window as any).__textMeasures++;
      return original.apply(this, args);
    };
  });
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  await expect(textBox(page).locator("[data-text-content]")).toHaveAttribute(
    "x",
    before!,
  );
  expect(await page.evaluate(() => (window as any).__textMeasures)).toBe(0);
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[0].id}"]`)
    .click();
  await numeric(page, "x", "120");
  expect(await page.evaluate(() => (window as any).__textMeasures)).toBe(0);
});

test("text symbol thumbnails recover from a failed hidden measurement when the parts panel is revealed", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    text = structuredClone(project.screens[0].objects[2]);
  text.x = 0;
  text.y = 0;
  text.shape.style.fontSize = 18;
  project.symbols = [
    {
      id: "0199fc00-0000-7000-8000-000000000030",
      name: "Text thumbnail",
      width: 300,
      height: 100,
      folders: [],
      objects: [{ ...text, id: "0199fc00-0000-7000-8000-000000000031" }],
    },
  ];
  await page.goto("/");
  await page.evaluate(() => {
    const original = SVGGraphicsElement.prototype.getBBox;
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      if (this.closest("[hidden]"))
        throw new Error("Hidden SVG measurement unavailable");
      return original.apply(this, args);
    };
  });
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "thumbnail.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  const category = page.locator('button[aria-controls="palette-symbols"]');
  if ((await category.getAttribute("aria-expanded")) === "true")
    await category.click();
  const thumbnail = page
    .getByRole("region", { name: "部品パレット" })
    .locator("#palette-symbols [data-text-layout]");
  await expect(thumbnail).toHaveCount(1);
  await category.click();
  await expect(thumbnail).toHaveAttribute("data-text-layout", "full");
  await expect(thumbnail.locator("[data-text-content]")).toHaveText(
    text.shape.text,
  );
});

test("font completion and font failure remeasure without saving a layout result", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects[2];
  object.width = 140;
  object.shape.text = "ABC123";
  object.shape.style.fontSize = 20;
  await start(page, project);
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "full");
  await page.evaluate(() => {
    const original = SVGGraphicsElement.prototype.getBBox;
    (window as any).__textScale = 3;
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      const box = original.apply(this, args);
      if (this.tagName === "text")
        return new DOMRect(
          box.x,
          box.y,
          box.width * (window as any).__textScale,
          box.height,
        );
      return box;
    };
    document.fonts.dispatchEvent(new Event("loadingdone"));
  });
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "ellipsis");
  await page.evaluate(() => {
    (window as any).__textScale = 1;
    document.fonts.dispatchEvent(new Event("loadingerror"));
  });
  await expect(textBox(page)).toHaveAttribute("data-text-layout", "full");
  expect((await saved(page)).screens).toEqual(project.screens);
});
