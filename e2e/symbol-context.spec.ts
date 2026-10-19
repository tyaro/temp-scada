import { fileCommand, chooseTheme, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const list = (page: Page) =>
  page.getByRole("navigation", { name: "共有 Symbol 一覧" });
const row = (page: Page, name: string) =>
  list(page).getByRole("button", { name: `共有定義：${name}`, exact: true });
const menu = (page: Page, name: string) =>
  page.getByRole("menu", { name: `共有定義：${name} の操作`, exact: true });
async function start(page: Page) {
  await page.goto("/");
  await fileCommand(page, "工程図サンプルを開く");
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
}
async function action(page: Page, target: string, name: string) {
  await row(page, target).click({ button: "right" });
  await menu(page, target).getByRole("menuitem", { name, exact: true }).click();
}
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project JSON を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

test("shared definition context opening keeps the canvas, library selection and drafts; editing resolves inputs", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面名", { exact: true }).fill("給水工程");
  await row(page, "バルブ").click({ button: "right" });
  await expect(menu(page, "バルブ")).toBeVisible();
  await expect(row(page, "ポンプ")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row(page, "バルブ")).toBeFocused();
  await action(page, "バルブ", "共有定義を編集（すべての参照配置に反映）");
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "給水工程",
  );
  await expect(row(page, "ポンプ")).toHaveAttribute("aria-pressed", "true");
  await action(page, "バルブ", "共有定義を編集（すべての参照配置に反映）");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "バルブ", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("note")).toContainText("1 配置で共有");
  await row(page, "バルブ").focus();
  await page.keyboard.press("Shift+F10");
  for (const name of ["現在の画面へ配置", "共有定義を削除"]) {
    await expect(
      menu(page, "バルブ").getByRole("menuitem", { name, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("Escape");
  await button(page, "画面へ戻る").click();
  await expect(
    page.getByRole("img", { name: "給水工程", exact: true }),
  ).toBeVisible();
});

test("duplicate and delete act on the context definition without redirecting shared placements or clearing another selection", async ({
  page,
}) => {
  await start(page);
  await action(page, "バルブ", "共有定義を複製");
  await expect(
    page.getByRole("img", { name: "バルブ コピー", exact: true }),
  ).toBeVisible();
  await button(page, "画面へ戻る").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ポンプ · 10", exact: true })
    .click();
  await selectPanel(page, "プロジェクト");
  await row(page, "ポンプ").click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("「バルブ コピー」");
    await dialog.dismiss();
  });
  await action(page, "バルブ コピー", "共有定義を削除");
  await expect(row(page, "バルブ コピー")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await action(page, "バルブ コピー", "共有定義を削除");
  await expect(row(page, "バルブ コピー")).toHaveCount(0);
  await expect(row(page, "ポンプ")).toBeFocused();
  await expect(row(page, "ポンプ")).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('[data-object-id][data-selected="true"]'),
  ).toHaveCount(1);
  await button(page, "元に戻す").click();
  await expect(row(page, "バルブ コピー")).toBeVisible();
  const project = await save(page);
  const valve = project.symbols.find((d: any) => d.name === "バルブ");
  const copy = project.symbols.find((d: any) => d.name === "バルブ コピー");
  expect(copy.id).not.toBe(valve.id);
  expect(copy.objects[0].id).not.toBe(valve.objects[0].id);
  expect(
    project.screens[0].objects.filter(
      (o: any) => o.shape.symbolId === valve.id,
    ),
  ).toHaveLength(1);
  expect(
    project.screens[0].objects.filter((o: any) => o.shape.symbolId === copy.id),
  ).toHaveLength(0);
});

test("context placement uses the visible canvas center, draft protection and one-step history", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
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
    const point = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(el.querySelector("svg")!.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
  await page.getByLabel("画面名", { exact: true }).fill("未適用");
  await action(page, "バルブ", "現在の画面へ配置");
  await page
    .getByRole("dialog", { name: "未適用の入力があります" })
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  const project = await save(page);
  const valve = project.symbols.find((d: any) => d.name === "バルブ");
  const placed = project.screens[0].objects.at(-1);
  expect(placed.shape.symbolId).toBe(valve.id);
  expect(placed.x + placed.width / 2).toBeCloseTo(center.x, 0);
  expect(placed.y + placed.height / 2).toBeCloseTo(center.y, 0);
  expect(project.symbols).toHaveLength(2);
  await button(page, "元に戻す").click();
  await expect(
    page
      .getByRole("img", { name: "循環設備（静的サンプル）", exact: true })
      .locator("[data-symbol-id]"),
  ).toHaveCount(2);
  await button(page, "やり直す").click();
  await expect(
    page
      .getByRole("img", { name: "循環設備（静的サンプル）", exact: true })
      .locator(`[data-object-id="${placed.id}"]`),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`definition row selection and menus fit a small viewport in ${theme} and remain absent in preview`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await start(page);
    await chooseTheme(page, theme);
    await row(page, "バルブ").click();
    await expect(row(page, "バルブ")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("note")).toHaveCount(0);
    await button(page, "操作：共有定義：バルブ").click();
    const popup = menu(page, "バルブ");
    await expect(popup).toBeVisible();
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
    await page.keyboard.press("Escape");
    await expect(button(page, "操作：共有定義：バルブ")).toBeFocused();
    await button(page, "表示プレビュー").click();
    await expect(list(page)).toHaveCount(0);
  });

test("definition menus honor the count limit and close when the same project is reloaded", async ({
  page,
}) => {
  await start(page);
  const project = JSON.parse(
    await readFile("examples/process.project.json", "utf8"),
  );
  for (let i = 0; i < 98; i++)
    project.symbols.push({
      id: `0199fa00-0000-7000-8000-${String(i + 1000).padStart(12, "0")}`,
      name: `設備 ${i + 1}`,
      folders: [],
      width: 100,
      height: 100,
      objects: [
        {
          ...project.symbols[0].objects[0],
          id: `0199fa00-0000-7000-8000-${String(i + 2000).padStart(12, "0")}`,
        },
      ],
    });
  const file = {
    name: "symbols.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  };
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles(file);
  await expect(list(page).locator("button[aria-pressed]")).toHaveCount(100);
  await row(page, "ポンプ").click({ button: "right" });
  const popup = menu(page, "ポンプ");
  await expect(
    popup.getByRole("menuitem", { name: "共有定義を複製", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    popup.getByRole("menuitem", { name: "共有定義を削除", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles(file);
  await expect(popup).not.toBeVisible();
  await expect(list(page).locator("button[aria-pressed]")).toHaveCount(100);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
