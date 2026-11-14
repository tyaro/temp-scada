import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { chooseTheme, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

async function open(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await selectPanel(page, "プロジェクト");
}
async function save(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}
const table = (page: Page) =>
  page.getByRole("table", { name: "警報の定義", exact: true });
const details = (page: Page) =>
  page.getByRole("form", { name: "警報の定義の詳細", exact: true });
const status = (page: Page) => page.getByTestId("project-status");
async function apply(page: Page) {
  await details(page)
    .getByRole("button", { name: "警報の定義を適用", exact: true })
    .click();
}

test("alarm settings add, edit, duplicate, toggle, delete, undo and save", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);
  await expect(table(page).locator("tbody tr")).toHaveCount(
    sample.alarms.definitions.length,
  );

  // しきい値の警報を足して詳細を編集する。
  await page
    .getByRole("button", { name: "しきい値の警報を追加", exact: true })
    .click();
  await expect(details(page)).toBeVisible();
  const form = details(page);
  await form.getByLabel("名前", { exact: true }).fill("T-02 液位");
  await form
    .getByLabel("タグの外部名", { exact: true })
    .fill("Demo.Water.Tank01.Level");
  await form.getByLabel("HH の値", { exact: true }).fill("90");
  await form
    .getByLabel("HH の重要度", { exact: true })
    .selectOption({ label: "高" });
  await form.getByLabel("H の値", { exact: true }).fill("80");
  await form.getByLabel("L の値", { exact: true }).fill("10");
  await form.getByLabel("deadband", { exact: true }).fill("2");
  await form.getByLabel("発生の遅延（ms）", { exact: true }).fill("500");
  await form
    .getByLabel("ACK の種類", { exact: true })
    .selectOption("autoOnReturn");
  await apply(page);
  await expect(status(page)).toContainText("変更を適用しました");
  const added = (await save(page)).alarms.definitions[2];
  expect(added).toMatchObject({
    name: "T-02 液位",
    enabled: true,
    source: {
      kind: "threshold",
      tag: "Demo.Water.Tank01.Level",
      limits: {
        hh: { value: 90, severity: "high" },
        h: { value: 80, severity: "medium" },
        l: { value: 10, severity: "medium" },
      },
      deadband: 2,
    },
    onDelayMs: 500,
    ackMode: "autoOnReturn",
  });
  expect(added.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

  // 限界の順序の違反は適用せず、理由を出す。
  await form.getByLabel("L の値", { exact: true }).fill("85");
  await apply(page);
  await expect(status(page)).toContainText("HH ≥ H > L ≥ LL");
  await form.getByLabel("L の値", { exact: true }).fill("15");
  await apply(page);
  await expect(status(page)).toContainText("変更を適用しました");

  // bit の警報は bit 型のタグだけ（タグ一覧があるとき）。
  await page
    .getByRole("button", { name: "bit の警報を追加", exact: true })
    .click();
  await form.getByLabel("名前", { exact: true }).fill("P-01 停止監視");
  await form
    .getByLabel("タグの外部名", { exact: true })
    .fill("Demo.Water.Tank01.Level");
  await apply(page);
  await expect(status(page)).toContainText("bit 型");
  await form
    .getByLabel("タグの外部名", { exact: true })
    .fill("Demo.Water.Pump01.Running");
  await form.getByLabel("発生の条件", { exact: true }).selectOption("false");
  await apply(page);
  await expect(status(page)).toContainText("変更を適用しました");

  // 複製・有効の切替・削除。
  await page.getByRole("button", { name: "警報を複製", exact: true }).click();
  await expect(
    table(page).getByRole("button", { name: "P-01 停止監視 コピー を選ぶ" }),
  ).toBeVisible();
  const toggle = table(page).getByRole("checkbox", {
    name: "P-01 停止監視 コピー を有効にする",
  });
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  const copy = (await save(page)).alarms.definitions[4];
  expect(copy).toMatchObject({
    name: "P-01 停止監視 コピー",
    enabled: false,
    source: { kind: "bit", activeWhen: false },
  });
  await page.getByRole("button", { name: "警報を削除", exact: true }).click();
  await expect(table(page).locator("tbody tr")).toHaveCount(4);

  // Undo / Redo。
  const undo = page.getByRole("button", { name: "元に戻す", exact: true });
  const redo = page.getByRole("button", { name: "やり直す", exact: true });
  await undo.first().click();
  await expect(table(page).locator("tbody tr")).toHaveCount(5);
  await undo.first().click();
  await expect(toggle).toBeChecked();
  await redo.first().click();
  await expect(toggle).not.toBeChecked();
  await redo.first().click();
  await expect(table(page).locator("tbody tr")).toHaveCount(4);

  // 保存した Project を開き直しても同じ定義が残る。
  const saved = await save(page);
  expect(saved.alarms.definitions.map((row: any) => row.name)).toEqual([
    ...sample.alarms.definitions.map((row) => row.name),
    "T-02 液位",
    "P-01 停止監視",
  ]);
  await openProject(page, {
    name: "alarms.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await selectPanel(page, "プロジェクト");
  await expect(table(page).locator("tbody tr")).toHaveCount(4);
  expect((await save(page)).alarms).toEqual(saved.alarms);
});

test("alarm blink setting and empty settings are not saved", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  await page.getByLabel("未確認の警報を点滅する", { exact: true }).check();
  expect((await save(page)).alarms.blinkUnacked).toBe(true);
  await page.getByLabel("未確認の警報を点滅する", { exact: true }).uncheck();
  for (const row of sample.alarms.definitions) {
    await table(page)
      .getByRole("button", { name: `${row.name} を選ぶ`, exact: true })
      .click();
    await page.getByRole("button", { name: "警報を削除", exact: true }).click();
  }
  await expect(page.getByText("警報の定義はありません。")).toBeVisible();
  expect(await save(page)).not.toHaveProperty("alarms");
});

test("changing an alarm tag asks before moving to another alarm", async ({
  page,
}) => {
  await open(page);
  const [first, second] = sample.alarms.definitions;
  await table(page)
    .getByRole("button", { name: `${first.name} を選ぶ`, exact: true })
    .click();
  const tag = details(page).getByLabel("タグの外部名", { exact: true });
  await tag.fill(" " + first.source.tag + " ");
  await table(page)
    .getByRole("button", { name: `${second.name} を選ぶ`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(table(page).locator("tr.selected")).toContainText(second.name);
  expect(
    (await save(page)).alarms.definitions.find(
      (row: { id: string }) => row.id === first.id,
    ).source.tag,
  ).toBe(" " + first.source.tag + " ");
});

for (const theme of ["light", "dark"])
  test(`alarm settings stay readable in ${theme}`, async ({ page }) => {
    await open(page);
    await chooseTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const first = sample.alarms.definitions[0];
    await table(page)
      .getByRole("button", { name: `${first.name} を選ぶ`, exact: true })
      .click();
    await expect(details(page)).toBeVisible();
    const row = table(page).locator("tr.selected");
    const [text, background] = await row.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor];
    });
    expect(text).not.toBe(background);
    await expect(details(page).getByLabel("名前", { exact: true })).toHaveValue(
      first.name,
    );
  });
