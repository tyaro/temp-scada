import { fileCommand, selectPanel, chooseTheme } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const divider = (page: Page, side: "left" | "right") =>
  page.getByRole("separator", {
    name: side === "left" ? "左パネルの幅" : "プロパティの幅",
    exact: true,
  });
const storageKey = "banto.ui.scada.designer.panel-widths";
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

test("dragging panel borders preserves drafts and saves widths separately from Project and history", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("色", { exact: true }).fill("#aabbcc");
  await selectPanel(page, "プロジェクト");
  await page.getByLabel("画面名", { exact: true }).fill("未適用の画面名");
  const saveState = await page.getByTestId("save-state").innerText();
  await drag(page, "left", 100);
  await drag(page, "right", -80);
  await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "340");
  await expect(divider(page, "right")).toHaveAttribute("aria-valuenow", "368");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の画面名",
  );
  await expect(page.getByLabel("色", { exact: true })).toHaveValue("#aabbcc");
  expect(await page.getByTestId("save-state").innerText()).toBe(saveState);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("画面名", { exact: true }).fill("プロセス画面");
  await page.getByLabel("色", { exact: true }).fill("#164e63");
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const saved = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  const original = JSON.parse(
    await readFile("examples/minimal.project.json", "utf8"),
  );
  expect(saved).toEqual(original);
  await page.reload();
  await button(page, "編集").click();
  await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "340");
  await expect(divider(page, "right")).toHaveAttribute("aria-valuenow", "368");
});

for (const zoom of [0.25, 1, 4])
  test(`width adjustments and cancellation keep the manual ${zoom * 100}% design center`, async ({
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
    await drag(page, "left", -80, true);
    await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "360");
    await expect
      .poll(async () => Math.abs((await viewCenter(page)).x - before.x))
      .toBeLessThan(2 / zoom);
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      String(zoom),
    );
  });

test("keyboard resizing is bounded and the display menu restores standard widths without changing inputs", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面名", { exact: true }).fill("入力を保持");
  const left = divider(page, "left"),
    right = divider(page, "right");
  await left.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(left).toHaveAttribute("aria-valuenow", "272");
  await page.keyboard.press("Home");
  await expect(left).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("End");
  await expect(left).toHaveAttribute("aria-valuenow", "400");
  await page.keyboard.press("Enter");
  await expect(left).toHaveAttribute("aria-valuenow", "240");
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(right).toHaveAttribute("aria-valuenow", "296");
  await button(page, "メニュー").click();
  await page
    .getByRole("menuitem", { name: "パネルの幅を標準に戻す", exact: true })
    .click();
  await expect(right).toHaveAttribute("aria-valuenow", "288");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "入力を保持",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const)
  test(`saved widths constrain responsively in ${theme}, disappear with panels and survive narrow layouts`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await drag(page, "left", 160);
    await drag(page, "right", -152);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "308");
    await expect(divider(page, "right")).toHaveAttribute(
      "aria-valuenow",
      "352",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1100);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("separator", { name: /幅$/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "400");
    await expect(divider(page, "right")).toHaveAttribute(
      "aria-valuenow",
      "440",
    );
    await button(page, "プロパティを隠す").click();
    await expect(divider(page, "right")).toHaveCount(0);
    await button(page, "メニュー").click();
    await page
      .getByRole("menuitem", { name: "補助パネルをすべて隠す", exact: true })
      .click();
    await expect(page.getByRole("separator", { name: /幅$/ })).toHaveCount(0);
    await button(page, "表示プレビュー").click();
    await expect(page.getByRole("separator", { name: /幅$/ })).toHaveCount(0);
  });

test("invalid stored widths fall back and storage failures still allow session resizing", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"left":100000,"right":-10}'),
    storageKey,
  );
  await start(page);
  await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "240");
  await expect(divider(page, "right")).toHaveAttribute("aria-valuenow", "288");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("storage unavailable");
    };
  });
  await drag(page, "left", 80);
  await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "320");
  await expect(page.locator(".toast-host")).toContainText(
    "パネルの幅を保存できません",
  );
});

test("switching to a narrow layout during a drag cancels the temporary width", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  const bounds = (await divider(page, "left").boundingBox())!;
  await page.mouse.move(bounds.x + 4, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 84, bounds.y + 40, { steps: 8 });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.mouse.up();
  await expect(page.getByRole("separator", { name: /幅$/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(divider(page, "left")).toHaveAttribute("aria-valuenow", "240");
  expect(errors).toEqual([]);
});
