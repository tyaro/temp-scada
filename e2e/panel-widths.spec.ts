// #331 D2: 左右の幅は dock の divider が持つ。保存した幅（panel-widths）は最初の
// 配置にだけ使い、divider で変えた幅は保存しない（配置の自動保存と panel-widths の
// 撤去は D3）。ここでは divider の操作が入力・Project・履歴・表示の中心を変えないこと、
// 「パネルの幅を標準に戻す」、保存した幅を最初の配置に使うことを確かめる。
import { chooseMenuItem, fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
/** 根の横の分割の divider（0 = 左と中央の間、1 = 中央と右の間）。 */
const divider = (page: Page, side: "left" | "right") =>
  page
    .getByRole("separator", { name: "パネルのサイズ変更", exact: true })
    .nth(side === "left" ? 0 : 1);
const sidebar = (page: Page) =>
  page.locator("[data-designer-left-pane]:visible").first();
const inspector = (page: Page) => page.locator("#designer-inspector-panel");
const storageKey = "banto.ui.scada.designer.panel-widths";
async function width(page: Page, side: "left" | "right") {
  return (
    (await (side === "left" ? sidebar(page) : inspector(page)).boundingBox())
      ?.width ?? 0
  );
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await button(page, "編集").click();
}
async function drag(
  page: Page,
  side: "left" | "right",
  dx: number,
  cancel = false,
) {
  const bounds = (await divider(page, side).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + dx, bounds.y + 40, {
    steps: 12,
  });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
async function viewCenter(page: Page) {
  return page
    .getByRole("region", { name: "キャンバス操作領域" })
    .evaluate((el) => {
      const box = el.getBoundingClientRect();
      const point = new DOMPoint(
        box.left + el.clientLeft + el.clientWidth / 2,
        box.top + el.clientTop + el.clientHeight / 2,
      ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
      return { x: point.x, y: point.y };
    });
}
function near(value: number, expected: number, slack = 16) {
  expect(value).toBeGreaterThan(expected - slack);
  expect(value).toBeLessThan(expected + slack);
}

test("dragging dock dividers preserves drafts, Project and history", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#aabbcc");
  const layerSearch = page.getByLabel("レイヤーを検索", { exact: true });
  await layerSearch.fill("rectangle");
  const saveState = await page.getByTestId("save-state").innerText();
  const left = await width(page, "left"),
    right = await width(page, "right");
  await drag(page, "left", 100);
  await drag(page, "right", -80);
  await expect.poll(() => width(page, "left")).toBeGreaterThan(left + 80);
  await expect.poll(() => width(page, "right")).toBeGreaterThan(right + 60);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(layerSearch).toHaveValue("rectangle");
  await expect(
    page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
  ).toHaveValue("#aabbcc");
  expect(await page.getByTestId("save-state").innerText()).toBe(saveState);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#164e63");
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const saved = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  const original = JSON.parse(
    await readFile("examples/minimal.project.json", "utf8"),
  );
  expect(saved).toEqual(original);
});

for (const zoom of [0.25, 1, 4])
  test(`divider drags and cancellation keep the manual ${zoom * 100}% design center`, async ({
    page,
  }) => {
    await start(page);
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    const before = await viewCenter(page);
    await drag(page, "left", 120);
    await drag(page, "right", -120);
    await expect
      .poll(async () => Math.abs((await viewCenter(page)).x - before.x))
      .toBeLessThan(2 / zoom);
    await expect
      .poll(async () => Math.abs((await viewCenter(page)).y - before.y))
      .toBeLessThan(2 / zoom);
    const left = await width(page, "left");
    await drag(page, "left", -80, true);
    await expect.poll(() => width(page, "left")).toBeCloseTo(left, 0);
    await expect
      .poll(async () => Math.abs((await viewCenter(page)).x - before.x))
      .toBeLessThan(2 / zoom);
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      String(zoom),
    );
  });

test("the display menu restores standard widths without changing inputs or the arrangement", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面名", { exact: true }).fill("入力を保持");
  await drag(page, "left", 120);
  await drag(page, "right", -100);
  await selectPanel(page, "部品");
  await chooseMenuItem(page, "表示", "パネルの幅を標準に戻す");
  await expect.poll(() => width(page, "left")).toBeLessThan(240 + 16);
  near(await width(page, "left"), 240);
  near(await width(page, "right"), 288);
  await expect(
    page.getByRole("tab", { name: "部品", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "入力を保持",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("saved widths set the first arrangement and invalid ones fall back", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"left":360,"right":400}'),
    storageKey,
  );
  await start(page);
  near(await width(page, "left"), 360);
  near(await width(page, "right"), 400);
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"left":100000,"right":-10}'),
    storageKey,
  );
  await page.reload();
  await button(page, "編集").click();
  near(await width(page, "left"), 240);
  near(await width(page, "right"), 288);
});

test("switching to the narrow display during a drag leaves no error and the wide widths come back", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  const before = await width(page, "left");
  const bounds = (await divider(page, "left").boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 82, bounds.y + 40, { steps: 8 });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.mouse.up();
  await expect(page.locator('[data-dock-band-tab="left"]')).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(sidebar(page)).toBeVisible();
  expect(await width(page, "left")).toBeLessThan(before + 100);
  expect(errors).toEqual([]);
});
