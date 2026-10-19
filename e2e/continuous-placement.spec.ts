import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const canvas = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page, name = "プロセス画面") =>
  page.getByRole("img", { name, exact: true });
const status = (page: Page) =>
  page.getByRole("status", { name: "連続配置の状態", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "部品");
}
async function arm(page: Page, name = "Rectangle を追加") {
  await button(page, "連続配置ツール").click();
  await button(page, name).click();
  await expect(status(page)).toContainText("連続配置");
}
async function point(page: Page, x: number, y: number) {
  return svg(page).evaluate(
    (el, p) => {
      const v = new DOMPoint(p.x, p.y).matrixTransform(
        (el as SVGSVGElement).getScreenCTM()!,
      );
      return { x: v.x, y: v.y };
    },
    { x, y },
  );
}
async function clickAt(page: Page, x: number, y: number, alt = false) {
  // Native scroll restoration and ResizeObserver must settle before taking fixed coordinates.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const p = await point(page, x, y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.click(p.x, p.y);
  if (alt) await page.keyboard.up("Alt");
}
for (const zoom of [0.25, 1, 4])
  test(`continuous placement at ${zoom * 100}% keeps coordinates, snapping, one-step undo and Escape`, async ({
    page,
  }) => {
    await start(page);
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    await arm(page);
    await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
    await page.getByLabel("グリッドにスナップ", { exact: true }).check();
    await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
    if (zoom === 4)
      await canvas(page).evaluate((el) => {
        el.scrollLeft = 200;
        el.scrollTop = 400;
      });
    await clickAt(page, 173, 213);
    await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
    expect(
      Number(await page.getByLabel("x", { exact: true }).inputValue()) +
        Number(await page.getByLabel("width", { exact: true }).inputValue()) /
          2,
    ).toBeCloseTo(180, 4);
    expect(
      Number(await page.getByLabel("y", { exact: true }).inputValue()) +
        Number(await page.getByLabel("height", { exact: true }).inputValue()) /
          2,
    ).toBeCloseTo(220, 4);
    await expect(button(page, "連続配置ツール")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await clickAt(page, 213, 253, true);
    await expect(svg(page).locator("[data-object-id]")).toHaveCount(5);
    expect(
      Math.abs(
        Number(await page.getByLabel("x", { exact: true }).inputValue()) +
          Number(await page.getByLabel("width", { exact: true }).inputValue()) /
            2 -
          213,
      ),
    ).toBeLessThan(2 / zoom);
    await button(page, "元に戻す").click();
    await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
    await expect(status(page)).toBeVisible();
    await canvas(page).focus();
    await canvas(page).press("Escape");
    await expect(status(page)).toHaveCount(0);
    await expect(button(page, "選択ツール")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
test("continuous placement protects pending text and invalid numbers, and does not drag the selected object", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await page.getByLabel("テキスト", { exact: true }).fill("保持する入力");
  await selectPanel(page, "部品");
  await arm(page);
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await clickAt(page, 160, 90);
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await clickAt(page, 160, 90);
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await page.getByLabel("width", { exact: true }).fill("0");
  await clickAt(page, 300, 300);
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("0");
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await page.getByLabel("width", { exact: true }).press("Escape");
  await clickAt(page, 300, 300);
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(5);
});
test("palette and dock context actions arm placement; pan, Enter and tool cancellation share existing navigation", async ({
  page,
}) => {
  await start(page);
  await button(page, "ポンプを追加").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "クリック位置へ連続配置", exact: true })
    .click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await expect(canvas(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await expect(canvas(page)).toBeFocused();
  await page.keyboard.down("Space");
  const p = await point(page, 500, 350);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 20, p.y - 20);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await expect(status(page)).toBeVisible();
  await canvas(page).click({ button: "right" });
  await expect(status(page)).toHaveCount(0);
  await expect(
    page.getByRole("menu", { name: "キャンバス の操作", exact: true }),
  ).not.toBeVisible();
  const dock = page.getByRole("region", {
    name: "お気に入り部品",
    exact: true,
  });
  await dock
    .getByRole("button", { name: "お気に入り：テキストを配置", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "クリック位置へ連続配置", exact: true })
    .click();
  await expect(status(page)).toContainText("テキスト");
  await button(page, "パンツール").click();
  await expect(status(page)).toHaveCount(0);
});
test("switching target or reimporting the same Project ends placement and shared-definition editing only accepts basic parts", async ({
  page,
}) => {
  await start(page);
  await arm(page);
  await selectPanel(page, "プロジェクト");
  await button(page, "画面を追加").click();
  await expect(status(page)).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "画面タブ" })
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "部品");
  await arm(page, "Text を追加");
  await canvas(page).focus();
  await canvas(page).press("Enter");
  await expect(button(page, "ポンプを追加")).toHaveCount(0);
  await button(page, "画面へ戻る").click();
  await expect(status(page)).toHaveCount(0);
  await selectPanel(page, "部品");
  await arm(page);
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const path = await (await download).path();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles(path!);
  await expect(status(page)).toHaveCount(0);
});

test("margin clicks, pointer cancellation and drag gestures never place or edit existing objects", async ({
  page,
}) => {
  await start(page);
  await arm(page);
  await canvas(page).click({ position: { x: 12, y: 60 } });
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  const p = await point(page, 130, 200),
    q = await point(page, 220, 250);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y);
  await page.mouse.up();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await canvas(page).dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await clickAt(page, 300, 300);
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
});
test("composition blocks placement and Undo removing an armed shared definition ends the tool", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await selectPanel(page, "部品");
  await arm(page);
  const x = page.getByLabel("x", { exact: true });
  await x.focus();
  await x.dispatchEvent("compositionstart");
  await x.fill("125");
  await clickAt(page, 400, 300);
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await x.dispatchEvent("compositionend");
  await x.press("Enter");
  await clickAt(page, 400, 300);
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await canvas(page).focus();
  await canvas(page).press("Escape");
  await button(page, "ポンプを追加").click();
  await button(page, "ポンプ を配置").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "クリック位置へ連続配置", exact: true })
    .click();
  await expect(status(page)).toContainText("共有定義");
  await button(page, "元に戻す").click();
  await expect(status(page)).toHaveCount(0);
  await expect(svg(page).locator("[data-symbol-id]")).toHaveCount(0);
});

test("waiting for a part cannot move existing objects, and narrow layouts keep the active tool and status readable", async ({
  page,
}) => {
  await start(page);
  await button(page, "連続配置ツール").click();
  const p = await point(page, 130, 200),
    q = await point(page, 230, 250);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y);
  await page.mouse.up();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(status(page)).toContainText("部品を選んでください");
  await button(page, "Rectangle を追加").click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(status(page)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await button(page, "配置を終了 Esc").click();
  await expect(status(page)).toHaveCount(0);
  await expect(canvas(page)).toBeFocused();
});
