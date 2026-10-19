import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const ids = sample.screens[0].objects.map((o) => o.id);
const lineId = "0199fd00-0000-7000-8000-000000000001";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id = ids[0]) =>
  page.locator(`button[data-layer-id="${id}"]`);
const angle = (page: Page) => page.getByLabel("回転角度", { exact: true });
const svg = (page: Page) => page.locator(".sheet > svg");
const object = (page: Page, id = ids[0]) =>
  svg(page).locator(`[data-object-id="${id}"]`);
function fixture(): any {
  const project: any = structuredClone(sample),
    owner = project.screens[0];
  owner.background = "#ffffff";
  Object.assign(owner.objects[0], {
    x: 300,
    y: 200,
    width: 160,
    height: 80,
    rotation: 33,
  });
  owner.objects[0].shape.paint.stroke = { color: "#334155", width: 6 };
  owner.objects[1].rotation = 90;
  owner.objects[2].rotation = 270;
  owner.objects.push({
    id: lineId,
    order: 6,
    x: 300,
    y: 100,
    rotation: 33,
    fill: "#2563eb",
    shape: {
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 60, y: 30 },
        { x: 120, y: 0 },
      ],
      strokeWidth: 8,
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
    name: "rotation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await row(page, project.screens[0].objects[0].id).click();
  return project;
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
const handle = (page: Page, name: string) =>
  svg(page).locator(`[data-resize-handle="${name}"]`);
async function center(locator: ReturnType<typeof handle>) {
  const b = (await locator.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function resize(
  page: Page,
  name: string,
  dx: number,
  dy: number,
  cancel = false,
) {
  const p = await center(handle(page, name)),
    scale = await svg(page).evaluate(
      (el) => (el as SVGSVGElement).getScreenCTM()!.a,
    );
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx * scale, p.y + dy * scale, { steps: 5 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
for (const theme of ["light", "dark"] as const)
  test(`angle edits normalize, keep geometry, rotate all displays and undo in ${theme}`, async ({
    page,
  }) => {
    const before = await start(page);
    await chooseTheme(page, theme);
    await expect(
      object(page).locator("[data-object-rotation]"),
    ).toHaveAttribute("transform", "rotate(33 80 40)");
    await angle(page).fill("450");
    await angle(page).press("Enter");
    await expect(angle(page)).toHaveValue("90");
    await expect(
      object(page).locator("[data-object-rotation]"),
    ).toHaveAttribute("transform", "rotate(90 80 40)");
    await expect(
      page.locator(
        `.minimap [data-object-id="${ids[0]}"] [data-object-rotation]`,
      ),
    ).toHaveAttribute("transform", "rotate(90 80 40)");
    const result = await saved(page);
    expect(result.screens[0].objects[0]).toEqual({
      ...before.screens[0].objects[0],
      rotation: 90,
    });
    await angle(page).fill("-270");
    await angle(page).press("Enter");
    expect((await saved(page)).manifest.projectRevision).toBe(
      result.manifest.projectRevision,
    );
    await button(page, "元に戻す").click();
    await expect(angle(page)).toHaveValue("33");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
    await button(page, "表示プレビュー").click();
    await expect(
      object(page).locator("[data-object-rotation]"),
    ).toHaveAttribute("transform", "rotate(90 80 40)");
    await expect(svg(page).locator("[data-resize-handle]")).toHaveCount(0);
  });
test("four toolbar turns preserve origin and dimensions; blur normalizes and invalid angles stay protected", async ({
  page,
}) => {
  const before = await start(page);
  for (let i = 0; i < 4; i++) await button(page, "右へ90°回転").click();
  expect((await saved(page)).screens).toEqual(before.screens);
  await angle(page).fill("-90");
  await page.getByLabel("配置名", { exact: true }).focus();
  await expect(angle(page)).toHaveValue("270");
  await angle(page).fill("1e");
  await angle(page).press("Enter");
  await expect(angle(page)).toHaveAttribute("aria-invalid", "true");
  await button(page, "左へ90°回転").click();
  const guard = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await guard
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(angle(page)).toHaveValue("1e");
  await expect(object(page).locator("[data-object-rotation]")).toHaveAttribute(
    "transform",
    "rotate(270 80 40)",
  );
  await angle(page).press("Escape");
  await expect(angle(page)).toHaveValue("270");
});
test("rotated corner and edge resizing keep the opposite handle fixed, support snap and cancel", async ({
  page,
}) => {
  await start(page);
  let opposite = await center(handle(page, "nw"));
  await resize(page, "se", 25, 30);
  let after = await center(handle(page, "nw"));
  expect(after.x).toBeCloseTo(opposite.x, 6);
  expect(after.y).toBeCloseTo(opposite.y, 6);
  const result = await saved(page);
  expect(result.screens[0].objects[0].rotation).toBe(33);
  expect(result.screens[0].objects[0].width).not.toBe(160);
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  opposite = await center(handle(page, "w"));
  await resize(page, "e", 15, 20);
  after = await center(handle(page, "w"));
  expect(after.x).toBeCloseTo(opposite.x, 6);
  expect(after.y).toBeCloseTo(opposite.y, 6);
  const prior = await saved(page);
  await resize(page, "nw", 30, -40, true);
  expect((await saved(page)).screens).toEqual(prior.screens);
});
test("rotated edge keyboard moves along its normal; a perpendicular key is a no-op", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].rotation = 90;
  await start(page, project);
  const opposite = await center(handle(page, "w"));
  await handle(page, "e").focus();
  await page.keyboard.press("ArrowRight");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("161");
  const after = await center(handle(page, "w"));
  expect(after.x).toBeCloseTo(opposite.x, 6);
  expect(after.y).toBeCloseTo(opposite.y, 6);
});
test("rotated polyline pointer and keyboard edits keep unedited vertices fixed and share Undo", async ({
  page,
}) => {
  await start(page);
  await row(page, lineId).click();
  const vertices = svg(page).locator(".vertex"),
    first = await center(vertices.nth(0)),
    others = [await center(vertices.nth(1)), await center(vertices.nth(2))];
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(first.x - 40, first.y + 30, { steps: 5 });
  await page.mouse.up();
  for (let i = 0; i < 2; i++) {
    const p = await center(vertices.nth(i + 1));
    expect(p.x).toBeCloseTo(others[i].x, 6);
    expect(p.y).toBeCloseTo(others[i].y, 6);
  }
  await vertices.nth(0).focus();
  const before = await center(vertices.nth(0));
  await page.keyboard.press("ArrowRight");
  const after = await center(vertices.nth(0));
  const scale = await svg(page).evaluate(
    (el) => (el as SVGSVGElement).getScreenCTM()!.a,
  );
  expect(after.x - before.x).toBeCloseTo(scale, 3);
  expect(after.y).toBeCloseTo(before.y, 6);
  await button(page, "元に戻す").click();
  await button(page, "元に戻す").click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  const result = await saved(page);
  expect(result.screens[0].objects.find((o: any) => o.id === lineId)).toEqual(
    fixture().screens[0].objects[3],
  );
});
test("rotation survives duplicate and JSON roundtrip; locked objects cannot rotate while hidden ones can", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[1].locked = true;
  project.screens[0].objects[2].visible = false;
  await start(page, project);
  await button(page, "選択図形を複製").click();
  const result = await saved(page);
  expect(result.screens[0].objects.at(-1).rotation).toBe(33);
  await row(page, ids[1]).click();
  await expect(angle(page)).toBeDisabled();
  await expect(button(page, "右へ90°回転")).toBeDisabled();
  await row(page, ids[2]).click();
  await button(page, "右へ90°回転").click();
  const updated = await saved(page);
  expect(updated.screens[0].objects[2]).toMatchObject({
    rotation: 0,
    visible: false,
  });
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "roundtrip.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(updated)),
  });
  expect((await saved(page)).screens).toEqual(updated.screens);
});
test("non-square symbol rotation and child rotation compose without changing other placements", async ({
  page,
}) => {
  const project = JSON.parse(
    await readFile("examples/process-light.project.json", "utf8"),
  );
  const instance = project.screens[0].objects.find(
    (o: any) => o.shape.type === "symbol",
  );
  Object.assign(instance, { width: 180, height: 80, rotation: 90 });
  project.symbols[0].objects[0].rotation = 33;
  await start(page, project);
  await row(page, instance.id).click();
  await expect(
    object(page, instance.id).locator(":scope > [data-object-rotation]"),
  ).toHaveAttribute("transform", "rotate(90 90 40)");
  await expect(
    object(page, instance.id).locator("[data-symbol-id] > g").first(),
  ).toHaveAttribute("transform", /rotate\(33 /);
  await button(page, "参照する Symbol 定義を編集").click();
  await selectPanel(page, "レイヤー");
  const child = project.symbols[0].objects[0];
  await row(page, child.id).click();
  await angle(page).fill("67");
  await angle(page).press("Enter");
  const result = await saved(page);
  expect(result.screens).toEqual(project.screens);
  expect(result.symbols[0].objects[0].rotation).toBe(67);
});

test("rotated paint bounds drive range selection, alignment and selection view", async ({
  page,
}) => {
  await start(page);
  const selection = object(page).locator(
    ':scope > rect[pointer-events="none"]',
  );
  const box = (await selection.boundingBox())!;
  await button(page, "選択解除").click();
  await page.mouse.move(box.x - 5, box.y - 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 5, box.y + box.height + 5, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(row(page)).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, ids[1])).toHaveAttribute("aria-pressed", "false");
  await button(page, "選択範囲を表示").click();
  await expect(page.getByLabel("表示倍率", { exact: true })).not.toHaveValue(
    "",
  );
  await expect(object(page)).toBeInViewport();
  await row(page, ids[1]).click({ modifiers: ["Shift"] });
  await button(page, "左揃え").click();
  const first = object(page).locator(':scope > rect[pointer-events="none"]'),
    second = object(page, ids[1]).locator(
      ':scope > rect[pointer-events="none"]',
    );
  expect((await first.boundingBox())!.x).toBeCloseTo(
    (await second.boundingBox())!.x,
    3,
  );
  const result = await saved(page);
  expect(result.screens[0].objects[0].rotation).toBe(33);
  expect(result.screens[0].objects[1].rotation).toBe(90);
});
for (const theme of ["light", "dark"] as const)
  test(`narrow rotation controls remain usable and IME does not commit in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await angle(page).scrollIntoViewIfNeeded();
    await angle(page).fill("48");
    await angle(page).dispatchEvent("compositionstart");
    await angle(page).dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    await expect(button(page, "元に戻す")).toBeDisabled();
    await angle(page).dispatchEvent("compositionend");
    await angle(page).press("Enter");
    await expect(angle(page)).toHaveValue("48");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await button(page, "選択図形を複製").click();
    await expect(angle(page)).toHaveValue("48");
  });

test("the empty corner of a rotated outline does not block the placement behind it", async ({
  page,
}) => {
  const project = fixture();
  Object.assign(project.screens[0].objects[0], {
    x: 300,
    y: 200,
    width: 240,
    height: 20,
    rotation: 45,
    order: 10,
  });
  Object.assign(project.screens[0].objects[1], {
    x: 490,
    y: 120,
    width: 30,
    height: 30,
    rotation: 0,
  });
  project.screens[0].objects[2].visible = false;
  await start(page, project);
  const point = async (x: number, y: number) =>
    svg(page).evaluate(
      (el, p) => {
        const world = new DOMPoint(p.x, p.y).matrixTransform(
          (el as SVGSVGElement).getScreenCTM()!,
        );
        return { x: world.x, y: world.y };
      },
      { x, y },
    );
  const corner = await point(505, 135);
  await page.mouse.click(corner.x, corner.y);
  await expect(row(page, ids[1])).toHaveAttribute("aria-pressed", "true");
  const body = await point(420, 210);
  await page.mouse.click(body.x, body.y);
  await expect(row(page)).toHaveAttribute("aria-pressed", "true");
  const selection = object(page).locator(
    ':scope > rect[pointer-events="none"]',
  );
  expect(Number(await selection.getAttribute("width"))).toBeGreaterThan(180);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("single-selection context rotation uses the same command and preserves the shared selection menu groups", async ({
  page,
}) => {
  await start(page);
  await row(page).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "右へ90°回転", exact: true })
    .click();
  await expect(angle(page)).toHaveValue("123");
  await row(page, ids[1]).click({ modifiers: ["Shift"] });
  await row(page, ids[2]).click({ modifiers: ["Shift"] });
  await row(page).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "中心を垂直方向に等間隔", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "右へ90°回転", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
});
