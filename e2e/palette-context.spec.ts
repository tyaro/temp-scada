import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { selectPanel, chooseTheme } from "./helpers/designer";
import processProject from "../examples/process.project.json" with { type: "json" };

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const palette = (page: Page) =>
  page.getByRole("region", { name: "部品パレット", exact: true });
const menu = (page: Page, name: string) =>
  page.getByRole("menu", { name: `${name} の操作`, exact: true });
async function edit(page: Page) {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "部品");
}
async function load(page: Page, project = processProject) {
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
async function save(page: Page) {
  const downloading = page.waitForEvent("download");
  await button(page, "Project JSON を保存").click();
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}

test("right-click only opens operations, keeps drafts and selection, and returns focus on Escape", async ({
  page,
}) => {
  await edit(page);
  await button(page, "Rectangle を追加").click();
  await page.getByLabel("色", { exact: true }).fill("#aabbcc");
  const before = await page.locator(".toolbar").innerText();
  const pump = button(page, "ポンプを追加");
  await pump.click({ button: "right" });
  await expect(menu(page, "ポンプ（組込）")).toBeVisible();
  await expect(
    menu(page, "ポンプ（組込）").getByRole("menuitem", {
      name: "現在の画面へ配置",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("色", { exact: true })).toHaveValue("#aabbcc");
  expect(await page.locator(".toolbar").innerText()).toBe(before);
  await page.keyboard.press("Escape");
  await expect(pump).toBeFocused();
  await pump.press("Shift+F10");
  await expect(menu(page, "ポンプ（組込）")).toBeVisible();
  await menu(page, "ポンプ（組込）")
    .getByRole("menuitem", { name: "部品情報", exact: true })
    .click();
  const info = page.getByRole("dialog", { name: "部品情報", exact: true });
  await expect(info).toContainText("組込シンボル");
  await expect(info).toContainText("100 × 100");
  await info.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(pump).toBeFocused();
  expect(await page.locator(".toolbar").innerText()).toBe(before);
  await expect(page.getByLabel("色", { exact: true })).toHaveValue("#aabbcc");
  await pump.press("ContextMenu");
  await expect(menu(page, "ポンプ（組込）")).toBeVisible();
  await page.getByRole("searchbox", { name: "部品を検索" }).click();
  await expect(menu(page, "ポンプ（組込）")).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "部品を検索" }),
  ).toBeFocused();
});

for (const zoom of [0.25, 1, 4])
  test(`context placement uses canvas center at ${zoom * 100}% and one undo step`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await edit(page);
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    const viewport = page.getByRole("region", {
      name: "キャンバス操作領域",
      exact: true,
    });
    await viewport.evaluate((el) => {
      el.scrollLeft = 160;
      el.scrollTop = 90;
    });
    const center = await viewport.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const p = new DOMPoint(
        box.left + el.clientLeft + el.clientWidth / 2,
        box.top + el.clientTop + el.clientHeight / 2,
      ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
      return { x: p.x, y: p.y };
    });
    await button(page, "Rectangle を追加").click({ button: "right" });
    await menu(page, "Rectangle")
      .getByRole("menuitem", { name: "現在の画面へ配置", exact: true })
      .click();
    const number = async (name: string) =>
      Number(await page.getByLabel(name, { exact: true }).inputValue());
    expect(
      Math.abs((await number("x")) + (await number("width")) / 2 - center.x),
    ).toBeLessThan(2 / zoom);
    expect(
      Math.abs((await number("y")) + (await number("height")) / 2 - center.y),
    ).toBeLessThan(2 / zoom);
    const objects = page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]");
    await expect(objects).toHaveCount(4);
    await button(page, "元に戻す").click();
    await expect(objects).toHaveCount(3);
    await button(page, "やり直す").click();
    await expect(objects).toHaveCount(4);
  });

test("context placement uses the existing apply/discard/cancel protection", async ({
  page,
}) => {
  await edit(page);
  await button(page, "Rectangle を追加").click();
  await page.getByLabel("色", { exact: true }).fill("#aabbcc");
  const objects = page
    .getByRole("img", { name: "プロセス画面", exact: true })
    .locator("[data-object-id]");
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  for (const resolution of ["キャンセル", "適用して続行"]) {
    await button(page, "操作：バルブ（組込）").click();
    await menu(page, "バルブ（組込）")
      .getByRole("menuitem", { name: "現在の画面へ配置", exact: true })
      .click();
    await prompt.getByRole("button", { name: resolution, exact: true }).click();
    if (resolution === "キャンセル") {
      await expect(objects).toHaveCount(4);
      await expect(page.getByLabel("色", { exact: true })).toHaveValue(
        "#aabbcc",
      );
    }
  }
  await expect(objects).toHaveCount(5);
  const project = await save(page);
  expect(
    project.screens[0].objects.find(
      (o: any) => o.shape.type === "rectangle" && o.fill === "#aabbcc",
    ),
  ).toBeDefined();
  expect(project.symbols[0].name).toBe("バルブ");
});

test("category operations preserve search expansion and native input menus", async ({
  page,
}) => {
  await edit(page);
  const basic = palette(page).getByRole("button", { name: /^基本図形/ });
  await basic.press("Shift+F10");
  await menu(page, "基本図形")
    .getByRole("menuitem", { name: "すべての分類を折りたたむ", exact: true })
    .click();
  await expect(basic).toHaveAttribute("aria-expanded", "false");
  const search = palette(page).getByRole("searchbox", { name: "部品を検索" });
  await search.fill("rectangle");
  await button(page, "操作：基本図形").click();
  const items = menu(page, "基本図形").getByRole("menuitem");
  for (const item of await items.all())
    await expect(item).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await search.evaluate((el) => {
    el.addEventListener(
      "contextmenu",
      (e) => {
        queueMicrotask(() => {
          el.setAttribute("data-native-menu", String(!e.defaultPrevented));
        });
      },
      { once: true },
    );
  });
  await search.dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  await expect(search).toHaveAttribute("data-native-menu", "true");
  await button(page, "検索をクリア").click();
  await expect(basic).toHaveAttribute("aria-expanded", "false");
  await button(page, "操作：基本図形").click();
  await menu(page, "基本図形")
    .getByRole("menuitem", { name: "すべての分類を展開", exact: true })
    .click();
  await expect(basic).toHaveAttribute("aria-expanded", "true");
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("shared definitions expose guarded editing and duplication without redirecting existing placements", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  await button(page, "ポンプ を配置").click({ button: "right" });
  await expect(menu(page, "ポンプ（共有定義）")).toBeVisible();
  await menu(page, "ポンプ（共有定義）")
    .getByRole("menuitem", { name: "共有定義を複製", exact: true })
    .click();
  let project = await save(page);
  expect(project.symbols).toHaveLength(processProject.symbols.length + 1);
  expect(project.screens).toEqual(processProject.screens);
  await button(page, "元に戻す").click();
  project = await save(page);
  expect(project.symbols).toEqual(processProject.symbols);
  await selectPanel(page, "部品");
  await button(page, "ポンプ を配置").click({ button: "right" });
  await menu(page, "ポンプ（共有定義）")
    .getByRole("menuitem", {
      name: "共有定義を編集（すべての参照配置に反映）",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Symbol 名", { exact: true })).toHaveValue(
    "ポンプ",
  );
  await selectPanel(page, "部品");
  await expect(button(page, "ポンプを追加")).toHaveCount(0);
  await expect(button(page, "ポンプ を配置")).toHaveCount(0);
});

test("target replacement, search, tab switches and hidden panels close obsolete menus", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  await button(page, "ポンプ を配置").click({ button: "right" });
  await load(page); // Deliberately identical IDs and revision: only local session generation changes.
  await expect(menu(page, "ポンプ（共有定義）")).toHaveCount(0);
  await button(page, "Rectangle を追加").click({ button: "right" });
  await selectPanel(page, "レイヤー");
  await expect(menu(page, "Rectangle")).toHaveCount(0);
  await selectPanel(page, "部品");
  await button(page, "Rectangle を追加").click({ button: "right" });
  await page.getByRole("searchbox", { name: "部品を検索" }).fill("ポンプ");
  await expect(menu(page, "Rectangle")).toHaveCount(0);
  await button(page, "ポンプを追加").click({ button: "right" });
  await button(page, "左パネルを隠す").click();
  await expect(menu(page, "ポンプ（組込）")).toHaveCount(0);
});

for (const theme of ["light", "dark"])
  test(`menus fit the viewport and primary placement stays unchanged in ${theme}`, async ({
    page,
  }) => {
    await edit(page);
    await chooseTheme(page, theme);
    for (const [width, height] of [
      [1280, 720],
      [650, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await button(page, "Rectangle を追加").click({ button: "right" });
      const popup = menu(page, "Rectangle");
      await expect(popup).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("End");
      await expect(
        popup.getByRole("menuitem", { name: "部品情報", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(
        popup.getByRole("menuitem", { name: "現在の画面へ配置", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
    }
    await button(page, "Rectangle を追加").press("Enter");
    await expect(
      page
        .getByRole("img", { name: "プロセス画面", exact: true })
        .locator("[data-object-id]"),
    ).toHaveCount(4);
    await expect(menu(page, "Rectangle")).toHaveCount(0);
    await button(page, "表示プレビュー").click();
    await expect(palette(page)).toHaveCount(0);
  });
