import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const layers = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧" });
const canvas = (page: Page) => page.locator(".sheet > svg");
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page, project: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await waiting;
  return JSON.parse(await readFile((await file.path())!, "utf8"));
}
const rectangleId = sample.screens[0].objects[0].id;
test("hide affects drawing, minimap and preview while layers retain editable metadata and Undo", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await button(page, "非表示：rectangle · 3").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveCount(0);
  await expect(
    button(page, "ミニマップで表示位置を移動").locator(
      `[data-object-id="${rectangleId}"]`,
    ),
  ).toHaveCount(0);
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  await expect(button(page, "再表示：rectangle · 3")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await button(page, "表示プレビュー").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveCount(0);
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await expect(page.getByLabel("x", { exact: true })).toBeEnabled();
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "1 件が非表示" }),
  ).toBeVisible();
  await page.getByLabel("x", { exact: true }).fill("125");
  await page.getByLabel("x", { exact: true }).press("Enter");
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveCount(0);
  await button(page, "配置を再表示").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveAttribute("transform", "translate(125 170)");
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(8);
  await button(page, "元に戻す").click();
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(0);
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveCount(0);
  await button(page, "やり直す").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toBeVisible();
});
test("all-hidden diagrams remain valid, explain recovery, and allow showing a locked placement", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.screens[0].objects.forEach((o: any) => (o.visible = false));
  project.screens[0].objects[0].locked = true;
  await start(page, project);
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "表示中の配置がありません" }),
  ).toBeVisible();
  await viewport(page).focus();
  await page.keyboard.press("Control+a");
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await expect(page.getByLabel("x", { exact: true })).toBeDisabled();
  await button(page, "配置を再表示").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toBeVisible();
  await expect(page.getByLabel("x", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "表示中の配置がありません" }),
  ).toHaveCount(0);
  await button(page, "元に戻す").click();
  await expect(
    page.getByRole("status").filter({ hasText: "表示中の配置がありません" }),
  ).toBeVisible();
  const saved = await exported(page);
  expect(saved.screens[0].objects).toHaveLength(3);
  expect(saved.screens[0].objects.every((o: any) => o.visible === false)).toBe(
    true,
  );
});
test("hide protects drafts and keeps apply versus visibility as separate Undo operations", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("保持するタンク");
  await button(page, "非表示：rectangle · 3").click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(name).toHaveValue("保持するタンク");
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toBeVisible();
  await button(page, "非表示：rectangle · 3").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toHaveCount(0);
  await expect(
    layers(page).getByRole("button", { name: "保持するタンク", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await button(page, "元に戻す").click();
  await expect(
    canvas(page).locator(`[data-object-id="${rectangleId}"]`),
  ).toBeVisible();
  await button(page, "元に戻す").click();
  await expect(
    layers(page).getByRole("button", { name: "rectangle · 3", exact: true }),
  ).toBeVisible();
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("hidden mixed selection rejects canvas movement/delete/cut, while explicit Inspector operations remain available", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].visible = false;
  await start(page, project);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await layers(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("toolbar", { name: "共通編集ツールバー" }),
  ).toContainText("非表示 1 件");
  const ellipse = canvas(page).locator(
      `[data-object-id="${sample.screens[0].objects[1].id}"]`,
    ),
    before = await ellipse.getAttribute("transform");
  await viewport(page).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Delete");
  await page.evaluate(() => navigator.clipboard.writeText("keep"));
  await page.keyboard.press("Control+x");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep",
  );
  await expect(ellipse).toHaveAttribute("transform", before!);
  await expect(button(page, "元に戻す")).toBeDisabled();
  const box = (await ellipse.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 60, { steps: 4 });
  await page.mouse.up();
  await expect(ellipse).toHaveAttribute("transform", before!);
  await expect(page.getByLabel("移動量 X", { exact: true })).toBeEnabled();
  await button(page, "左揃え").click();
  await expect(ellipse).toHaveAttribute("transform", "translate(100 190)");
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.keyboard.press("Delete");
  await expect(
    layers(page).getByRole("button", { name: "rectangle · 3", exact: true }),
  ).toHaveCount(0);
});
test("hidden copying, paste and JSON keep invisible locked metadata and never auto-select it", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].visible = false;
  project.screens[0].objects[0].locked = true;
  project.screens[0].objects[0].name = "非表示の予備設備";
  await start(page, project);
  await layers(page)
    .getByRole("button", { name: "非表示の予備設備", exact: true })
    .click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(
    layers(page).getByRole("button", { name: "非表示の予備設備", exact: true }),
  ).toHaveCount(2);
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(2);
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  const saved = await exported(page);
  expect(saved.manifest.schemaVersion).toBe("0.16.0");
  expect(
    saved.screens[0].objects.filter(
      (o: any) => o.visible === false && o.locked,
    ),
  ).toHaveLength(2);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "hidden.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(2);
});
test("shared child visibility reaches all previews and thumbnails while the definition stays editable", async ({
  page,
}) => {
  const project: any = structuredClone(processSample);
  project.symbols[0].objects[0].visible = false;
  project.symbols[0].objects[0].locked = true;
  await start(page, project);
  const pump = canvas(page).locator(
    `[data-object-id="${project.screens[0].objects[10].id}"]`,
  );
  await expect(pump.locator("polyline")).toHaveCount(
    project.symbols[0].objects.length - 1,
  );
  await layers(page)
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await button(page, "参照する Symbol 定義を編集").click();
  await expect(
    button(page, "共有定義：ポンプ").locator("polyline"),
  ).toHaveCount(project.symbols[0].objects.length - 1);
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "polyline · 0", exact: true })
    .click();
  await expect(page.getByLabel("線幅", { exact: true })).toBeDisabled();
  await expect(canvas(page).locator("[data-vertex-object-id]")).toHaveCount(0);
  await button(page, "配置を再表示").click();
  await expect(page.getByLabel("線幅", { exact: true })).toBeDisabled();
  await expect(
    canvas(page).locator(
      `[data-object-id="${project.symbols[0].objects[0].id}"]`,
    ),
  ).toBeVisible();
  await button(page, "画面へ戻る").click();
  await expect(pump.locator("polyline")).toHaveCount(
    project.symbols[0].objects.length,
  );
});
test("hidden tag usages remain visible and navigate to Inspector without silently showing the placement", async ({
  page,
}) => {
  const project: any = structuredClone(processSample),
    text = project.screens[0].objects[6];
  text.visible = false;
  text.name = "隠れた液位";
  text.shape.binding = { externalName: "Exact.Hidden.Tag" };
  await start(page, project);
  await page.locator("details.references > summary").click();
  const refs = page.getByRole("region", {
    name: "Project のタグ参照",
    exact: true,
  });
  await expect(refs).toContainText("非表示");
  await refs
    .getByRole("button", { name: /隠れた液位（Text 6） を編集$/ })
    .click();
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("Exact.Hidden.Tag");
  await expect(button(page, "配置を再表示")).toBeVisible();
  await expect(
    canvas(page).locator(`[data-object-id="${text.id}"]`),
  ).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
for (const theme of ["light", "dark"])
  test(`eye controls and long names remain accessible without overlapping in ${theme}`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample);
    const label = "P-101 " + "非常に長い設備名".repeat(10);
    project.screens[0].objects[0].name = label;
    await start(page, project);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    const eye = button(page, `非表示：${label}`);
    const row = layers(page).getByRole("button", { name: label, exact: true });
    const text = (await row.locator("span").boundingBox())!;
    const icon = (await eye.boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(icon.x - 2);
    await expect(row).toHaveAttribute("title", new RegExp(label));
    await eye.focus();
    await eye.press("Space");
    await expect(button(page, `再表示：${label}`)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(button(page, `再表示：${label}`)).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
