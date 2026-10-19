import { fileCommand, chooseTheme, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const paper = (page: Page) =>
  page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .locator("[data-screen-background]");
async function start(page: Page) {
  await page.goto("/");
  await fileCommand(page, "工程図サンプルを開く");
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
}
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project JSON を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

test("screen background is staged, undoable and persistent while themes, objects and shared symbols remain independent", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面の背景色", { exact: true }).fill("#ffffff");
  await expect(paper(page)).toHaveAttribute("fill", "#0b1220");
  await button(page, "画面設定を適用").click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  await page.getByLabel("グリッド表示", { exact: true }).check();
  for (const theme of ["dark", "light"] as const) {
    await chooseTheme(page, theme);
    await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
    await expect(page.locator("pattern circle")).toHaveAttribute(
      "fill",
      "#475569",
    );
  }
  for (const symbol of await page.locator("svg[data-symbol-id]").all())
    expect(
      await symbol.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
  await button(page, "元に戻す").click();
  await expect(paper(page)).toHaveAttribute("fill", "#0b1220");
  await button(page, "やり直す").click();
  const project = await save(page);
  const original = JSON.parse(
    await readFile("examples/process.project.json", "utf8"),
  );
  expect(project.manifest.schemaVersion).toBe("0.6.0");
  expect(project.manifest.minRuntimeVersion).toBe("0.6.0");
  expect(project.screens[0].background).toBe("#ffffff");
  expect(project.screens[0].objects).toEqual(original.screens[0].objects);
  expect(project.symbols).toEqual(original.symbols);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "background.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  await button(page, "表示プレビュー").click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  await expect(page.locator("[data-grid]")).toHaveCount(0);
});

test("new screens start white and screen switching protects pending background input", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面の背景色", { exact: true }).fill("#fff1f2");
  await button(page, "画面を追加").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("画面の背景色", { exact: true })).toHaveValue(
    "#fff1f2",
  );
  await expect(paper(page)).toHaveAttribute("fill", "#0b1220");
  await button(page, "画面を追加").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  await chooseTheme(page, "dark");
  await selectPanel(page, "部品");
  await button(page, "Text を追加").click();
  const project = await save(page);
  expect(project.screens[0].background).toBe("#fff1f2");
  expect(project.screens[1].background).toBe("#ffffff");
  expect(project.screens[1].objects[0].fill).toBe("#0f172a");
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await expect(page.getByLabel("画面の背景色", { exact: true })).toHaveCount(0);
  await expect(paper(page)).toHaveAttribute("fill", "#0b1220");
  await button(page, "画面へ戻る").click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  await page.getByLabel("画面の背景色", { exact: true }).fill("#ff0000");
  await button(page, "表示プレビュー").click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
});

test("invalid backgrounds and the previous schema leave the current project intact", async ({
  page,
}) => {
  await start(page);
  const project = JSON.parse(
    await readFile("examples/process.project.json", "utf8"),
  );
  const invalid = [
    { ...project, screens: [{ ...project.screens[0], background: "url(x)" }] },
    { ...project, manifest: { ...project.manifest, schemaVersion: "0.3.0" } },
  ];
  const missing = structuredClone(project);
  delete missing.screens[0].background;
  invalid.push(missing);
  for (const value of invalid) {
    await page
      .getByLabel("Project JSON を開く", { exact: true })
      .setInputFiles({
        name: "invalid.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
    await expect(page.getByTestId("project-status")).toContainText(
      "読込エラー",
    );
    await expect(paper(page)).toHaveAttribute("fill", "#0b1220");
    await expect(
      page
        .getByRole("img", { name: "循環設備（静的サンプル）", exact: true })
        .locator("[data-object-id]"),
    ).toHaveCount(15);
  }
});

test("the light process example renders on either app theme and copies its background", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles("examples/process-light.project.json");
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  for (const theme of ["light", "dark"] as const) {
    await chooseTheme(page, theme);
    await expect(
      page.getByRole("img", { name: "循環設備（ライト）", exact: true }),
    ).toBeVisible();
    await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  }
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "画面を複製").click();
  await expect(paper(page)).toHaveAttribute("fill", "#ffffff");
  const project = await save(page);
  expect(project.screens.map((s: any) => s.background)).toEqual([
    "#ffffff",
    "#ffffff",
  ]);
});
