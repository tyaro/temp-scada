import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { chooseTheme, mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

/** Same test-only read source as read-presentation.spec.ts. */
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
    // The equipment slot reads the same tag and must agree with the Text.
    for (const row of update.slots.slots)
      if (row.externalName === "Demo.Number")
        row.reading.value = { type: "number", value: numericValue };
  }
  return page.evaluate(
    (update) => (window as any).__readHarness.delivery.receive(update),
    update,
  );
}

const bound = sample.screens[0].objects[6];

for (const theme of ["light", "dark"] as const)
  test(`a tag-bound Text shows Good numbers with its decimals and unit in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await fixtureEntry(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    const project = structuredClone(sample) as any;
    for (const screen of project.screens)
      for (const object of screen.objects)
        if (object.shape.binding?.externalName === "Demo.Number")
          object.shape.format = { decimals: 2, unit: "m3/h" };
    // The Symbol's Text bound to the number slot "current".
    project.symbols[0].objects[6].shape.format = { decimals: 1, unit: "A" };
    await openProject(page, {
      name: "numeric-format.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const numbers = mainCanvas(page).locator('[data-tag-name="Demo.Number"]');
    await expect(numbers).toHaveCount(2);
    const slots = mainCanvas(page).locator(
      `[data-object-id="${sample.screens[0].objects[0].id}"] [data-tag-name="current"]`,
    );
    await expect(slots).toHaveCount(1);
    expect(await send(page, 1, "good", 12.346)).toBe(true);
    for (const number of await numbers.all())
      await expect(number.locator("[data-text-content]")).toHaveText(
        "12.35 m3/h",
      );
    await expect(slots.locator("[data-text-content]")).toHaveText("12.3 A");
    expect(await send(page, 2, "good", -0.001)).toBe(true);
    for (const number of await numbers.all())
      await expect(number.locator("[data-text-content]")).toHaveText(
        "0.00 m3/h",
      );
    expect(await send(page, 3, "stale")).toBe(true);
    // The stale fixture comes from simulation; the unit is never shown.
    for (const number of await numbers.all())
      await expect(number.locator("[data-text-content]")).toHaveText(
        "SIM · -- · 更新停止",
      );
    await expect(slots.locator("[data-text-content]")).toHaveText(
      "SIM · -- · 更新停止",
    );
  });

test("the Inspector applies and removes a format, starting from the tag list unit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const project = structuredClone(sample) as any;
  project.screens[0].objects[6].shape.binding.externalName =
    "Demo.Water.Tank01.Temperature";
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "format.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  // A static Text has no number to format.
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[1].id}"]`)
    .click();
  const form = page.getByRole("form", { name: "数値の書式", exact: true });
  await expect(form).toHaveCount(0);
  await page.locator(`button[data-layer-id="${bound.id}"]`).click();
  await expect(form.getByLabel("単位", { exact: true })).toHaveValue("°C");
  await expect(form.getByLabel("小数桁", { exact: true })).toHaveValue("");
  await expect(form).toContainText("タグ一覧の単位（°C）を初期値");
  await form.getByLabel("小数桁", { exact: true }).selectOption("1");
  await form
    .getByRole("button", { name: "数値の書式を適用", exact: true })
    .click();
  await expect(form).not.toContainText("タグ一覧の単位");
  await expect(form.getByLabel("小数桁", { exact: true })).toHaveValue("1");
  await expect(form.getByLabel("単位", { exact: true })).toHaveValue("°C");

  await form.getByLabel("単位", { exact: true }).fill("K");
  await form
    .getByRole("button", { name: "数値の書式を適用", exact: true })
    .click();
  await expect(form.getByLabel("単位", { exact: true })).toHaveValue("K");

  await page.keyboard.press("Control+z");
  await expect(form.getByLabel("単位", { exact: true })).toHaveValue("°C");

  await form.getByLabel("小数桁", { exact: true }).selectOption("");
  await form.getByLabel("単位", { exact: true }).fill("");
  await form
    .getByRole("button", { name: "数値の書式を適用", exact: true })
    .click();
  await expect(form).toContainText("タグ一覧の単位（°C）を初期値");
});
