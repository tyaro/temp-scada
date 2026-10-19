import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const area = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
async function start(page: Page, zoom = 2) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption(String(zoom));
}
async function hover(page: Page) {
  const box = (await area(page).boundingBox())!;
  const point = { x: box.x + 250, y: box.y + 200 };
  await page.mouse.move(point.x, point.y);
  return point;
}
async function scale(page: Page) {
  return svg(page).evaluate((el) => (el as SVGSVGElement).getScreenCTM()!.a);
}
async function design(page: Page, point: { x: number; y: number }) {
  return svg(page).evaluate((el, p) => {
    const q = new DOMPoint(p.x, p.y).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!.inverse(),
    );
    return { x: q.x, y: q.y };
  }, point);
}
test("ordinary wheel scrolls vertically and Shift wheel scrolls horizontally without changing the Project", async ({
  page,
}) => {
  await start(page, 4);
  await hover(page);
  const before = await area(page).evaluate((el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
  }));
  await page.mouse.wheel(0, 180);
  await expect
    .poll(() => area(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before.y + 100);
  const vertical = await area(page).evaluate((el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
  }));
  expect(vertical.x).toBe(before.x);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 160);
  await page.keyboard.up("Shift");
  await expect
    .poll(() => area(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(vertical.x + 100);
  expect(await area(page).evaluate((el) => el.scrollTop)).toBe(vertical.y);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.getByTestId("save-state")).toContainText(
    "サンプルからの変更なし",
  );
});
test("Ctrl wheel preserves the cursor's design point, handles rapid deltas and exposes the current zoom", async ({
  page,
}) => {
  await start(page);
  const pointer = await hover(page);
  const before = await design(page, pointer);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => scale(page)).toBeCloseTo(2.2, 3);
  let after = await design(page, pointer);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  await expect(page.getByLabel("表示倍率", { exact: true })).toContainText(
    "220%",
  );
  await page.keyboard.down("Control");
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");
  await expect.poll(() => scale(page)).toBeCloseTo(2.2 * Math.pow(1.1, 0.8), 3);
  after = await design(page, pointer);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  await button(page, "全体表示").click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("fit");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("wheel zoom holds draft focus, leaves controls outside the canvas native, and consumes Ctrl at the limits", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("テキスト", { exact: true });
  await input.fill("保持する入力");
  await hover(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => scale(page)).toBeCloseTo(2.2, 3);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("保持する入力");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const outside = await input.evaluate(
    (el) =>
      !el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
        }),
      ),
  );
  expect(outside).toBe(false);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  const consumed = await area(page).evaluate(
    (el) =>
      !el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
        }),
      ),
  );
  expect(consumed).toBe(true);
  expect(await scale(page)).toBe(4);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("0.25");
  await hover(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  expect(await scale(page)).toBe(0.25);
});
test("wheel cancels a shape drag before changing the view and never commits its preview geometry", async ({
  page,
}) => {
  await start(page, 1);
  const point = await svg(page).evaluate((el) => {
    const p = new DOMPoint(200, 250).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 20, { steps: 3 });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.mouse.up();
  await expect.poll(() => scale(page)).toBeCloseTo(1.1, 3);
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(page.getByLabel("y", { exact: true })).toHaveValue("170");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("Shift wheel normalizes line/page deltas and preview retains its fit view", async ({
  page,
}) => {
  await start(page, 4);
  const before = await area(page).evaluate((el) => el.scrollLeft);
  await area(page).dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    deltaY: 3,
    deltaMode: 1,
  });
  expect(await area(page).evaluate((el) => el.scrollLeft)).toBe(before + 48);
  await area(page).dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    deltaY: -1,
    deltaMode: 2,
  });
  expect(await area(page).evaluate((el) => el.scrollLeft)).toBeLessThan(before);
  await button(page, "表示プレビュー").click();
  const fitted = await scale(page);
  const consumed = await area(page).evaluate(
    (el) =>
      !el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
        }),
      ),
  );
  expect(consumed).toBe(false);
  expect(await scale(page)).toBe(fitted);
});

test("zoom-out from a large drawing's tiny fit never enlarges it", async ({
  page,
}) => {
  await start(page);
  const sample = await import("../examples/minimal.project.json", {
    with: { type: "json" },
  });
  const project = structuredClone(sample.default);
  project.screens[0].width = 10000;
  project.screens[0].height = 5000;
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("fit");
  const fitted = await scale(page);
  expect(fitted).toBeLessThan(0.25);
  await hover(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  expect(await scale(page)).toBe(fitted);
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("fit");
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(() => scale(page)).toBe(0.25);
});
test("wheel cancels a selection box and keeps continuous placement armed without stamping", async ({
  page,
}) => {
  await start(page, 1);
  const points = await svg(page).evaluate((el) =>
    [
      { x: 80, y: 150 },
      { x: 730, y: 370 },
    ].map((p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform(
        (el as SVGSVGElement).getScreenCTM()!,
      );
      return { x: q.x, y: q.y };
    }),
  );
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
  await expect(page.getByTestId("selection-range")).toBeVisible();
  await page.mouse.wheel(0, 100);
  await expect(page.getByTestId("selection-range")).not.toBeVisible();
  await page.mouse.up();
  await expect(svg(page).locator('[data-selected="true"]')).toHaveCount(0);
  await button(page, "連続配置ツール").click();
  await button(page, "お気に入り：ポンプを配置").click();
  await hover(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(button(page, "連続配置ツール")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
