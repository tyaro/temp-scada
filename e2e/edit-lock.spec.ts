import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const layers = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧" });
const canvas = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
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
async function range(page: Page) {
  const points = await canvas(page).evaluate((el) => {
    const matrix = (el as SVGSVGElement).getScreenCTM()!;
    return [
      { x: 80, y: 150 },
      { x: 730, y: 370 },
    ].map((p) => {
      const point = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
  await page.mouse.up();
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const download = await waiting;
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}
test("locked placements remain visible, exclude canvas/all/range selection, and have a readable Inspector unlock", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const rect = canvas(page).locator("[data-object-id]").first();
  const transform = await rect.getAttribute("transform");
  await button(page, "ロック：rectangle · 3").click();
  await expect(page.getByLabel("配置名", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("x", { exact: true })).toBeDisabled();
  await expect(button(page, "選択図形を削除")).toBeDisabled();
  await expect(button(page, "選択図形を複製")).toBeDisabled();
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(0);
  await expect(rect).toBeVisible();
  await expect(rect).toHaveAttribute("pointer-events", "none");
  await viewport(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(rect).toHaveAttribute("transform", transform!);
  const box = (await rect.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  await viewport(page).focus();
  await page.keyboard.press("Control+a");
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(2);
  await expect(rect).not.toHaveAttribute("data-selected", "true");
  await range(page);
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(1);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await button(page, "ロックを解除").click();
  await expect(page.getByLabel("x", { exact: true })).toBeEnabled();
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(8);
  await button(page, "元に戻す").click();
  await expect(page.getByLabel("x", { exact: true })).toBeDisabled();
  await button(page, "元に戻す").click();
  await expect(page.getByLabel("x", { exact: true })).toBeEnabled();
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("mixed layer selection is read-only and direct keyboard mutations never partially apply", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].locked = true;
  await start(page, project);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await layers(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(page.getByLabel("移動量 X", { exact: true })).toBeDisabled();
  await expect(button(page, "左揃え")).toBeDisabled();
  const before = await canvas(page)
    .locator("[data-object-id]")
    .evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("transform")),
    );
  await viewport(page).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Delete");
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(3);
  expect(
    await canvas(page)
      .locator("[data-object-id]")
      .evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("transform")),
      ),
  ).toEqual(before);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.getByTestId("project-status")).toContainText("ロック中");
});
test("lock toggles protect drafts and invalid input; apply and lock are separate undo steps", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("保持する名前");
  await button(page, "ロック：rectangle · 3").click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(name).toHaveValue("保持する名前");
  await expect(name).toBeEnabled();
  await button(page, "ロック：rectangle · 3").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(name).toHaveValue("保持する名前");
  await expect(name).toBeDisabled();
  await button(page, "元に戻す").click();
  await expect(name).toHaveValue("保持する名前");
  await expect(name).toBeEnabled();
  await button(page, "元に戻す").click();
  await expect(name).toHaveValue("");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("width", { exact: true }).fill("-1");
  await button(page, "ロック：rectangle · 3").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(name).toBeEnabled();
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("-1");
  await expect(button(page, "ロック：rectangle · 3")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
test("locked copying and paste preserve metadata; cut refuses before writing the OS clipboard", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].locked = true;
  project.screens[0].objects[0].name = "保護したタンク";
  await start(page, project);
  const row = layers(page).getByRole("button", {
    name: "保護したタンク",
    exact: true,
  });
  await row.click();
  await page.keyboard.press("Control+c");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text).project.screens[0].objects[0].locked).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText("keep"));
  await row.focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("project-status")).toContainText("ロック中");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep",
  );
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+v");
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(4);
  await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  await expect(button(page, "ロック解除：保護したタンク")).toHaveCount(2);
  const saved = await exported(page);
  expect(saved.manifest.schemaVersion).toBe("0.16.0");
  expect(saved.screens[0].objects.filter((o: any) => o.locked).length).toBe(2);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "locked.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await layers(page)
    .getByRole("button", { name: "保護したタンク", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("配置名", { exact: true })).toBeDisabled();
  await button(page, "ロックを解除").click();
  await expect(page.getByLabel("配置名", { exact: true })).toBeEnabled();
});
test("locked Symbol instances allow shared definition navigation; locked children have no vertex handles", async ({
  page,
}) => {
  const project: any = structuredClone(processSample);
  project.screens[0].objects[10].locked = true;
  project.symbols[0].objects[0].locked = true;
  await start(page, project);
  await layers(page)
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await expect(
    page.getByLabel("参照する Symbol 定義", { exact: true }),
  ).toBeDisabled();
  await button(page, "共有定義を確認・編集").click();
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "polyline · 0", exact: true })
    .click();
  await expect(page.getByLabel("線幅", { exact: true })).toBeDisabled();
  await expect(page.locator(".sheet [data-vertex-object-id]")).toHaveCount(0);
  await button(page, "ロックを解除").click();
  await expect(page.getByLabel("線幅", { exact: true })).toBeEnabled();
  await expect(page.locator(".sheet [data-vertex-object-id]")).not.toHaveCount(
    0,
  );
});
for (const theme of ["light", "dark"])
  test(`lock affordances remain keyboard-accessible at narrow widths in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    const toggle = button(page, "ロック：rectangle · 3");
    await toggle.focus();
    await expect(toggle).toHaveCSS("opacity", "1");
    await toggle.press("Space");
    await expect(button(page, "ロック解除：rectangle · 3")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await layers(page)
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await expect(button(page, "ロックを解除")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
