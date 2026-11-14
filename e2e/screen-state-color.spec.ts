import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { mainCanvas, selectPanel } from "./helpers/designer";

/** Same test-only read source as screen-bool-display.spec.ts. */
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

/** The tag is a bit: the Text reads it as bool; a number slot on it is a type mismatch. */
async function sendBit(
  page: Page,
  sequence: number,
  reading:
    | { quality: "good"; boolValue: boolean }
    | { quality: "stale" | "bad" }
    | { quality: "good"; numericValue: number },
) {
  const update = structuredClone(
    fixtures.find((fixture) => fixture.name === "good")!.update,
  ) as any;
  update.sequence = sequence;
  // One applied edit raised the Project revision from 1 to 2.
  update.text.projectRevision = 2;
  update.slots.projectRevision = 2;
  update.text.readings["Demo.Number"] = {
    state: "resolved",
    numericValue: null,
    ...reading,
  };
  for (const row of update.slots.slots)
    if (row.externalName === "Demo.Number") {
      if ("numericValue" in reading)
        row.reading.value = { type: "number", value: reading.numericValue };
      else {
        row.reading = { state: "invalid", reason: "typeMismatch" };
        row.provenance = null;
      }
    }
  return page.evaluate(
    (update) => (window as any).__readHarness.delivery.receive(update),
    update,
  );
}

const display = {
  true: { text: "運転", color: "#16a34a" },
  false: { text: "停止", color: "#64748b" },
  unknownColor: "#d97706",
};
const RECT = "0199f600-0000-7000-8000-000000000c01";
const PIPE = "0199f600-0000-7000-8000-000000000c02";
const source = sample.screens[0].objects[6];
const solid = {
  fill: {
    enabled: true,
    paint: { type: "solid", color: "#abcdef", alpha: 1 },
  },
  stroke: { color: "#112233", width: 2, alpha: 1 },
};

/** The tagged Text gets a bool display; the rectangle already follows it, the pipe does not yet. */
function project() {
  const value = structuredClone(sample) as any;
  const screen = value.screens[0];
  screen.objects[6].shape.boolDisplay = display;
  screen.objects.push(
    {
      id: RECT,
      order: 60,
      x: 450,
      y: 100,
      width: 120,
      height: 40,
      rotation: 0,
      shape: {
        type: "rectangle",
        paint: solid,
        stateColor: { textId: source.id },
      },
    },
    {
      id: PIPE,
      order: 61,
      x: 0,
      y: 0,
      rotation: 0,
      fill: "#83bfcd",
      shape: {
        type: "polyline",
        points: [
          { x: 450, y: 200 },
          { x: 700, y: 200 },
        ],
        strokeWidth: 8,
        arrow: "none",
      },
    },
  );
  return value;
}

test("a screen pipe and rectangle follow the bool display of a Text on the same screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixtureEntry(page);
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "screen-state-color.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project())),
  });
  await selectPanel(page, "レイヤー");
  // The source Text shows its follower count.
  await page.locator(`button[data-layer-id="${source.id}"]`).click();
  await expect(
    page.getByText("状態色の追従先 1件。", { exact: false }),
  ).toBeVisible();
  // The pipe follows after choosing the source in the Inspector.
  await page.locator(`button[data-layer-id="${PIPE}"]`).click();
  const form = page.getByRole("form", {
    name: "状態表示の色に追従",
    exact: true,
  });
  await form.getByLabel("配色元Text", { exact: true }).selectOption(source.id);
  await form
    .getByRole("button", { name: "状態色の追従を適用", exact: true })
    .click();
  await page.locator(`button[data-layer-id="${source.id}"]`).click();
  await expect(
    page.getByText("状態色の追従先 2件。", { exact: false }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const pipe = mainCanvas(page).locator(
    `[data-object-id="${PIPE}"] polyline:not([stroke="transparent"])`,
  );
  const rect = mainCanvas(page)
    .locator(`[data-object-id="${RECT}"] rect`)
    .first();
  const check = async (color: string) => {
    await expect(pipe).toHaveAttribute("stroke", color);
    await expect(rect).toHaveAttribute("fill", color);
  };
  expect(await sendBit(page, 1, { quality: "good", boolValue: true })).toBe(
    true,
  );
  await check("#16a34a");
  expect(await sendBit(page, 2, { quality: "good", boolValue: false })).toBe(
    true,
  );
  await check("#64748b");
  expect(await sendBit(page, 3, { quality: "bad" })).toBe(true);
  await check("#d97706");
  expect(await sendBit(page, 4, { quality: "good", boolValue: true })).toBe(
    true,
  );
  await check("#16a34a");
  expect(await sendBit(page, 5, { quality: "good", numericValue: 3 })).toBe(
    true,
  );
  await check("#d97706");
});

test("the source Text of a screen follower cannot be deleted while it is followed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "screen-state-color-protect.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project())),
  });
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${source.id}"]`).click();
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("alert").getByText("配色元Text", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(`button[data-layer-id="${source.id}"]`),
  ).toHaveCount(1);
});
