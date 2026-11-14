import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { mainCanvas, selectPanel } from "./helpers/designer";

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

const bound = sample.screens[0].objects[6];

test("the Inspector sets a bool display and the Text follows the bit tag", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixtureEntry(page);
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "bool-display.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await selectPanel(page, "レイヤー");
  const form = page.getByRole("form", { name: "bool の表示", exact: true });
  // A static Text has no tag to read.
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[1].id}"]`)
    .click();
  await expect(form).toHaveCount(0);

  await page.locator(`button[data-layer-id="${bound.id}"]`).click();
  await form
    .getByLabel("bool の表示を使う", { exact: true })
    .selectOption("enabled");
  await form.getByLabel("true の文字", { exact: true }).fill("運転");
  await form.getByLabel("true の色", { exact: true }).fill("#16a34a");
  await form.getByLabel("false の文字", { exact: true }).fill("停止");
  await form.getByLabel("false の色", { exact: true }).fill("#64748b");
  await form.getByLabel("取得不能の色", { exact: true }).fill("#d97706");
  await form
    .getByRole("button", { name: "bool の表示を適用", exact: true })
    .click();
  // The numeric format is not offered for a Text that shows a bool.
  await expect(
    page.getByRole("form", { name: "数値の書式", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const text = mainCanvas(page)
    .locator(`[data-object-id="${bound.id}"] [data-text-content]`)
    .first();
  expect(await sendBit(page, 1, { quality: "good", boolValue: true })).toBe(
    true,
  );
  await expect(text).toHaveText("運転");
  await expect(text).toHaveAttribute("fill", "#16a34a");
  expect(await sendBit(page, 2, { quality: "good", boolValue: false })).toBe(
    true,
  );
  await expect(text).toHaveText("停止");
  await expect(text).toHaveAttribute("fill", "#64748b");
  // Anything but a Good bool shows the reason in the unknown color.
  expect(await sendBit(page, 3, { quality: "stale" })).toBe(true);
  await expect(text).toHaveText("-- · 更新停止");
  await expect(text).toHaveAttribute("fill", "#d97706");
  expect(await sendBit(page, 4, { quality: "good", boolValue: true })).toBe(
    true,
  );
  await expect(text).toHaveAttribute("fill", "#16a34a");
  expect(await sendBit(page, 5, { quality: "good", numericValue: 3 })).toBe(
    true,
  );
  await expect(text).toHaveText("-- · slot型不一致");
  await expect(text).toHaveAttribute("fill", "#d97706");

  // Undo removes the whole display in one step.
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.locator(`button[data-layer-id="${bound.id}"]`).click();
  await expect(
    form.getByLabel("bool の表示を使う", { exact: true }),
  ).toHaveValue("enabled");
  await page.keyboard.press("Control+z");
  await expect(
    form.getByLabel("bool の表示を使う", { exact: true }),
  ).toHaveValue("disabled");
});

test("a Text with a numeric format cannot use the bool display", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const project = structuredClone(sample) as any;
  project.screens[0].objects[6].shape.format = { decimals: 1 };
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "bool-display-format.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${bound.id}"]`).click();
  await expect(
    page.getByRole("form", { name: "bool の表示", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "bool の表示", exact: true }),
  ).toContainText("数値の書式を持つTextでは使えません");
});
