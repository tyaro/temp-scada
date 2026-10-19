import { fileCommand, chooseTheme, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const canvas = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
const list = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧", exact: true });
const menu = (page: Page, name: string) =>
  page.getByRole("menu", { name: `${name} の操作`, exact: true });
async function edit(page: Page) {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
}
async function at(page: Page, x: number, y: number, alt = false) {
  const p = await svg(page).evaluate(
    (el, point) => {
      const p = new DOMPoint(point.x, point.y).matrixTransform(
        (el as SVGSVGElement).getScreenCTM()!,
      );
      return { x: p.x, y: p.y };
    },
    { x, y },
  );
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.click(p.x, p.y, { button: "right" });
  if (alt) await page.keyboard.up("Alt");
}
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

test("canvas and layer context menus keep multiple selection and share toolbar commands", async ({
  page,
}) => {
  await edit(page);
  await list(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await list(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  const before = await page.locator(".toolbar").innerText();
  await svg(page)
    .locator("[data-object-id]")
    .first()
    .click({ button: "right" });
  const popup = menu(page, "選択図形（2 件）");
  await expect(popup).toBeVisible();
  await expect(svg(page).locator('[data-selected="true"]')).toHaveCount(2);
  await expect(
    popup.getByRole("menuitem", { name: "左揃え", exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("menuitem", { name: "最前面へ", exact: true }),
  ).toHaveCount(0);
  expect(await page.locator(".toolbar").innerText()).toBe(before);
  await page.keyboard.press("Escape");
  await expect(canvas(page)).toBeFocused();
  await list(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ button: "right" });
  await expect(popup).toBeVisible();
  await popup
    .getByRole("menuitem", { name: "選択図形を複製", exact: true })
    .click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(5);
  await button(page, "元に戻す").click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
});

for (const source of ["canvas", "layer"])
  test(`right-clicking an unselected ${source} target resolves drafts before changing selection`, async ({
    page,
  }) => {
    await edit(page);
    await list(page)
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#aabbcc");
    const target =
      source === "canvas"
        ? svg(page).locator("[data-object-id]").nth(1)
        : list(page).getByRole("button", { name: "ellipse · 4", exact: true });
    const prompt = page.getByRole("dialog", {
      name: "未適用の入力があります",
      exact: true,
    });
    await target.click({ button: "right" });
    await expect(prompt).toBeVisible();
    await expect(menu(page, "ellipse · 4")).toHaveCount(0);
    await prompt
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    await expect(
      list(page).getByRole("button", { name: "rectangle · 3", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
    ).toHaveValue("#aabbcc");
    await target.click({ button: "right" });
    await prompt
      .getByRole("button", { name: "適用して続行", exact: true })
      .click();
    await expect(menu(page, "ellipse · 4")).toBeVisible();
    await expect(
      list(page).getByRole("button", { name: "ellipse · 4", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    expect(
      (await save(page)).screens[0].objects[0].shape.paint.fill.paint.color,
    ).toBe("#aabbcc");
  });

for (const zoom of [0.25, 1, 4])
  test(`blank context insertion preserves selection and uses snapped design coordinates at ${zoom * 100}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await edit(page);
    await list(page)
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await page.getByLabel("グリッドにスナップ", { exact: true }).check();
    await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    await canvas(page).evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      el.scrollTop = el.scrollHeight;
    });
    for (const alt of [false, true]) {
      await list(page)
        .getByRole("button", { name: "rectangle · 3", exact: true })
        .click();
      await at(page, 923, 503, alt);
      const popup = menu(page, "キャンバス");
      await expect(popup).toBeVisible();
      await expect(svg(page).locator('[data-selected="true"]')).toHaveCount(1);
      await popup
        .getByRole("menuitem", { name: "Rectangle を挿入", exact: true })
        .click();
      const n = async (name: string) =>
        Number(await page.getByLabel(name, { exact: true }).inputValue());
      expect(
        Math.abs((await n("x")) + (await n("width")) / 2 - (alt ? 923 : 920)),
      ).toBeLessThan(2 / zoom);
      expect(
        Math.abs((await n("y")) + (await n("height")) / 2 - (alt ? 503 : 500)),
      ).toBeLessThan(2 / zoom);
      await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
      await button(page, "元に戻す").click();
      await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
    }
  });

test("context key and named action buttons recover properties and return focus to their origin", async ({
  page,
}) => {
  await edit(page);
  const row = list(page).getByRole("button", {
    name: "rectangle · 3",
    exact: true,
  });
  await row.focus();
  await row.press("Shift+F10");
  let popup = menu(page, "rectangle · 3");
  await expect(
    popup.getByRole("menuitem", { name: "プロパティを表示", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await button(page, "キャンバスの操作").click();
  await popup
    .getByRole("menuitem", { name: "プロパティを表示", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル", exact: true }),
  ).toBeFocused();
  await button(page, "プロパティを隠す").click();
  await canvas(page).focus();
  await canvas(page).press("ContextMenu");
  await expect(popup).toBeVisible();
  await popup
    .getByRole("menuitem", { name: "プロパティを表示", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル", exact: true }),
  ).toBeFocused();
  await button(page, "キャンバスの操作").click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button(page, "キャンバスの操作")).toBeFocused();
  await button(page, "操作：ellipse · 4").click();
  popup = menu(page, "ellipse · 4");
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button(page, "操作：ellipse · 4")).toBeFocused();
  await button(page, "選択解除").click();
  const center = await canvas(page).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const point = new DOMPoint(
      rect.left + el.clientLeft + el.clientWidth / 2,
      rect.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
  await canvas(page).focus();
  await canvas(page).press("Shift+F10");
  await menu(page, "キャンバス")
    .getByRole("menuitem", { name: "Text を挿入", exact: true })
    .click();
  const n = async (name: string) =>
    Number(await page.getByLabel(name, { exact: true }).inputValue());
  expect(
    Math.abs((await n("x")) + (await n("width")) / 2 - center.x),
  ).toBeLessThan(2);
  expect(
    Math.abs((await n("y")) + (await n("height")) / 2 - center.y),
  ).toBeLessThan(2);
});

test("context sessions close on selection changes and can reopen on another canvas target", async ({
  page,
}) => {
  await edit(page);
  const first = svg(page).locator("[data-object-id]").first();
  const second = svg(page).locator("[data-object-id]").nth(1);
  await first.click({ button: "right" });
  await expect(menu(page, "rectangle · 3")).toBeVisible();
  await second.click({ button: "right" });
  await expect(menu(page, "ellipse · 4")).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(svg(page).locator('[data-selected="true"]')).toHaveCount(3);
});

test("symbol context operations share the existing independent-copy and definition-edit paths", async ({
  page,
}) => {
  await page.goto("/");
  await fileCommand(page, "工程図サンプルを開く");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await list(page)
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click({ button: "right" });
  let popup = menu(page, "ポンプ · 10");
  await popup
    .getByRole("menuitem", {
      name: "定義を複製してこの配置に適用",
      exact: true,
    })
    .click();
  await expect(page.getByRole("note")).toContainText("Symbol 定義を編集中");
  await button(page, "画面へ戻る").click();
  await selectPanel(page, "レイヤー");
  const project = await save(page);
  expect(project.symbols).toHaveLength(3);
  const pump = project.screens[0].objects.find((o: any) => o.order === 10);
  const definition = project.symbols.find(
    (d: any) => d.id === pump.shape.symbolId,
  );
  await list(page)
    .getByRole("button", { name: `${definition.name} · 10`, exact: true })
    .click({ button: "right" });
  popup = menu(page, `${definition.name} · 10`);
  await popup
    .getByRole("menuitem", { name: "参照する Symbol 定義を編集", exact: true })
    .click();
  await expect(page.getByLabel("Symbol 名", { exact: true })).toHaveValue(
    definition.name,
  );
});

for (const theme of ["light", "dark"])
  test(`canvas menus fit screen edges in ${theme} and preview keeps native right-click`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await edit(page);
    await chooseTheme(page, theme);
    await at(page, 763, 563);
    const popup = menu(page, "キャンバス");
    await expect(popup).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("End");
    await expect(
      popup.getByRole("menuitem", {
        name: "補助パネルをすべて隠す",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await button(page, "表示プレビュー").click();
    await canvas(page).evaluate((el) =>
      el.addEventListener(
        "contextmenu",
        (event) =>
          queueMicrotask(() =>
            el.setAttribute("data-native", String(!event.defaultPrevented)),
          ),
        { once: true },
      ),
    );
    await canvas(page).dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 300,
    });
    await expect(canvas(page)).toHaveAttribute("data-native", "true");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

test("back-to-back context requests open only the last insertion point", async ({
  page,
}) => {
  await edit(page);
  await canvas(page).evaluate((el) => {
    const matrix = el.querySelector("svg")!.getScreenCTM()!;
    for (const position of [
      { x: 923, y: 503 },
      { x: 30, y: 30 },
    ]) {
      const point = new DOMPoint(position.x, position.y).matrixTransform(
        matrix,
      );
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    }
  });
  await menu(page, "キャンバス")
    .getByRole("menuitem", { name: "Rectangle を挿入", exact: true })
    .click();
  const n = async (name: string) =>
    Number(await page.getByLabel(name, { exact: true }).inputValue());
  expect(Math.abs((await n("x")) + (await n("width")) / 2 - 30)).toBeLessThan(
    2,
  );
  expect(Math.abs((await n("y")) + (await n("height")) / 2 - 30)).toBeLessThan(
    2,
  );
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
});
