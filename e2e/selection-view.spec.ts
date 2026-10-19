import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import sample from "../examples/shape-paint.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const ids = minimal.screens[0].objects.map((object) => object.id);
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const fit = (page: Page) =>
  page.getByRole("button", { name: "選択範囲を表示", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page) => page.locator(".sheet > svg");
function fixture() {
  const value: any = structuredClone(minimal);
  value.screens[0].width = 2400;
  value.screens[0].height = 1600;
  value.screens[0].objects[0].x = 1400;
  value.screens[0].objects[0].y = 900;
  value.screens[0].objects[0].shape.paint.stroke = {
    color: "#2563eb",
    width: 12,
  };
  value.screens[0].objects[1].x = 1800;
  value.screens[0].objects[1].y = 1100;
  return value;
}
async function start(page: Page, project: object = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "selection.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function selected(page: Page, targets = [ids[0]]) {
  for (const [i, id] of targets.entries())
    await row(page, id).click({ modifiers: i ? ["Shift"] : [] });
}
async function state(page: Page) {
  return viewport(page).evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
    zoom: (
      element.querySelector(".sheet > svg") as SVGSVGElement
    ).getScreenCTM()!.a,
  }));
}
async function exported(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
async function assertFit(
  page: Page,
  bounds: { x: number; y: number; width: number; height: number },
) {
  await expect
    .poll(() =>
      svg(page).evaluate((element, b) => {
        const matrix = (element as SVGSVGElement).getScreenCTM()!,
          area = document.querySelector(
            '[aria-label="キャンバス操作領域"]',
          )! as HTMLElement,
          rect = area.getBoundingClientRect();
        const center = new DOMPoint(
          b.x + b.width / 2,
          b.y + b.height / 2,
        ).matrixTransform(matrix);
        return Math.max(
          Math.abs(
            center.x - (rect.left + area.clientLeft + area.clientWidth / 2),
          ),
          Math.abs(
            center.y - (rect.top + area.clientTop + area.clientHeight / 2),
          ),
        );
      }, bounds),
    )
    .toBeLessThan(2);
  const values = await viewport(page).evaluate((element, b) => {
    const m = (
      element.querySelector(".sheet > svg") as SVGSVGElement
    ).getScreenCTM()!;
    return {
      actual: m.a,
      expected: Math.max(
        0.25,
        Math.min(
          4,
          (element.clientWidth - 64) / b.width,
          (element.clientHeight - 64) / b.height,
        ),
      ),
    };
  }, bounds);
  expect(values.actual).toBeCloseTo(values.expected, 4);
}
for (const theme of ["light", "dark"] as const)
  test(`selected outlines fit the actual viewport once without Project changes in ${theme}`, async ({
    page,
  }) => {
    const project = fixture();
    await start(page, project);
    await chooseTheme(page, theme);
    await expect(fit(page)).toBeDisabled();
    await selected(page);
    await fit(page).click();
    await assertFit(page, { x: 1394, y: 894, width: 272, height: 192 });
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
    expect(await exported(page)).toEqual(project);
    const before = await state(page);
    await row(page, ids[1]).click();
    expect(await state(page)).toEqual(before);
    await page.getByRole("button", { name: "全体表示", exact: true }).click();
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      "fit",
    );
  });
test("multiple selections and the menu use the same one-shot view", async ({
  page,
}) => {
  await start(page);
  await selected(page, [ids[0], ids[1]]);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "表示", exact: true })
    .getByRole("menuitem", { name: "選択範囲を表示", exact: true })
    .click();
  await assertFit(page, { x: 1394, y: 894, width: 546, height: 346 });
});
test("a pointer toolbar action preserves focused numeric and text drafts including invalid input", async ({
  page,
}) => {
  await start(page);
  await selected(page);
  const x = page.getByLabel("x", { exact: true });
  await x.fill("1500");
  await fit(page).click();
  await expect(x).toBeFocused();
  await expect(x).toHaveValue("1500");
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await assertFit(page, { x: 1394, y: 894, width: 272, height: 192 });
  await x.fill("invalid");
  await fit(page).click();
  await expect(x).toBeFocused();
  await expect(x).toHaveValue("invalid");
  await expect(
    page.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("F is local, ignores inputs, modified keys, IME and repeat, and does not run during a drag", async ({
  page,
}) => {
  await start(page);
  await selected(page);
  const original = await state(page);
  await page.getByLabel("配置名", { exact: true }).focus();
  await page.keyboard.press("f");
  expect(await state(page)).toEqual(original);
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue("f");
  // Reset the text input so focusing the canvas keeps the same selected target.
  await page.getByLabel("配置名", { exact: true }).fill("");
  await viewport(page).focus();
  for (const args of [
    { key: "f", repeat: true },
    { key: "f", isComposing: true },
    { key: "f", keyCode: 229 },
    { key: "f", ctrlKey: true },
    { key: "f", shiftKey: true },
  ]) {
    await viewport(page).dispatchEvent("keydown", args);
    expect(await state(page)).toEqual(original);
  }
  await viewport(page).press("f");
  await assertFit(page, { x: 1394, y: 894, width: 272, height: 192 });
  const before = await state(page);
  const shape = svg(page).locator(`[data-object-id="${ids[0]}"]`);
  const box = (await shape.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 10,
    box.y + box.height / 2 + 10,
  );
  await page.keyboard.press("f");
  expect(await state(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("locked selections can be shown; hidden mixtures and off-sheet-only selections explain why they cannot", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].locked = true;
  project.screens[0].objects[1].visible = false;
  project.screens[0].objects[2].x = -2000;
  await start(page, project);
  await selected(page);
  await expect(fit(page)).toBeEnabled();
  await fit(page).click();
  await assertFit(page, { x: 1394, y: 894, width: 272, height: 192 });
  await row(page, ids[1]).click({ modifiers: ["Shift"] });
  await expect(fit(page)).toBeDisabled();
  await expect(fit(page)).toHaveAttribute("title", /非表示/);
  await selected(page, [ids[2]]);
  await expect(fit(page)).toBeDisabled();
  await expect(fit(page)).toHaveAttribute("title", /すべて画面外/);
});
test("clipping happens per placement and notifies without changing selected IDs or positions", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[0].x = -50;
  project.screens[0].objects[0].y = -20;
  project.screens[0].objects[1].x = 3000;
  await start(page, project);
  await selected(page, [ids[0], ids[1]]);
  await fit(page).click();
  await assertFit(page, { x: 0, y: 0, width: 216, height: 166 });
  await expect(page.getByTestId("project-status")).toContainText(
    "完全に画面外の配置 1 件",
  );
  for (const id of ids.slice(0, 2))
    await expect(row(page, id)).toHaveAttribute("aria-pressed", "true");
  expect(await exported(page)).toEqual(project);
});
for (const theme of ["light", "dark"] as const)
  test(`selection view fits narrow panels and shared definitions in ${theme}`, async ({
    page,
  }) => {
    await start(page, sample);
    await chooseTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 720 });
    const instance = sample.screens[0].objects.find(
      (object) => object.shape.type === "symbol",
    )!;
    await selected(page, [instance.id]);
    await fit(page).click();
    await expect(fit(page)).toBeInViewport();
    await page
      .getByRole("button", { name: "参照する Symbol 定義を編集", exact: true })
      .click();
    await selectPanel(page, "レイヤー");
    const child = sample.symbols[0].objects.find(
      (object) => object.shape.type === "ellipse",
    )!;
    await selected(page, [child.id]);
    await fit(page).click();
    const pad = (child.shape as any).paint.stroke.width / 2;
    await assertFit(page, {
      x: child.x - pad,
      y: child.y - pad,
      width: child.width + 2 * pad,
      height: child.height + 2 * pad,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("selection view respects both manual zoom limits even when the whole target cannot fit", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].width = 10000;
  project.screens[0].height = 8000;
  const [tiny, huge] = project.screens[0].objects;
  tiny.width = 1;
  tiny.height = 1;
  tiny.shape.paint.stroke = null;
  huge.x = 0;
  huge.y = 0;
  huge.width = 10000;
  huge.height = 8000;
  await start(page, project);
  await selected(page);
  await fit(page).click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("4");
  await selected(page, [huge.id]);
  await fit(page).click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
    "0.25",
  );
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
