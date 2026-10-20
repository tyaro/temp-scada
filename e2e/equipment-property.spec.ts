import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/equipment-property.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function open(page: Page, project = structuredClone(sample)) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "metadata.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(
    page.locator(".sheet > svg [data-equipment-property]").first(),
  ).toBeVisible();
}
const canvas = (page: Page) => page.locator(".sheet > svg");
const first = sample.screens[0].objects[0];
const currentName = (page: Page) =>
  canvas(page).locator(
    `[data-object-id="${first.id}"] [data-equipment-property="name"]`,
  );
for (const theme of ["light", "dark"] as const)
  test(`metadata contexts, preview, minimap and definition examples in ${theme}`, async ({
    page,
  }) => {
    await open(page);
    await chooseTheme(page, theme);
    for (const object of sample.screens[0].objects.filter(
      (o) => o.shape.type === "symbol",
    )) {
      const equipment =
        object.shape.type === "symbol"
          ? sample.equipment.find((e) => e.id === object.shape.equipmentId)
          : undefined;
      const fields = canvas(page).locator(
        `[data-object-id="${object.id}"] [data-equipment-property]`,
      );
      await expect(fields).toHaveCount(3);
      await expect(fields.nth(0)).toHaveAttribute(
        "data-equipment-property-state",
        equipment ? "resolved" : "unbound",
      );
      await expect(fields.nth(1)).toContainText(
        equipment?.name ?? "機器未関連付け",
      );
    }
    await expect(
      page
        .locator(
          '[aria-label="ミニマップ"] [data-equipment-property-state="resolved"]',
        )
        .first(),
    ).toBeAttached();
    await button(page, "表示プレビュー").click();
    await expect(currentName(page)).toContainText(sample.equipment[0].name);
    await expect(canvas(page)).not.toContainText("：例示");
    await button(page, "編集").click();
    await selectPanel(page, "プロジェクト");
    await button(page, "定義を編集").click();
    await expect(
      canvas(page).locator('[data-equipment-property-state="example"]'),
    ).toHaveCount(3);
    await expect(canvas(page)).toContainText("〈機器名：例示〉");
    await expect(canvas(page)).not.toContainText("STATIC METADATA FALLBACK");
  });
test("ledger metadata applies once, supports Undo and does not expose drafts", async ({
  page,
}) => {
  await open(page);
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library
    .getByRole("button", {
      name: `${sample.equipment[0].code} · ${sample.equipment[0].name}`,
      exact: true,
    })
    .click();
  const form = library.getByRole("form", {
    name: "機器情報と割付",
    exact: true,
  });
  const longName = "原水移送ポンプ・長い名称の全文はタイトルから確認できます";
  await form.getByLabel("機器名", { exact: true }).fill(longName);
  await expect(currentName(page)).toContainText(sample.equipment[0].name);
  await form
    .getByRole("button", { name: "機器情報と割付を適用", exact: true })
    .click();
  await expect(currentName(page)).toContainText(longName);
  await expect(currentName(page)).toHaveAttribute(
    "data-text-layout",
    "ellipsis",
  );
  await expect(currentName(page).locator("title")).toContainText(longName);
  await button(page, "元に戻す").click();
  await expect(currentName(page)).toContainText(sample.equipment[0].name);
  await button(page, "やり直す").click();
  await expect(currentName(page)).toContainText(longName);
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  const typeEditor = library.getByRole("region", {
    name: "機器種別の編集",
    exact: true,
  });
  await typeEditor
    .getByLabel("編集する機器種別", { exact: true })
    .selectOption(sample.equipmentTypes[0].id);
  await typeEditor
    .getByLabel("種別名", { exact: true })
    .fill("移送設備 共通種別");
  await expect(canvas(page)).not.toContainText("移送設備 共通種別");
  await typeEditor
    .getByRole("button", { name: "機器種別を適用", exact: true })
    .click();
  await expect(
    canvas(page)
      .locator(
        '[data-equipment-property="typeName"][data-equipment-property-state="resolved"]',
      )
      .first(),
  ).toContainText("移送設備 共通種別");
  await button(page, "元に戻す").click();
  await expect(canvas(page)).not.toContainText("移送設備 共通種別");
});
test("display-source draft guards navigation and metadata cut preserves clipboard", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const object = sample.symbols[0].objects[5];
  await page.locator(`button[data-layer-id="${object.id}"]`).click();
  const form = page.locator('form[data-editor-form="object"]');
  const source = form.getByRole("combobox", { name: "表示元", exact: true });
  await source.selectOption("@name");
  await button(page, "画面へ戻る").click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(source).toHaveValue("@name");
  await form.getByRole("button", { name: "変更を適用", exact: true }).click();
  await expect(
    canvas(page).locator('[data-equipment-property="name"]'),
  ).toHaveCount(2);
  await button(page, "元に戻す").click();
  await expect(source).toHaveValue("running");
  await button(page, "やり直す").click();
  await expect(source).toHaveValue("@name");
  await page.evaluate(() =>
    navigator.clipboard.writeText("preserve metadata clipboard"),
  );
  await page.locator(`button[data-layer-id="${object.id}"]`).focus();
  await page.keyboard.press("Control+x");
  await expect(
    page.getByRole("status").filter({ hasText: "機器情報単体" }).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "preserve metadata clipboard",
  );
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const data = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  expect(data.symbols[0].objects[5].shape.equipmentProperty).toEqual({
    field: "name",
  });
  expect(data.symbols[0].objects[5].shape.slotBinding).toBeUndefined();
});
test("unbinding and Project replacement clear metadata instead of retaining the last equipment", async ({
  page,
}) => {
  await open(page);
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${first.id}"]`).click();
  const form = page.locator('form[data-editor-form="object"]');
  await form
    .getByRole("combobox", { name: "関連付ける機器", exact: true })
    .selectOption("");
  await form.getByRole("button", { name: "変更を適用", exact: true }).click();
  await expect(currentName(page)).toHaveAttribute(
    "data-equipment-property-state",
    "unbound",
  );
  await expect(currentName(page)).not.toContainText(sample.equipment[0].name);
  await button(page, "元に戻す").click();
  await expect(currentName(page)).toContainText(sample.equipment[0].name);
  const replacement = structuredClone(sample);
  replacement.equipment[0].name = "置き換え後の機器";
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(currentName(page)).toContainText("置き換え後の機器");
  await expect(currentName(page)).not.toContainText(sample.equipment[0].name);
});

test("embedded source and preview popup share each placement's current metadata", async ({
  page,
}) => {
  const project = structuredClone(sample);
  const source = structuredClone(project.screens[0]);
  source.id = "019a0000-0000-7000-8000-000000009100";
  source.name = "機器情報の共通画面";
  for (let i = 0; i < source.objects.length; i++)
    source.objects[i].id =
      `019a0000-0000-7000-8000-0000000092${String(i).padStart(2, "0")}`;
  project.screens.push(source);
  // @ts-expect-error fixture extends inferred JSON union with an embedded View.
  project.screens[0].objects = [
    {
      id: "019a0000-0000-7000-8000-000000009300",
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      rotation: 0,
      order: 0,
      shape: { type: "screenView", screenId: source.id, fit: "contain" },
    },
  ];
  await open(page, project);
  const embedded = canvas(page).locator(
    `[data-source-object-id="${source.objects[0].id}"] [data-equipment-property="name"]`,
  );
  await expect(embedded).toContainText(sample.equipment[0].name);
  await expect(embedded).toHaveAttribute(
    "data-equipment-property-state",
    "resolved",
  );
  await button(page, "表示プレビュー").click();
  await button(page, "画面を小窓で表示確認").click();
  const picker = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await picker.locator(`input[value="${source.id}"]`).check();
  await picker.getByRole("button", { name: "小窓を表示", exact: true }).click();
  const popup = page.locator(`[data-preview-popup="${source.id}"]`);
  await expect(
    popup.locator('[data-equipment-property="name"]').first(),
  ).toContainText(sample.equipment[0].name);
  await expect(popup).not.toContainText("：例示");
});
