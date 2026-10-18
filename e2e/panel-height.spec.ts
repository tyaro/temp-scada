import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme } from "./helpers/designer";
import sample from "../examples/tag-binding.project.json" with { type: "json" };
const storageKey = "banto.ui.scada.designer.reference-height";
const divider = (page: Page) =>
  page.getByRole("separator", { name: "タグ参照パネルの高さ", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/");
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles("examples/tag-binding.project.json");
  await button(page, "編集").click();
  await page.locator("details.references > summary").click();
  await expect(divider(page)).toBeVisible();
}
async function menu(page: Page, name: string) {
  await button(page, "メニュー").click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function drag(page: Page, dy: number, cancel = false) {
  const box = (await divider(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, {
    steps: 12,
  });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
async function center(page: Page) {
  return viewport(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const point = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
}

test("height resize preserves drafts, search and Project while persisting only UI preferences", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面名", { exact: true }).fill("未適用");
  await page.getByLabel("タグ参照を検索", { exact: true }).fill("Tank");
  const state = await page.getByTestId("save-state").innerText();
  await drag(page, -48);
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "288");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用",
  );
  await expect(page.getByLabel("タグ参照を検索", { exact: true })).toHaveValue(
    "Tank",
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect(await page.getByTestId("save-state").innerText()).toBe(state);
  await menu(page, "タグ参照一覧を隠す");
  await expect(divider(page)).toHaveCount(0);
  await menu(page, "タグ参照一覧を表示");
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "288");
  await expect(page.getByLabel("タグ参照を検索", { exact: true })).toHaveValue(
    "Tank",
  );
  await page.getByLabel("画面名", { exact: true }).fill(sample.screens[0].name);
  const download = page.waitForEvent("download");
  await button(page, "Project JSON を保存").click();
  expect(
    JSON.parse(await readFile((await (await download).path())!, "utf8")),
  ).toEqual(sample);
  await page.reload();
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles("examples/tag-binding.project.json");
  await button(page, "編集").click();
  await page.locator("details.references > summary").click();
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "288");
});
for (const zoom of [0.25, 1, 4])
  test(`resizing and cancelling retain the design center at ${zoom * 100}%`, async ({
    page,
  }) => {
    await start(page);
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    const before = await center(page);
    await drag(page, -40);
    for (const axis of ["x", "y"] as const)
      await expect
        .poll(async () => Math.abs((await center(page))[axis] - before[axis]))
        .toBeLessThan(2 / zoom);
    await drag(page, 45, true);
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "280");
    for (const axis of ["x", "y"] as const)
      await expect
        .poll(async () => Math.abs((await center(page))[axis] - before[axis]))
        .toBeLessThan(2 / zoom);
    await page.locator("details.references > summary").click();
    await expect(divider(page)).toHaveCount(0);
    for (const axis of ["x", "y"] as const)
      await expect
        .poll(async () => Math.abs((await center(page))[axis] - before[axis]))
        .toBeLessThan(2 / zoom);
  });
for (const theme of ["light", "dark"] as const)
  test(`keyboard, responsive limits and recovery work in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await divider(page).focus();
    await page.keyboard.press("Shift+ArrowUp");
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "272");
    await page.keyboard.press("Home");
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "160");
    await page.keyboard.press("End");
    const preferred = await divider(page).getAttribute("aria-valuenow");
    await page.setViewportSize({ width: 1600, height: 850 });
    await expect(divider(page)).toBeVisible();
    await expect
      .poll(async () =>
        Number(await divider(page).getAttribute("aria-valuenow")),
      )
      .toBeLessThan(Number(preferred));
    expect((await viewport(page).boundingBox())!.height).toBeGreaterThanOrEqual(
      280,
    );
    await page.setViewportSize({ width: 1600, height: 1100 });
    await expect(divider(page)).toHaveAttribute("aria-valuenow", preferred!);
    await divider(page).focus();
    await page.keyboard.press("Enter");
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "240");
    await drag(page, -24);
    await menu(page, "タグ参照パネルの高さを標準に戻す");
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "240");
    await page.setViewportSize({ width: 1600, height: 650 });
    await expect(divider(page)).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(divider(page)).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1600, height: 1100 });
    await expect(divider(page)).toHaveAttribute("aria-valuenow", "240");
    await button(page, "表示プレビュー").click();
    await expect(divider(page)).toHaveCount(0);
  });
test("corrupt preferences and failed storage leave usable resizing; narrowing cancels a drag", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (key) => localStorage.setItem(key, "-50"),
    storageKey,
  );
  await start(page);
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "240");
  const box = (await divider(page).boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y - 36);
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.mouse.up();
  await page.setViewportSize({ width: 1600, height: 1100 });
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "240");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await drag(page, -24);
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "264");
  await expect(
    page.getByText(
      "タグ参照パネルの高さを保存できません。このタブだけに適用します。",
      { exact: true },
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("long reference lists scroll within the resized panel and keep every usage reachable", async ({
  page,
}) => {
  await start(page);
  const many = structuredClone(sample);
  const template = many.screens[0].objects[2];
  for (let i = 0; i < 35; i++) {
    const object = structuredClone(template);
    object.id = `0199f000-0000-7000-8000-${(100 + i).toString().padStart(12, "0")}`;
    object.order = i + 6;
    object.shape = {
      type: "text",
      text: `液位 ${i}`,
      binding: {
        externalName: `PLC01.Fast.Tank${String(i).padStart(2, "0")}.Level`,
      },
    } as typeof template.shape;
    many.screens[0].objects.push(object);
  }
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "many.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(many)),
  });
  // 読込前の開閉状態に依存せず、この Project の一覧を開く。
  await page
    .locator("details.references")
    .evaluate((el: HTMLDetailsElement) => {
      if (!el.open) el.querySelector("summary")!.click();
    });
  await expect(divider(page)).toBeVisible();
  await divider(page).focus();
  await page.keyboard.press("Home");
  const panel = page.locator("details.references");
  await expect
    .poll(() => panel.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  const last = panel.getByRole("button", {
    name: `${many.screens[0].name} の Text 40 を編集`,
    exact: true,
  });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await last.click();
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("PLC01.Fast.Tank34.Level");
  await expect(divider(page)).toHaveAttribute("aria-valuenow", "160");
  expect((await viewport(page).boundingBox())!.height).toBeGreaterThanOrEqual(
    280,
  );
});
