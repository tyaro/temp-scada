import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

/** Same test-only read source as level.spec.ts. */
async function fixtureEntry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /if \("__TAURI_INTERNALS__" in window\) \{[\s\S]*?\} else \{\s*mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);\s*\}/;
    expect(original).toMatch(mount);
    const injected = `
      import { createSubscriber } from "/node_modules/.vite/deps/svelte_reactivity.js";
      const trackSource = createSubscriber(() => () => {});
      const h = window.__readHarness = {};
      const source = {subscribe(project, begin) {
        h.delivery = begin();
        return () => {};
      }};
      mount(App, {target: document.getElementById("app"), props: {get readSource() {trackSource(); return source;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}

const rectangleId = "0199f6aa-0000-7000-8000-000000000a01";
const symbolId = sample.screens[0].objects[0].id;
const textId = sample.screens[0].objects[1].id;
const slotTextId = "0199f600-0000-7000-8000-000000000002";
function flipProject() {
  const project = structuredClone(sample) as any;
  project.screens[0].objects.push({
    id: rectangleId,
    order: 900,
    x: 20,
    y: 20,
    width: 160,
    height: 80,
    rotation: 0,
    shape: {
      type: "rectangle",
      paint: {
        stroke: { color: "#334155", width: 4 },
        fill: {
          enabled: true,
          paint: { type: "solid", color: "#164e63", alpha: 1 },
        },
      },
    },
  });
  return project;
}
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
/** Flip lives in the edit menu and the context menu, not the toolbar. */
const editMenu = async (page: Page, name: string) => {
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  return page.getByRole("menuitem", { name, exact: true });
};
const placement = (page: Page, id: string) =>
  mainCanvas(page).locator(`[data-object-id="${id}"]`);
const painted = (page: Page, id: string) =>
  placement(page, id).locator(":scope > [data-object-rotation]");
const outline = (page: Page, id: string) =>
  placement(page, id).locator('rect[stroke="var(--canvas-accent)"]');
async function frame(page: Page, id: string) {
  return outline(page, id).evaluate((rect) =>
    ["x", "y", "width", "height"].map((key) => rect.getAttribute(key)),
  );
}
/** Glyph orientation on screen: a positive determinant and diagonal is unmirrored. */
async function textMatrix(page: Page) {
  return placement(page, symbolId)
    .locator(`[data-symbol-child-id="${slotTextId}"] text`)
    .first()
    .evaluate((text) => {
      const m = (text as SVGGraphicsElement).getScreenCTM()!;
      return { a: m.a, d: m.d, det: m.a * m.d - m.b * m.c };
    });
}

test("flipping mirrors a rectangle and a Symbol in place, keeps Symbol Text readable and undoes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixtureEntry(page);
  await page.goto("/");
  await button(page, "編集").click();
  await openProject(page, {
    name: "flip.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(flipProject())),
  });
  await selectPanel(page, "レイヤー");

  // Text cannot be mirrored.
  await page.locator(`button[data-layer-id="${textId}"]`).click();
  await expect(await editMenu(page, "左右反転")).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "上下反転", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("toolbar").getByRole("button", { name: "左右反転" }),
  ).toHaveCount(0);

  await page.locator(`button[data-layer-id="${rectangleId}"]`).click();
  const before = await frame(page, rectangleId);
  await expect(painted(page, rectangleId)).not.toHaveAttribute(
    "transform",
    /./,
  );
  await (await editMenu(page, "左右反転")).click();
  await expect(painted(page, rectangleId)).toHaveAttribute(
    "transform",
    "matrix(-1 0 0 1 160 0)",
  );
  await expect(painted(page, rectangleId)).toHaveAttribute(
    "data-object-flip",
    "x",
  );
  expect(await frame(page, rectangleId)).toEqual(before);
  const toggle = (key: string) => page.locator(`[data-flip-toggle="${key}"]`);
  await expect(toggle("flipX")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle("flipY")).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Control+z");
  await expect(painted(page, rectangleId)).not.toHaveAttribute(
    "transform",
    /./,
  );
  await expect(toggle("flipX")).toHaveAttribute("aria-pressed", "false");
  // The Inspector toggle edits the saved axis and keeps the angle.
  await toggle("flipY").click();
  await expect(painted(page, rectangleId)).toHaveAttribute(
    "transform",
    "matrix(1 0 0 -1 0 80)",
  );
  await page.keyboard.press("Control+z");
  await expect(toggle("flipY")).toHaveAttribute("aria-pressed", "false");

  await page.locator(`button[data-layer-id="${symbolId}"]`).click();
  const symbolBefore = await frame(page, symbolId);
  await (await editMenu(page, "上下反転")).click();
  await expect(painted(page, symbolId)).toHaveAttribute(
    "transform",
    "matrix(1 0 0 -1 0 180)",
  );
  expect(await frame(page, symbolId)).toEqual(symbolBefore);
  // Text inside the mirrored Symbol is mirrored back around its own body center.
  await expect(
    placement(page, symbolId).locator(`[data-symbol-child-id="${slotTextId}"]`),
  ).toHaveAttribute("transform", "translate(0 135) matrix(1 0 0 -1 0 30)");
  const editing = await textMatrix(page);
  expect(editing.det).toBeGreaterThan(0);
  expect(editing.d).toBeGreaterThan(0);

  await page.keyboard.press("Control+z");
  await expect(painted(page, symbolId)).not.toHaveAttribute("transform", /./);

  // The readable orientation also holds while live values are shown.
  const flipped = flipProject();
  flipped.screens[0].objects[0].flipY = true;
  await openProject(page, {
    name: "flipped.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(flipped)),
  });
  await button(page, "表示プレビュー").click();
  const update = structuredClone(
    fixtures.find((fixture) => fixture.name === "good")!.update,
  ) as any;
  update.sequence = 1;
  expect(
    await page.evaluate(
      (update) => (window as any).__readHarness.delivery.receive(update),
      update,
    ),
  ).toBe(true);
  await expect(painted(page, symbolId)).toHaveAttribute(
    "transform",
    "matrix(1 0 0 -1 0 180)",
  );
  const preview = await textMatrix(page);
  expect(preview.det).toBeGreaterThan(0);
  expect(preview.d).toBeGreaterThan(0);
});
