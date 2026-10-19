import { test, expect, type Page, type Locator } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
const selected = (page: Page) =>
  svg(page).locator('[data-object-id][data-selected="true"]');
async function start(page: Page, zoom = 1) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption(String(zoom));
}
async function coordinates(canvas: Locator, point: { x: number; y: number }) {
  return canvas.evaluate((el, p) => {
    const r = new DOMPoint(p.x, p.y).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!,
    );
    return { x: r.x, y: r.y };
  }, point);
}
async function range(
  page: Page,
  from = { x: 80, y: 150 },
  to = { x: 730, y: 370 },
  options: { shift?: boolean; cancel?: boolean; hold?: boolean } = {},
) {
  const a = await coordinates(svg(page), from),
    b = await coordinates(svg(page), to);
  if (options.shift) await page.keyboard.down("Shift");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  if (options.cancel) await page.keyboard.press("Escape");
  if (!options.hold) await page.mouse.up();
  if (options.shift) await page.keyboard.up("Shift");
}
for (const zoom of [0.25, 1, 4])
  test(`range selection at ${zoom * 100}% selects complete bounds without Project edits`, async ({
    page,
  }) => {
    await start(page, zoom);
    // Bring the desired area into view at high zoom without changing design coordinates.
    if (zoom === 4) {
      await button(page, "ミニマップで表示位置を移動").click({
        position: { x: 80, y: 33 },
      });
    }
    // At 400%, use a smaller range around the ellipse only, fitting in the viewport.
    const from = zoom === 4 ? { x: 560, y: 180 } : { x: 80, y: 150 };
    const to = zoom === 4 ? { x: 720, y: 340 } : { x: 730, y: 370 };
    await range(page, from, to);
    await expect(selected(page)).toHaveCount(zoom === 4 ? 1 : 2);
    await expect(button(page, "元に戻す")).toBeDisabled();
    await expect(page.getByTestId("save-state")).toContainText(
      "サンプルからの変更なし",
    );
    await expect(page.getByTestId("selection-range")).not.toBeVisible();
  });
test("reverse drag, Shift union, empty clicks and cancellation preserve existing selection", async ({
  page,
}) => {
  await start(page);
  await range(page, { x: 730, y: 370 }, { x: 80, y: 150 });
  await expect(selected(page)).toHaveCount(2);
  await range(page, { x: 80, y: 50 }, { x: 620, y: 125 }, { shift: true });
  await expect(selected(page)).toHaveCount(3);
  await range(page, { x: 800, y: 400 }, { x: 850, y: 450 }, { cancel: true });
  await expect(selected(page)).toHaveCount(3);
  await range(page, { x: 800, y: 400 }, { x: 850, y: 450 }, { shift: true });
  await expect(selected(page)).toHaveCount(3);
  await range(page, { x: 800, y: 400 }, { x: 801, y: 401 });
  await expect(selected(page)).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("range selection respects staged input and a cancelled confirmation keeps the selection", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await page.getByLabel("テキスト", { exact: true }).fill("保持する入力");
  await range(page);
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(selected(page)).toHaveCount(1);
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await range(page);
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(selected(page)).toHaveCount(2);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("pointer cancellation and scrolling cancel the box; pan, preview and placement retain their own interaction", async ({
  page,
}) => {
  await start(page);
  await range(page, undefined, undefined, { hold: true });
  await expect(page.getByTestId("selection-range")).toBeVisible();
  await page
    .getByRole("region", { name: "キャンバス操作領域" })
    .dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(selected(page)).toHaveCount(0);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  await range(page, { x: 800, y: 400 }, { x: 850, y: 450 }, { hold: true });
  await expect(page.getByTestId("selection-range")).toBeVisible();
  await page
    .getByRole("region", { name: "キャンバス操作領域" })
    .evaluate((el) => {
      el.scrollLeft += 40;
    });
  await expect(page.getByTestId("selection-range")).not.toBeVisible();
  await page.mouse.up();
  await expect(selected(page)).toHaveCount(0);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
  await button(page, "パンツール").click();
  await range(page);
  await expect(selected(page)).toHaveCount(0);
  await button(page, "選択ツール").click();
  await button(page, "連続配置ツール").click();
  await range(page);
  await expect(selected(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await button(page, "表示プレビュー").click();
  await range(page);
  await expect(page.getByTestId("selection-range")).not.toBeVisible();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
});

test("range selection in shared-definition editing selects children without adding history", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  const definition = page.getByRole("img", { name: "ポンプ", exact: true });
  await expect(definition.locator("[data-object-id]")).toHaveCount(5);
  const before = await page.getByTestId("save-state").innerText();
  const a = await coordinates(definition, { x: 0, y: 0 }),
    b = await coordinates(definition, { x: 100, y: 100 });
  await page.mouse.move(a.x + 1, a.y + 1);
  await page.mouse.down();
  await page.mouse.move(b.x - 1, b.y - 1, { steps: 5 });
  await page.mouse.up();
  // Two pipe ends extend beyond the canvas once their stroke is included.
  await expect(definition.locator('[data-selected="true"]')).toHaveCount(3);
  expect(await page.getByTestId("save-state").innerText()).toBe(before);
  await button(page, "元に戻す").click();
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toBeVisible();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
});
