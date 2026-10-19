import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel } from "./helpers/designer";
const lineId = "0199fc00-0000-7000-8000-000000000001";
const rectangleId = sample.screens[0].objects[0].id;
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page) => page.locator(".sheet > svg");
type Interaction = "move" | "resize" | "vertex";
function fixture(): any {
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].rotation = 33;
  project.screens[0].objects.push({
    id: lineId,
    order: 6,
    x: 400,
    y: 350,
    rotation: 33,
    fill: "#2563eb",
    shape: {
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      strokeWidth: 4,
      arrow: "end",
    },
  });
  return project;
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "interaction.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture())),
  });
  await selectPanel(page, "レイヤー");
  await row(page, rectangleId).click();
  await page.getByLabel("x", { exact: true }).fill("120");
  await page.getByLabel("x", { exact: true }).press("Enter");
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
async function begin(page: Page, interaction: Interaction) {
  await row(page, interaction === "vertex" ? lineId : rectangleId).click();
  await viewport(page).focus();
  let source: Locator;
  if (interaction === "move")
    source = svg(page)
      .locator(
        `[data-object-id="${rectangleId}"] > [data-object-rotation] rect`,
      )
      .first();
  else if (interaction === "resize")
    source = svg(page).locator('[data-resize-handle="se"]');
  else source = svg(page).locator(".vertex").first();
  const box = (await source.boundingBox())!,
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 35, point.y + 25, { steps: 5 });
}
for (const interaction of ["move", "resize", "vertex"] as const) {
  test(`${interaction} cancels after Undo changes the owner snapshot`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await begin(page, interaction);
    await page.keyboard.press("Control+z");
    await page.mouse.up();
    expect((await saved(page)).screens).toEqual(fixture().screens);
    await expect(button(page, "元に戻す")).toBeDisabled();
    expect(errors).toEqual([]);
  });
  test(`${interaction} cancels after Redo changes the owner snapshot`, async ({
    page,
  }) => {
    await start(page);
    await viewport(page).focus();
    await page.keyboard.press("Control+z");
    await begin(page, interaction);
    await page.keyboard.press("Control+Shift+z");
    await page.mouse.up();
    const expected = fixture();
    expected.screens[0].objects[0].x = 120;
    expect((await saved(page)).screens).toEqual(expected.screens);
    await button(page, "元に戻す").click();
    expect((await saved(page)).screens).toEqual(fixture().screens);
    await expect(button(page, "元に戻す")).toBeDisabled();
  });
  test(`${interaction} pointerup after deletion cannot edit a missing target or raise an exception`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await begin(page, interaction);
    await page.keyboard.press("Delete");
    await page.mouse.up();
    const result = await saved(page),
      removed = interaction === "vertex" ? lineId : rectangleId;
    expect(result.screens[0].objects.some((o: any) => o.id === removed)).toBe(
      false,
    );
    expect(errors).toEqual([]);
    await button(page, "元に戻す").click();
    const expected = fixture();
    expected.screens[0].objects[0].x = 120;
    expect((await saved(page)).screens).toEqual(expected.screens);
  });
  test(`${interaction} cancels safely when switching to preview with the pointer held`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await begin(page, interaction);
    await button(page, "表示プレビュー").focus();
    await page.keyboard.press("Enter");
    await page.mouse.up();
    const expected = fixture();
    expected.screens[0].objects[0].x = 120;
    expect((await saved(page)).screens).toEqual(expected.screens);
    expect(errors).toEqual([]);
  });
}

for (const interaction of ["move", "resize", "vertex"] as const)
  test(`${interaction} keeps a drag that starts immediately after synchronously committing a numeric draft`, async ({
    page,
  }) => {
    await start(page);
    const id = interaction === "vertex" ? lineId : rectangleId;
    await row(page, id).click();
    const field = interaction === "resize" ? "width" : "x",
      value =
        interaction === "vertex"
          ? "420"
          : interaction === "resize"
            ? "300"
            : "140";
    await page.getByLabel(field, { exact: true }).fill(value);
    const source =
      interaction === "move"
        ? svg(page)
            .locator(
              `[data-object-id="${rectangleId}"] > [data-object-rotation] rect`,
            )
            .first()
        : interaction === "resize"
          ? svg(page).locator('[data-resize-handle="se"]')
          : svg(page).locator(".vertex").first();
    const box = (await source.boundingBox())!,
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 35, point.y + 25, { steps: 5 });
    await page.mouse.up();
    const changed = await saved(page),
      object = changed.screens[0].objects.find((o: any) => o.id === id);
    if (interaction === "move") expect(object.x).toBeGreaterThan(140);
    else if (interaction === "resize") expect(object.width).not.toBe(300);
    else
      expect(object.shape.points).not.toEqual(
        fixture().screens[0].objects.at(-1).shape.points,
      );
    await button(page, "元に戻す").click();
    const result = await saved(page),
      after = result.screens[0].objects.find((o: any) => o.id === id);
    expect(after[field]).toBe(Number(value));
    const original = fixture().screens[0].objects.find((o: any) => o.id === id);
    expect(after).toEqual({
      ...original,
      x: interaction === "vertex" ? 420 : interaction === "move" ? 140 : 120,
      ...(interaction === "resize" ? { width: 300 } : {}),
    });
  });
