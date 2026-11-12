import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { chooseTheme, mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

/** Same test-only read source as numeric-format.spec.ts. */
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

/** A fixture update; a Good value replaces the tag and its slot together. */
async function send(
  page: Page,
  sequence: number,
  name: "good" | "stale",
  numericValue?: number,
) {
  const update = structuredClone(
    fixtures.find((fixture) => fixture.name === name)!.update,
  ) as any;
  update.sequence = sequence;
  if (numericValue !== undefined) {
    update.text.readings["Demo.Number"].numericValue = numericValue;
    for (const row of update.slots.slots)
      if (row.externalName === "Demo.Number")
        row.reading.value = { type: "number", value: numericValue };
  }
  return page.evaluate(
    (update) => (window as any).__readHarness.delivery.receive(update),
    update,
  );
}

const screenLevelId = "0199f6aa-0000-7000-8000-000000000801";
const symbolLevelId = "0199f6aa-0000-7000-8000-000000000802";
function levelProject() {
  const project = structuredClone(sample) as any;
  project.screens[0].objects.push({
    id: screenLevelId,
    order: 900,
    x: 600,
    y: 40,
    width: 40,
    height: 200,
    rotation: 0,
    fill: "#38bdf8",
    shape: {
      type: "level",
      direction: "up",
      min: 0,
      max: 200,
      background: "#1e293b",
      binding: { externalName: "Demo.Number" },
    },
  });
  project.symbols[0].objects.push({
    id: symbolLevelId,
    order: 900,
    x: 0,
    y: 0,
    width: 200,
    height: 20,
    rotation: 0,
    fill: "#22c55e",
    shape: {
      type: "level",
      direction: "right",
      min: 0,
      max: 100,
      slotBinding: { slotName: "current" },
    },
  });
  return project;
}

for (const theme of ["light", "dark"] as const)
  test(`levels fill only Good values inside their limits in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await fixtureEntry(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    await openProject(page, {
      name: "level.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(levelProject())),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const screenLevel = mainCanvas(page).locator(
      `[data-object-id="${screenLevelId}"] [data-level-state]`,
    );
    const slotLevel = mainCanvas(page).locator(
      `[data-object-id="${sample.screens[0].objects[0].id}"] [data-symbol-child-id="${symbolLevelId}"] [data-level-state]`,
    );
    await expect(screenLevel).toHaveAttribute(
      "data-level-state",
      "unavailable",
    );
    await expect(screenLevel.locator("[data-level-fill]")).toHaveCount(0);

    expect(await send(page, 1, "good", 50)).toBe(true);
    await expect(screenLevel).toHaveAttribute("data-level-state", "good");
    const fill = screenLevel.locator("[data-level-fill]");
    await expect(fill).toHaveAttribute("y", "150");
    await expect(fill).toHaveAttribute("height", "50");
    await expect(screenLevel.locator("title")).toHaveText(
      "液位 · Demo.Number · 50（0〜200）",
    );
    await expect(slotLevel).toHaveAttribute("data-level-state", "good");
    await expect(slotLevel.locator("[data-level-fill]")).toHaveAttribute(
      "width",
      "100",
    );

    // 150 is inside the screen level but above the Symbol level's 100.
    expect(await send(page, 2, "good", 150)).toBe(true);
    await expect(screenLevel).toHaveAttribute("data-level-state", "good");
    await expect(slotLevel).toHaveAttribute("data-level-state", "high");
    await expect(slotLevel.locator("[data-level-fill]")).toHaveCount(0);
    await expect(slotLevel.locator("[data-level-marker]")).toHaveCount(1);

    expect(await send(page, 3, "stale")).toBe(true);
    for (const level of [screenLevel, slotLevel]) {
      await expect(level).toHaveAttribute("data-level-state", "unavailable");
      await expect(level.locator("[data-level-fill]")).toHaveCount(0);
    }
    await expect(screenLevel.locator("title")).toContainText("更新停止");
  });

test("the Inspector edits a level's limits, direction, background and tag", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "level.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(levelProject())),
  });
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${screenLevelId}"]`).click();
  const form = page.locator('form[data-editor-form="object"]');
  await expect(form.getByLabel("液位の下限", { exact: true })).toHaveValue("0");
  await expect(form.getByLabel("液位の上限", { exact: true })).toHaveValue(
    "200",
  );
  await expect(
    form.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("Demo.Number");

  await form.getByLabel("液位の向き", { exact: true }).selectOption("right");
  await form.getByLabel("液位の下限", { exact: true }).fill("-10");
  await form.getByLabel("液位の上限", { exact: true }).fill("10");
  await form.getByLabel("液位の地", { exact: true }).selectOption("none");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(form.getByLabel("液位の下限", { exact: true })).toHaveValue(
    "-10",
  );
  await expect(form.getByLabel("液位の向き", { exact: true })).toHaveValue(
    "right",
  );
  await expect(form.getByLabel("液位の地", { exact: true })).toHaveValue(
    "none",
  );

  // Reversed limits are refused and the saved limits stay.
  await form.getByLabel("液位の下限", { exact: true }).fill("20");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(page.getByText(/下限は上限より小さく/).first()).toBeVisible();

  await form.getByLabel("液位の下限", { exact: true }).fill("-10");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await page.locator(`button[data-layer-id="${screenLevelId}"]`).click();
  await page.keyboard.press("Control+z");
  await expect(form.getByLabel("液位の下限", { exact: true })).toHaveValue("0");
});
