import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import paintSample from "../examples/shape-paint.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const ids = minimal.screens[0].objects.slice(0, 2).map((object) => object.id);
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const section = (page: Page) =>
  page.getByRole("region", { name: "選択した矩形・楕円の枠線", exact: true });
const form = (page: Page) =>
  page.getByRole("form", {
    name: "選択した矩形・楕円の枠線を変更",
    exact: true,
  });
const width = (page: Page) =>
  form(page).getByLabel("適用する枠線幅", { exact: true });
const color = (page: Page) =>
  form(page).getByLabel("適用する枠線色", { exact: true });
const mode = (page: Page) =>
  form(page).getByLabel("適用する枠線", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した矩形・楕円の枠線に適用",
    exact: true,
  });
const canvas = (page: Page) => page.locator(".sheet > svg");
const shape = (page: Page, id = ids[0]) =>
  canvas(page)
    .locator(
      `[data-object-id="${id}"] > [data-object-rotation] > rect, [data-object-id="${id}"] > [data-object-rotation] > ellipse`,
    )
    .first();
const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
function fixture() {
  const project: any = structuredClone(minimal);
  project.screens[0].objects.slice(0, 2).forEach(
    (object: any, i: number) =>
      (object.shape.paint.stroke = {
        color: i ? "#abcdef" : "#123456",
        width: i ? 4 : 2,
      }),
  );
  return project;
}
async function start(page: Page, project: object = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "outlines.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function select(page: Page, targets = ids) {
  for (const [i, id] of targets.entries())
    await row(page, id).click({ modifiers: i ? ["Shift"] : [] });
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
test("partial outline edits remain staged, preserve fill and dimensions and Undo once", async ({
  page,
}) => {
  const project = fixture();
  await start(page, project);
  await select(page);
  await expect(section(page)).toContainText("枠線あり 2 件・なし 0 件");
  await expect(section(page)).toContainText("混在");
  await expect(apply(page)).toBeDisabled();
  await width(page).fill("6");
  await color(page).focus();
  await expect(shape(page)).toHaveAttribute("stroke-width", "2");
  await apply(page).click();
  await expect(width(page)).toHaveValue("");
  await expect(apply(page)).toBeDisabled();
  for (const id of ids)
    await expect(shape(page, id)).toHaveAttribute("stroke-width", "6");
  await width(page).fill("6");
  await apply(page).click();
  await expect(width(page)).toHaveValue("");
  const saved = await exported(page);
  for (const before of project.screens[0].objects) {
    const after = saved.screens[0].objects.find(
      (object: any) => object.id === before.id,
    );
    if (ids.includes(before.id))
      expect(after).toEqual({
        ...before,
        shape: {
          ...before.shape,
          paint: {
            ...before.shape.paint,
            stroke: { ...before.shape.paint.stroke, width: 6 },
          },
        },
      });
    else expect(after).toEqual(before);
  }
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(shape(page)).toHaveAttribute("stroke-width", "2");
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(shape(page)).toHaveAttribute("stroke-width", "6");
  await color(page).fill("#334455");
  await apply(page).click();
  for (const id of ids)
    await expect(shape(page, id)).toHaveAttribute("stroke", "#334455");
});
test("outline creation requires explicit mode and both values, then updates existing outlines too", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].shape.paint.stroke = null;
  await start(page, project);
  await select(page);
  await width(page).fill("3");
  await expect(apply(page)).toBeDisabled();
  await expect(form(page)).toContainText("新設するには");
  await mode(page).selectOption("enabled");
  await expect(apply(page)).toBeDisabled();
  await color(page).fill("#2563eb");
  await apply(page).click();
  for (const id of ids) {
    await expect(shape(page, id)).toHaveAttribute("stroke-width", "3");
    await expect(shape(page, id)).toHaveAttribute("stroke", "#2563eb");
  }
  await mode(page).selectOption("none");
  await apply(page).click();
  for (const id of ids)
    await expect(shape(page, id)).toHaveAttribute("stroke", "none");
  await expect(section(page)).toContainText("現在の色：なし");
  await expect(section(page)).toContainText("枠線あり 0 件・なし 2 件");
});
test("contradictory removal is blocked and clearing specifications also clears draft protection", async ({
  page,
}) => {
  await start(page);
  await select(page);
  await color(page).fill("#2563eb");
  await mode(page).selectOption("none");
  await expect(apply(page)).toBeDisabled();
  await expect(form(page)).toContainText("同時に指定できません");
  await form(page)
    .getByRole("button", { name: "指定を解除", exact: true })
    .click();
  await expect(color(page)).toHaveValue("");
  await expect(mode(page)).toHaveValue("");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(prompt(page)).not.toBeVisible();
  await expect(shape(page)).toHaveAttribute("stroke", "#123456");
});
test("invalid outline drafts block other form changes without partial application", async ({
  page,
}) => {
  await start(page);
  await select(page);
  await width(page).fill("0");
  await page.getByLabel("移動量 X", { exact: true }).fill("4");
  await page.getByRole("button", { name: "まとめて移動", exact: true }).click();
  await expect(prompt(page)).toBeVisible();
  await prompt(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(shape(page)).toHaveAttribute("stroke-width", "2");
  await expect(
    canvas(page).locator(`[data-object-id="${ids[0]}"]`),
  ).toHaveAttribute(
    "transform",
    `translate(${minimal.screens[0].objects[0].x} ${minimal.screens[0].objects[0].y})`,
  );
  await expect(width(page)).toHaveValue("0");
  await width(page).fill("3");
  await row(page, minimal.screens[0].objects[2].id).click();
  await prompt(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await select(page);
  await expect(shape(page)).toHaveAttribute("stroke-width", "2");
});
test("locked mixtures disable the whole outline form", async ({ page }) => {
  const project = fixture();
  project.screens[0].objects[1].locked = true;
  await start(page, project);
  await select(page);
  await expect(width(page)).toBeDisabled();
  await expect(mode(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
});
test("hidden shapes stay hidden and IME Enter never submits outline drafts", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].visible = false;
  await start(page, project);
  await select(page);
  await expect(section(page)).toContainText("うち非表示 1 件");
  await width(page).fill("8");
  await width(page).dispatchEvent("compositionstart");
  await width(page).dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(shape(page, ids[1])).toHaveAttribute("stroke-width", "4");
  await width(page).dispatchEvent("compositionend");
  await width(page).press("Enter");
  await expect(shape(page, ids[1])).toHaveAttribute("stroke-width", "8");
  const saved = await exported(page);
  expect(saved.screens[0].objects[0].visible).toBe(false);
  expect(saved.screens[0].objects[0].shape.paint.stroke.width).toBe(8);
});
test("mixed primitive types show an explanation without silently extracting supported shapes", async ({
  page,
}) => {
  await start(page);
  await select(page, [ids[0], minimal.screens[0].objects[2].id]);
  await expect(form(page)).toHaveCount(0);
  await expect(
    page.getByText("矩形・楕円だけを選択すると枠線を編集できます。", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(shape(page)).toHaveAttribute("stroke-width", "2");
});
for (const theme of ["light", "dark"] as const)
  test(`outline batch controls fit the narrow ${theme} Inspector`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    await select(page);
    await width(page).fill("6");
    await apply(page).scrollIntoViewIfNeeded();
    await expect(apply(page)).toBeInViewport();
    await apply(page).click();
    await expect(shape(page)).toHaveAttribute("stroke-width", "6");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("editing definition outlines preserves parent modes, fill and placement geometry", async ({
  page,
}) => {
  await start(page, paintSample);
  const placement = paintSample.screens[0].objects.find(
    (object) => object.shape.type === "symbol",
  )!;
  await row(page, placement.id).click();
  await page
    .getByRole("button", { name: "参照する Symbol 定義を編集", exact: true })
    .click();
  await selectPanel(page, "レイヤー");
  const children = paintSample.symbols[0].objects.filter(
    (object) =>
      object.shape.type === "rectangle" || object.shape.type === "ellipse",
  );
  await select(
    page,
    children.slice(0, 2).map((object) => object.id),
  );
  await width(page).fill("8");
  await apply(page).click();
  const saved = await exported(page);
  expect(saved.screens).toEqual(paintSample.screens);
  for (const original of children.slice(0, 2)) {
    const changed = saved.symbols[0].objects.find(
      (object: any) => object.id === original.id,
    );
    expect(changed.shape.paint.stroke.width).toBe(8);
    expect(changed.fill).toBe(original.fill);
  }
});
