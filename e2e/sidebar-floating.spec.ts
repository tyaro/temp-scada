import { test, expect, type Page } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";
const key = "banto.ui.scada.designer.sidebar-placement";
const inspectorKey = "banto.ui.scada.designer.inspector-placement";
const panel = (page: Page) => page.locator("#designer-project-panel");
const inspector = (page: Page) => page.locator("#designer-inspector-panel");
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function menu(page: Page, name: string) {
  await button(page, "メニュー").click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await menu(page, "作業パネルを前面に表示");
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
}
async function float(page: Page) {
  await menu(page, "作業パネルを浮動にする");
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
}
async function move(page: Page, dx: number, dy: number, cancel = false) {
  const b = (await button(page, "作業パネルを移動").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, {
    steps: 5,
  });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
for (const theme of ["light", "dark"])
  test(`same sidebar DOM, tab searches and both panels' drafts survive placement in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    const x = page.getByLabel("x", { exact: true });
    await x.fill("1e");
    await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#aabbcc");
    await selectPanel(page, "部品");
    const search = page.getByRole("searchbox", { name: /検索/ });
    await search.fill("ポンプ");
    const searchRef = await search.elementHandle();
    await selectPanel(page, "プロジェクト");
    const name = page.getByLabel("画面名", { exact: true });
    await name.fill("未適用の画面名");
    const input = await name.elementHandle(),
      form = await name.evaluateHandle((el) => el.closest("form")),
      root = await panel(page).elementHandle();
    const dirty = await page.getByTestId("save-state").innerText();
    const before = await page
      .getByRole("region", { name: "キャンバス操作領域" })
      .boundingBox();
    await float(page);
    const after = await page
      .getByRole("region", { name: "キャンバス操作領域" })
      .boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width);
    await move(page, 250, 40);
    await menu(page, "作業パネルを左へ戻す");
    await button(page, "左パネルを隠す").click();
    await expect(panel(page)).toBeHidden();
    await menu(page, "左パネルを表示");
    await menu(page, "標準レイアウトに戻す");
    expect(await panel(page).evaluate((el, old) => el === old, root)).toBe(
      true,
    );
    expect(await name.evaluate((el, old) => el === old, input)).toBe(true);
    expect(
      await name.evaluate((el, old) => el.closest("form") === old, form),
    ).toBe(true);
    await expect(name).toHaveValue("未適用の画面名");
    await expect(x).toHaveValue("1e");
    await selectPanel(page, "部品");
    await expect(search).toHaveValue("ポンプ");
    expect(await search.evaluate((el, old) => el === old, searchRef)).toBe(
      true,
    );
    expect(await page.getByTestId("save-state").innerText()).toBe(dirty);
    await expect(button(page, "元に戻す")).toBeDisabled();
  });
test("independent saved slots survive preview, narrow fallback, standard restoration and reload", async ({
  page,
}) => {
  await start(page);
  await float(page);
  await move(page, 230, 20);
  await menu(page, "作業パネル配置を保存");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .not.toBeNull();
  const saved = await page.evaluate((key) => localStorage.getItem(key), key),
    rect = await panel(page).boundingBox();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), inspectorKey),
  ).toBeNull();
  await button(page, "表示プレビュー").click();
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  await expect(
    page.getByRole("navigation", { name: "画面一覧" }),
  ).toBeVisible();
  await button(page, "編集").click();
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  expect(await panel(page).boundingBox()).toEqual(rect);
  await menu(page, "標準レイアウトに戻す");
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  await button(page, "左パネルを隠す").click();
  await menu(page, "保存した作業パネル配置に戻す");
  await expect(panel(page)).toBeVisible();
  expect(await panel(page).boundingBox()).toEqual(rect);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    saved,
  );
  await page.reload();
  await button(page, "編集").click();
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  expect(await panel(page).boundingBox()).toEqual(rect);
});
test("overlapping panels raise by pointer and focus without replacing input DOM", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, inspectorKey }) => {
      for (const [storageKey, panelId, x] of [
        [key, "sidebar", 500],
        [inspectorKey, "inspector", 650],
      ] as const)
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            layoutVersion: 1,
            panelId,
            mode: "floating",
            rect: { x, y: 150, width: 320, height: 650 },
          }),
        );
    },
    { key, inspectorKey },
  );
  await start(page);
  await selectPanel(page, "プロジェクト");
  const name = page.getByLabel("画面名", { exact: true }),
    x = page.getByLabel("x", { exact: true });
  await name.fill("未適用");
  await x.focus();
  await x.fill("1e");
  const ref = await x.elementHandle();
  await panel(page).focus();
  await page.keyboard.press("Tab");
  const rank = async (el: ReturnType<typeof panel>) =>
    Number(await el.evaluate((el) => getComputedStyle(el).zIndex));
  expect(await rank(panel(page))).toBeGreaterThan(await rank(inspector(page)));
  await x.focus();
  expect(await rank(inspector(page))).toBeGreaterThan(await rank(panel(page)));
  await expect(name).toHaveValue("未適用");
  await expect(x).toHaveValue("1e");
  expect(await x.evaluate((el, old) => el === old, ref)).toBe(true);
  await menu(page, "作業パネルを前面に表示");
  expect(await rank(panel(page))).toBeGreaterThan(await rank(inspector(page)));
  await menu(page, "プロパティを前面に表示");
  expect(await rank(inspector(page))).toBeGreaterThan(await rank(panel(page)));
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("keyboard resize and cancelled pointer moves retain focused draft and Project", async ({
  page,
}) => {
  await start(page);
  await float(page);
  const before = await panel(page).boundingBox();
  const x = page.getByLabel("x", { exact: true });
  await x.fill("1e");
  await x.focus();
  await move(page, 150, 35, true);
  expect(await panel(page).boundingBox()).toEqual(before);
  await expect(x).toBeFocused();
  await expect(x).toHaveValue("1e");
  const resize = button(page, "作業パネルのサイズを変更");
  await resize.focus();
  await resize.press("Enter");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const after = await panel(page).boundingBox();
  expect(after!.width).toBe(before!.width + 32);
  expect(after!.height).toBe(before!.height + 8);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("failed sidebar save keeps the previous independent slot", async ({
  page,
}) => {
  await start(page);
  await float(page);
  await menu(page, "作業パネル配置を保存");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .not.toBeNull();
  const saved = await page.evaluate((key) => localStorage.getItem(key), key),
    old = await panel(page).boundingBox();
  await move(page, 100, 20);
  const current = await panel(page).boundingBox();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("unavailable");
    };
  });
  await menu(page, "作業パネル配置を保存");
  await expect(page.locator(".toast-host")).toContainText(
    "作業パネルの配置を保存できません",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    saved,
  );
  expect(await panel(page).boundingBox()).toEqual(current);
  await menu(page, "保存した作業パネル配置に戻す");
  expect(await panel(page).boundingBox()).toEqual(old);
});
test("floating parts still drag onto the canvas and undo independently of panel placement", async ({
  page,
}) => {
  await start(page);
  await float(page);
  await selectPanel(page, "部品");
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  const target = (await canvas.boundingBox())!;
  const before = await panel(page).boundingBox();
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .dragTo(canvas, {
      targetPosition: { x: target.width * 0.6, y: target.height / 2 },
    });
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(4);
  expect(await panel(page).boundingBox()).toEqual(before);
  await button(page, "元に戻す").click();
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(3);
  expect(await panel(page).boundingBox()).toEqual(before);
});
test("one panel owns the gesture and viewport changes cancel without waiting for resize delivery", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.addEventListener(
      "resize",
      (event) => event.stopImmediatePropagation(),
      { capture: true },
    ),
  );
  await start(page);
  await float(page);
  await menu(page, "プロパティを浮動にする");
  await move(page, 0, 100);
  const before = await panel(page).boundingBox();
  const grip = button(page, "作業パネルを移動"),
    b = (await grip.boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 150, b.y + 40);
  await button(page, "プロパティパネルを移動").dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 99,
    clientX: 1600,
    clientY: 130,
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await panel(page).boundingBox()).toEqual(before);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.mouse.move(b.x + 30, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 100, b.y + 30);
  await page.setViewportSize({ width: 1800, height: 1080 });
  await page.mouse.up();
  expect(await panel(page).boundingBox()).toEqual(before);
});
