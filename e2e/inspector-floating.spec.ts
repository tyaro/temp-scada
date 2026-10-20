import { test, expect, type Page } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";
const key = "banto.ui.scada.designer.inspector-placement";
const panel = (page: Page) => page.locator("#designer-inspector-panel");
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
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
}
async function float(page: Page) {
  await menu(page, "プロパティを浮動にする");
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
}
async function move(page: Page, dx: number, dy: number, cancel = false) {
  const b = (await button(page, "プロパティパネルを移動").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, {
    steps: 5,
  });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
for (const theme of ["light", "dark"])
  test(`same DOM and staged forms survive floating, docking, hiding and standard restore in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    const x = page.getByLabel("x", { exact: true }),
      paint = page.getByLabel(/^(?:色|塗りの色)$/, { exact: true });
    await x.fill("1e");
    await paint.fill("#aabbcc");
    await selectPanel(page, "プロジェクト");
    await page.getByLabel("画面名", { exact: true }).fill("未適用の画面名");
    const ref = await x.elementHandle(),
      form = await x.evaluateHandle((el) => el.closest("form")),
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
    await move(page, -220, 30);
    await menu(page, "プロパティを右へ戻す");
    await panel(page)
      .getByRole("button", { name: "プロパティを隠す", exact: true })
      .click();
    await expect(panel(page)).toBeHidden();
    await menu(page, "プロパティを表示");
    await menu(page, "標準レイアウトに戻す");
    expect(await x.evaluate((el, old) => el === old, ref)).toBe(true);
    expect(
      await x.evaluate((el, old) => el.closest("form") === old, form),
    ).toBe(true);
    expect(await panel(page).evaluate((el, old) => el === old, root)).toBe(
      true,
    );
    await expect(x).toHaveValue("1e");
    await expect(paint).toHaveValue("#aabbcc");
    await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
      "未適用の画面名",
    );
    expect(await page.getByTestId("save-state").innerText()).toBe(dirty);
    await expect(button(page, "元に戻す")).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
test("pointer move and resize preserve focused numeric draft; Escape only cancels placement", async ({
  page,
}) => {
  await start(page);
  await float(page);
  const x = page.getByLabel("x", { exact: true });
  await x.fill("125.5");
  const before = (await panel(page).boundingBox())!;
  await move(page, -120, 20, true);
  await expect(x).toBeFocused();
  await expect(x).toHaveValue("125.5");
  expect(await panel(page).boundingBox()).toEqual(before);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await move(page, -160, 40);
  await expect(x).toBeFocused();
  const b = (await button(
    page,
    "プロパティパネルのサイズを変更",
  ).boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 90, b.y + 50, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await panel(page).boundingBox())!.width)
    .toBe(before.width + 80);
  await expect(x).toBeFocused();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await x.press("Tab");
  await expect(button(page, "元に戻す")).toBeEnabled();
  await button(page, "元に戻す").click();
  await expect(x).toHaveValue("100");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("keyboard placement commits, cancels, tabs freely and yields Escape to menu", async ({
  page,
}) => {
  await start(page);
  await float(page);
  const grip = button(page, "プロパティパネルを移動");
  const before = (await panel(page).boundingBox())!;
  await grip.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  expect(await panel(page).boundingBox()).toEqual(before);
  await grip.press("Space");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  expect((await panel(page).boundingBox())!.x).toBe(before.x - 8);
  await grip.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(grip).not.toBeFocused();
  expect((await panel(page).boundingBox())!.y).toBe(before.y + 8);
  await button(page, "プロパティの配置").click();
  await expect(
    page.getByRole("menu", { name: "プロパティの配置" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menu", { name: "プロパティの配置" }),
  ).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("explicit save, narrow fallback, standard restore, reload and hidden recovery keep the saved slot", async ({
  page,
}) => {
  await start(page);
  await float(page);
  await move(page, -240, 24);
  await menu(page, "プロパティ配置を保存");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .not.toBeNull();
  const saved = await page.evaluate((key) => localStorage.getItem(key), key),
    rect = await panel(page).boundingBox();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    saved,
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  expect(await panel(page).boundingBox()).toEqual(rect);
  await menu(page, "標準レイアウトに戻す");
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    saved,
  );
  await panel(page)
    .getByRole("button", { name: "プロパティを隠す", exact: true })
    .click();
  await menu(page, "保存したプロパティ配置に戻す");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  expect(await panel(page).boundingBox()).toEqual(rect);
  await page.reload();
  await button(page, "編集").click();
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "floating");
  expect(await panel(page).boundingBox()).toEqual(rect);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("failed explicit save retains old slot and current layout; damaged settings fall back safely", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{"layoutVersion":999}'),
    key,
  );
  await start(page);
  await expect(panel(page)).toHaveAttribute("data-panel-placement", "docked");
  await float(page);
  await menu(page, "プロパティ配置を保存");
  const saved = await page.evaluate((key) => localStorage.getItem(key), key),
    old = (await panel(page).boundingBox())!;
  await move(page, -200, 20);
  const current = await panel(page).boundingBox();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("unavailable");
    };
  });
  await menu(page, "プロパティ配置を保存");
  await expect(page.locator(".toast-host")).toContainText(
    "プロパティの配置を保存できません",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    saved,
  );
  expect(await panel(page).boundingBox()).toEqual(current);
  await menu(page, "保存したプロパティ配置に戻す");
  expect(await panel(page).boundingBox()).toEqual(old);
});
test("pointer cancellation, capture loss, window blur and viewport resize restore placement without project edits", async ({
  page,
}) => {
  await start(page);
  await float(page);
  for (const reason of ["cancel", "capture", "blur", "resize"]) {
    const old = await panel(page).boundingBox(),
      b = (await button(page, "プロパティパネルを移動").boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + 12);
    await page.mouse.down();
    await page.mouse.move(b.x - 80, b.y + 32, { steps: 3 });
    if (reason === "resize") {
      await page.setViewportSize({ width: 1800, height: 1080 });
    } else
      await button(page, "プロパティパネルを移動").evaluate((el, reason) => {
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else if (reason === "cancel")
          el.dispatchEvent(
            new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
          );
        else if (el.hasPointerCapture(1)) el.releasePointerCapture(1);
      }, reason);
    await page.mouse.up();
    if (reason === "resize")
      await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => panel(page).boundingBox()).toEqual(old);
  }
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("floating and docking preserve manual zoom and design center", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
  const center = () =>
    page.getByRole("region", { name: "キャンバス操作領域" }).evaluate((el) => {
      const box = el.getBoundingClientRect(),
        point = new DOMPoint(
          box.left + el.clientLeft + el.clientWidth / 2,
          box.top + el.clientTop + el.clientHeight / 2,
        ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
      return { x: point.x, y: point.y };
    });
  const before = await center();
  for (const label of ["プロパティを浮動にする", "プロパティを右へ戻す"]) {
    await menu(page, label);
    await expect
      .poll(async () => Math.abs((await center()).x - before.x))
      .toBeLessThan(2);
    await expect
      .poll(async () => Math.abs((await center()).y - before.y))
      .toBeLessThan(2);
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("1");
  }
});
test("IME stays in the same field while pointer placement changes; keyboard resizing cancels independently", async ({
  page,
}) => {
  await start(page);
  await float(page);
  const x = page.getByLabel("x", { exact: true });
  await x.fill("125");
  await x.dispatchEvent("compositionstart");
  const ref = await x.elementHandle();
  await move(page, -120, 24);
  await expect(x).toBeFocused();
  expect(await x.evaluate((el, ref) => el === ref, ref)).toBe(true);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await x.press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await x.dispatchEvent("compositionend");
  await x.press("Enter");
  await expect(button(page, "元に戻す")).toBeEnabled();
  const handle = button(page, "プロパティパネルのサイズを変更");
  const old = await panel(page).boundingBox();
  await handle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  expect(await panel(page).boundingBox()).toEqual(old);
  await handle.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  expect((await panel(page).boundingBox())!.width).toBe(old!.width + 8);
});
test("reappearing menu bar updates the floating top boundary without a window resize", async ({
  page,
}) => {
  await start(page);
  await float(page);
  await menu(page, "メニューバーを隠す");
  await move(page, 0, -2000);
  const before = (await panel(page).boundingBox())!;
  await menu(page, "メニューバーを表示");
  await expect
    .poll(async () => (await panel(page).boundingBox())!.y)
    .toBeGreaterThan(before.y);
  const top = await page
    .locator("main")
    .evaluate((el) => el.getBoundingClientRect().top);
  expect((await panel(page).boundingBox())!.y).toBeGreaterThanOrEqual(top + 8);
});
test("a menu appearing during a pointer gesture cancels it and receives Escape", async ({
  page,
}) => {
  await start(page);
  await float(page);
  const old = await panel(page).boundingBox(),
    grip = button(page, "プロパティパネルを移動"),
    box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 32, { steps: 3 });
  await button(page, "メニュー").evaluate((el) => el.click());
  await expect(page.getByRole("menu", { name: "常設メニュー" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "常設メニュー" })).toHaveCount(0);
  expect(await panel(page).boundingBox()).toEqual(old);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("native viewport dimensions cancel a gesture before pointerup even when resize delivery is delayed", async ({
  page,
}) => {
  // CDP's resize acknowledgement need not mean that the page's resize notification has run.
  await page.addInitScript(() =>
    window.addEventListener(
      "resize",
      (event) => event.stopImmediatePropagation(),
      true,
    ),
  );
  await start(page);
  await float(page);
  const original = await panel(page).boundingBox();
  for (const size of [
    { width: 1800, height: 1080 },
    { width: 1920, height: 1000 },
  ]) {
    const box = (await button(page, "プロパティパネルを移動").boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, box.y + 32, { steps: 3 });
    await page.setViewportSize(size);
    await page.mouse.up();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => panel(page).boundingBox()).toEqual(original);
  }
  await expect(button(page, "元に戻す")).toBeDisabled();
});
