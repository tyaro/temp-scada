import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import sample from "../examples/shape-paint.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const rect = minimal.screens[0].objects[0],
  ellipse = minimal.screens[0].objects[1];
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const form = (page: Page) =>
  page.getByRole("form", { name: "塗りと枠線", exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", { name: "塗りと枠線を適用", exact: true });
const shape = (page: Page, id = rect.id) =>
  page
    .locator(
      `.sheet > svg [data-object-id="${id}"] > [data-object-rotation] > rect`,
    )
    .first();
const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
async function start(page: Page, project: object = minimal) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "paint.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await row(page, rect.id).click();
}
async function stroke(page: Page, fill = "false", width = "6") {
  await form(page).getByLabel("塗り", { exact: true }).selectOption(fill);
  await form(page).getByLabel("枠線", { exact: true }).selectOption("true");
  await form(page).getByLabel("枠線の色", { exact: true }).fill("#2563eb");
  await form(page).getByLabel("枠線の幅", { exact: true }).fill(width);
}
for (const theme of ["light", "dark"] as const)
  test(`paint is explicit, undoable and identical in preview and minimap in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await stroke(page);
    await expect(shape(page)).toHaveAttribute("fill", rect.fill);
    await expect(shape(page)).toHaveAttribute("stroke", "none");
    await apply(page).click();
    await expect(shape(page)).toHaveAttribute("fill", "none");
    await expect(shape(page)).toHaveAttribute("stroke", "#2563eb");
    await expect(shape(page)).toHaveAttribute("stroke-width", "6");
    await expect(page.getByLabel("色", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("width", { exact: true })).toHaveValue(
      String(rect.width),
    );
    const outline = page.locator(
      `.sheet > svg [data-object-id="${rect.id}"] > rect[stroke="var(--canvas-accent)"]`,
    );
    await expect(outline).toHaveAttribute("x", "-3");
    await expect(outline).toHaveAttribute("width", String(rect.width + 6));
    await expect(
      page
        .locator(
          `.minimap [data-object-id="${rect.id}"] > [data-object-rotation] > rect`,
        )
        .first(),
    ).toHaveAttribute("stroke", "#2563eb");
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(shape(page)).toHaveAttribute("fill", rect.fill);
    await expect(form(page).getByLabel("枠線", { exact: true })).toHaveValue(
      "false",
    );
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    await expect(shape(page)).toHaveAttribute("fill", "none");
    const download = page.waitForEvent("download");
    await page.keyboard.press("Control+s");
    const saved = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(saved.screens[0].objects[0].fill).toBe(rect.fill);
    expect(saved.screens[0].objects[0].shape.paint).toEqual({
      fillEnabled: false,
      stroke: { color: "#2563eb", width: 6 },
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await expect(shape(page)).toHaveAttribute("stroke", "#2563eb");
  });
test("paint drafts participate in cancellation and prevalidation without numeric partial commits", async ({
  page,
}) => {
  await start(page);
  await stroke(page, "true", "0");
  await page.getByLabel("配置名", { exact: true }).fill("未確定");
  await row(page, ellipse.id).click();
  await expect(prompt(page)).toBeVisible();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(shape(page)).toHaveAttribute("stroke", "none");
  await expect(row(page, rect.id)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "未確定",
  );
  await form(page).getByLabel("枠線の幅", { exact: true }).fill("4");
  await row(page, ellipse.id).click();
  await prompt(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(form(page).getByLabel("枠線の幅", { exact: true })).toHaveValue(
    "4",
  );
  await row(page, ellipse.id).click();
  await prompt(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await row(page, rect.id).click();
  await expect(shape(page)).toHaveAttribute("stroke", "none");
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue("");
});
test("bulk color targets enabled paint channels and explains fully disabled shapes", async ({
  page,
}) => {
  await start(page);
  await stroke(page);
  await apply(page).click();
  await row(page, ellipse.id).click({ modifiers: ["Shift"] });
  const colors = page.getByRole("form", {
    name: "選択した配置の色",
    exact: true,
  });
  await expect(colors).toContainText("混在");
  await colors.getByLabel("適用する色", { exact: true }).fill("#abcdef");
  await colors
    .getByRole("button", { name: "選択した配置に色を適用", exact: true })
    .click();
  await expect(shape(page)).toHaveAttribute("fill", "none");
  await expect(shape(page)).toHaveAttribute("stroke", "#abcdef");
  await row(page, rect.id).click();
  await form(page).getByLabel("枠線", { exact: true }).selectOption("false");
  await apply(page).click();
  await row(page, ellipse.id).click({ modifiers: ["Shift"] });
  await expect(colors).toContainText("塗りと枠線が無効");
  await expect(colors.getByLabel("適用する色", { exact: true })).toBeDisabled();
});
test("locked paint remains readable and IME Enter never submits a staged change", async ({
  page,
}) => {
  const project: any = structuredClone(minimal);
  project.screens[0].objects[0].locked = true;
  await start(page, project);
  await expect(form(page).getByLabel("塗り", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "ロックを解除", exact: true }).click();
  await stroke(page, "true", "4");
  const width = form(page).getByLabel("枠線の幅", { exact: true });
  await width.dispatchEvent("compositionstart");
  await width.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(shape(page)).toHaveAttribute("stroke", "none");
  await width.dispatchEvent("compositionend");
  await width.press("Enter");
  await expect(shape(page)).toHaveAttribute("stroke-width", "4");
});
for (const theme of ["light", "dark"] as const)
  test(`outline controls fit narrow ${theme} panels`, async ({ page }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await stroke(page, "true");
    const bounds = await form(page).boundingBox();
    expect(bounds?.width).toBeGreaterThan(120);
    await expect(apply(page)).toBeInViewport();
    await apply(page).click();
    await expect(shape(page)).toHaveAttribute("stroke-width", "6");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
test("shared paint preserves monochrome overrides and warns about viewport clipping", async ({
  page,
}) => {
  const project = structuredClone(sample);
  const child = project.symbols[0].objects.find(
    (o) => o.shape.type === "ellipse",
  )!;
  child.x = 0;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "sample.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  const placements = project.screens[0].objects.filter(
    (o) => o.shape.type === "symbol",
  );
  for (const [i, placement] of placements.entries()) {
    const painted = page
      .locator(
        `.sheet > svg [data-object-id="${placement.id}"] > [data-object-rotation] > svg ellipse`,
      )
      .first();
    await expect(painted).toHaveAttribute(
      "stroke",
      i === 0 ? placement.fill : "#0f766e",
    );
  }
  await row(page, placements[1].id).click();
  await page
    .getByRole("button", { name: "参照する Symbol 定義を編集", exact: true })
    .click();
  await expect(
    page.getByText(/枠線が表示領域外へ出ている図形が/),
  ).toBeVisible();
});

test("outline width accepts decimal syntax and retains invalid drafts without editing", async ({
  page,
}) => {
  await start(page);
  await stroke(page, "true", "0x10");
  for (const raw of ["0x10", "1e309", "-1", "64.1"]) {
    await form(page).getByLabel("枠線の幅", { exact: true }).fill(raw);
    await apply(page).click();
    await expect(shape(page)).toHaveAttribute("stroke", "none");
    await expect(
      form(page).getByLabel("枠線の幅", { exact: true }),
    ).toHaveValue(raw);
  }
  await form(page).getByLabel("枠線の幅", { exact: true }).fill("2.5e0");
  await apply(page).click();
  await expect(shape(page)).toHaveAttribute("stroke-width", "2.5");
});
