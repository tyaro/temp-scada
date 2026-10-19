import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
const shapes = (page: Page) =>
  page
    .getByRole("img", { name: "プロセス画面", exact: true })
    .locator("[data-object-id]");
const layers = (page: Page) =>
  page.getByRole("navigation", { name: "図形一覧" });
async function start(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "レイヤー");
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
}
async function command(page: Page, name: string) {
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
test("native clipboard copies, pastes with repeat offset, cuts and deletes with one Undo each", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Control+c");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text).format).toBe("banto-scada.objects");
  await page.keyboard.press("Control+v");
  await expect(shapes(page)).toHaveCount(4);
  const first = await page
    .locator('[data-object-id][data-selected="true"]')
    .getAttribute("transform");
  await page.keyboard.press("Control+v");
  await expect(shapes(page)).toHaveCount(5);
  expect(
    await page
      .locator('[data-object-id][data-selected="true"]')
      .getAttribute("transform"),
  ).not.toBe(first);
  await page.keyboard.press("Control+z");
  await expect(shapes(page)).toHaveCount(4);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.keyboard.press("Control+x");
  await expect(shapes(page)).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(shapes(page)).toHaveCount(4);
  await layers(page)
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.keyboard.press("Delete");
  await expect(shapes(page)).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(shapes(page)).toHaveCount(4);
});
test("menu clipboard survives file scope and rejects plain text without editing", async ({
  page,
}) => {
  await start(page);
  await command(page, "コピー");
  await command(page, "貼り付け");
  await expect(shapes(page)).toHaveCount(4);
  await page.evaluate(() => navigator.clipboard.writeText("ordinary text"));
  await command(page, "貼り付け");
  await expect(
    page.getByText(/クリップボード操作に失敗しました/).first(),
  ).toBeVisible();
  await expect(shapes(page)).toHaveCount(4);
});
test("clipboard write failure keeps cut source and history unchanged", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await command(page, "切り取り");
  await expect(
    page.getByText(/クリップボード操作に失敗しました/).first(),
  ).toBeVisible();
  await expect(shapes(page)).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("async cut cancels removal if selection changes during clipboard write", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            (window as any).finishClipboard = resolve;
          }),
      },
    }),
  );
  await command(page, "切り取り");
  await layers(page)
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click();
  await page.evaluate(() => (window as any).finishClipboard());
  await expect(page.getByText(/切り取りは中止しました/).first()).toBeVisible();
  await expect(shapes(page)).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("text controls retain native clipboard and Delete; draft cancel preserves model", async ({
  page,
}) => {
  await start(page);
  await layers(page)
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("テキスト", { exact: true });
  await input.fill("native clipboard");
  await input.selectText();
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "native clipboard",
  );
  await page.keyboard.press("Delete");
  await expect(input).toHaveValue("");
  await expect(shapes(page)).toHaveCount(3);
  await command(page, "切り取り");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(shapes(page)).toHaveCount(3);
  await command(page, "コピー");
  await page
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(copied.project.screens[0].objects[0].shape.text).toContain("BANTO");
});
test("symbol clipboard reuses live definition and imports its snapshot after reload", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加", exact: true }).click();
  await command(page, "コピー");
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(copied.project.symbols).toHaveLength(1);
  await command(page, "貼り付け");
  await expect(shapes(page)).toHaveCount(5);
  expect(
    new Set(
      await shapes(page)
        .locator("[data-symbol-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-symbol-id")),
        ),
    ).size,
  ).toBe(1);
  const fragment = copied.project;
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "clipboard-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fragment)),
  });
  await page.getByRole("button", { name: "破棄して開く", exact: true }).click();
  await expect(shapes(page)).toHaveCount(1);
  await command(page, "貼り付け");
  await expect(shapes(page)).toHaveCount(2);
  const ids = await shapes(page)
    .locator("[data-symbol-id]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-symbol-id")));
  expect(new Set(ids).size).toBe(2);
});
test("Delete and clipboard outside placement scope leave objects unchanged", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "プロセス画面", exact: true })
    .focus();
  await page.keyboard.press("Delete");
  await page.evaluate(() => navigator.clipboard.writeText("keep"));
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep",
  );
  await expect(shapes(page)).toHaveCount(3);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+v");
  await expect(shapes(page)).toHaveCount(3);
});
test("cut validates final definition child before writing to OS clipboard", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加", exact: true }).click();
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "定義を編集", exact: true }).click();
  await selectPanel(page, "レイヤー");
  await layers(page).getByRole("button").first().focus();
  await page.keyboard.press("Control+a");
  await page.evaluate(() =>
    navigator.clipboard.writeText("keep existing clipboard"),
  );
  await command(page, "切り取り");
  await expect(
    page.getByText(/クリップボード操作に失敗しました/).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep existing clipboard",
  );
  await expect(
    page
      .getByRole("img", { name: "ポンプ", exact: true })
      .locator("[data-object-id]"),
  ).not.toHaveCount(0);
});
