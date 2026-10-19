import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const map = (page: Page) => button(page, "ミニマップで表示位置を移動");
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
}
async function center(page: Page) {
  return viewport(page).evaluate((el) => {
    const svg = el.querySelector<SVGSVGElement>(".sheet > svg")!;
    const box = el.getBoundingClientRect();
    const p = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  });
}
test("minimap navigates at manual zoom without editing and Enter fits the whole sheet", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await map(page).click({ position: { x: 80, y: 40 } });
  const first = await center(page);
  const target = await map(page).evaluate((el) => {
    const sheet = el.querySelector("svg")!.viewBox.baseVal;
    return {
      x: (80 / el.clientWidth) * sheet.width,
      y: (40 / el.clientHeight) * sheet.height,
    };
  });
  expect(Math.abs(first.x - target.x)).toBeLessThan(1);
  expect(Math.abs(first.y - target.y)).toBeLessThan(1);
  const before = await map(page).locator(".outline rect").getAttribute("x");
  await map(page).press("ArrowLeft");
  await expect
    .poll(async () => (await center(page)).x)
    .toBeLessThan(first.x - 10);
  await expect(map(page).locator(".outline rect")).not.toHaveAttribute(
    "x",
    before!,
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toHaveCount(1);
  await map(page).press("Enter");
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("fit");
  const fitted = await center(page);
  await map(page).click({ position: { x: 10, y: 10 } });
  const after = await center(page);
  expect(after.x).toBeCloseTo(fitted.x, 1);
  expect(after.y).toBeCloseTo(fitted.y, 1);
});
test("minimap drag can be cancelled with Escape and does not move or select objects", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await map(page).click({ position: { x: 60, y: 35 } });
  const original = await center(page),
    box = (await map(page).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 45, { steps: 4 });
  await expect
    .poll(async () => (await center(page)).x)
    .toBeGreaterThan(original.x + 20);
  await map(page).press("Escape");
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await center(page)).x - original.x))
    .toBeLessThan(1);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("minimap preserves text drafts and continuous placement without stamping", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await page.getByLabel("テキスト", { exact: true }).fill("保持する入力");
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await map(page).click({ position: { x: 60, y: 35 } });
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.reload();
  await button(page, "編集").click();
  await button(page, "連続配置ツール").click();
  await button(page, "お気に入り：ポンプを配置").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await map(page).click({ position: { x: 80, y: 35 } });
  await expect(button(page, "連続配置ツール")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("minimap visibility persists, can be recovered from View and is hidden in preview", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "ミニマップを隠す", exact: true })
    .click();
  await expect(map(page)).not.toBeVisible();
  await page.reload();
  await button(page, "編集").click();
  await expect(map(page)).not.toBeVisible();
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "ミニマップを表示", exact: true })
    .click();
  await expect(map(page)).toBeVisible();
  await button(page, "表示プレビュー").click();
  await expect(map(page)).not.toBeVisible();
});

test("minimap follows screen and definition targets and mirrors scrollbar navigation", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  const rect = map(page).locator(".outline rect");
  const first = await rect.getAttribute("x");
  await viewport(page).evaluate((el) => {
    el.scrollLeft += 200;
  });
  await expect(rect).not.toHaveAttribute("x", first!);
  await button(page, "画面を追加").click();
  await expect(
    page
      .getByRole("region", { name: "ミニマップ", exact: true })
      .locator(".thumbnail svg")
      .first(),
  ).toHaveAttribute("aria-label", "画面 2");
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await expect(
    page
      .getByRole("region", { name: "ミニマップ", exact: true })
      .locator(".thumbnail svg")
      .first(),
  ).toHaveAttribute("aria-label", "ポンプ");
  await map(page).press("Enter");
  await button(page, "画面へ戻る").click();
  await expect(
    page
      .getByRole("region", { name: "ミニマップ", exact: true })
      .locator(".thumbnail svg")
      .first(),
  ).toHaveAttribute("aria-label", "画面 2");
});
