import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { selectPanel, fileCommand, chooseTheme } from "./helpers/designer";
import { readFile } from "node:fs/promises";
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "types.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  return library;
}
async function saved(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
for (const theme of ["light", "dark"] as const)
  test(`custom equipment kind connects registration, adoption, Symbol and read details in ${theme}`, async ({
    page,
  }) => {
    const library = await start(page);
    await chooseTheme(page, theme);
    const editor = page.getByRole("region", {
      name: "機器種別の編集",
      exact: true,
    });
    await editor.getByLabel("種別名", { exact: true }).fill("任意圧力計");
    await editor
      .getByRole("button", { name: "読取slotを追加", exact: true })
      .click();
    await editor.getByLabel("slot名", { exact: true }).fill("pressure");
    await editor
      .getByRole("button", { name: "機器種別を作成", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "機器種別を適用", exact: true }),
    ).toBeVisible();
    const typeId = await editor
      .getByLabel("編集する機器種別", { exact: true })
      .inputValue();
    expect(typeId).not.toBe("");
    await library
      .getByRole("button", { name: "機器一覧", exact: true })
      .click();
    const create = library.getByRole("form", {
      name: "機器を登録",
      exact: true,
    });
    await create
      .getByRole("combobox", { name: "機器種別", exact: true })
      .selectOption(typeId);
    await create.getByLabel("機器番号", { exact: true }).fill("PT-901");
    await create.getByLabel("機器名", { exact: true }).fill("追加圧力計");
    await create
      .getByRole("button", { name: "機器を登録", exact: true })
      .click();
    const edit = library.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    await edit
      .getByRole("combobox", { name: "採用・割付状態", exact: true })
      .selectOption("unassigned");
    await edit
      .getByRole("button", { name: "機器情報と割付を適用", exact: true })
      .click();
    const data = await saved(page),
      item = data.equipment.find((item: any) => item.code === "PT-901");
    expect(
      data.equipmentTypes.find((type: any) => type.id === typeId).slots,
    ).toEqual([{ name: "pressure", type: "number", direction: "read" }]);
    await library
      .getByRole("button", { name: "機器種別", exact: true })
      .click();
    await editor
      .getByLabel("編集する機器種別", { exact: true })
      .selectOption(typeId);
    await expect(editor.getByLabel("slot名", { exact: true })).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(editor.getByLabel("slot型", { exact: true })).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "slotを削除", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "この機器種別を削除", exact: true }),
    ).toBeDisabled();
    await selectPanel(page, "レイヤー");
    await page
      .locator(`button[data-layer-id="${sample.screens[0].objects[0].id}"]`)
      .click();
    await page
      .getByLabel("関連付ける機器", { exact: true })
      .selectOption(item.id);
    await page
      .getByRole("button", { name: "関連機器の読取詳細を開く", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "未適用の入力があります", exact: true })
      .getByRole("button", { name: "適用して続行", exact: true })
      .click();
    const window = page.locator(`[data-preview-popup="${item.id}"]`);
    await expect(
      window.locator('[data-equipment-slot="pressure"]'),
    ).toHaveAttribute("data-slot-state", "unassigned");
    await expect(window).toContainText("PT-901");
  });
test("structural draft survives cancel, discards correctly and applies as one Undo; invalid roles retain input", async ({
  page,
}) => {
  const library = await start(page),
    editor = page.getByRole("region", { name: "機器種別の編集", exact: true });
  await editor
    .getByLabel("編集する機器種別", { exact: true })
    .selectOption(sample.equipmentTypes[0].id);
  const initialRows = await editor
    .locator("[data-equipment-type-slot]")
    .count();
  await editor
    .getByRole("button", { name: "読取slotを追加", exact: true })
    .click();
  await editor.getByLabel("slot名", { exact: true }).last().fill("temperature");
  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(editor.getByLabel("slot名", { exact: true }).last()).toHaveValue(
    "temperature",
  );
  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  await editor
    .getByLabel("編集する機器種別", { exact: true })
    .selectOption(sample.equipmentTypes[0].id);
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(
    initialRows,
  );
  await editor
    .getByRole("button", { name: "読取slotを追加", exact: true })
    .click();
  await editor.getByLabel("slot名", { exact: true }).last().fill("bad name");
  await editor
    .getByRole("button", { name: "機器種別を適用", exact: true })
    .click();
  await expect(editor.getByLabel("slot名", { exact: true }).last()).toHaveValue(
    "bad name",
  );
  await expect(
    page.getByRole("alert").getByText("slot名は英字", { exact: false }),
  ).toBeVisible();
  await editor.getByLabel("slot名", { exact: true }).last().fill("temperature");
  await editor
    .getByRole("button", { name: "機器種別を適用", exact: true })
    .click();
  expect((await saved(page)).equipmentTypes[0].slots).toHaveLength(
    initialRows + 1,
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(
    initialRows,
  );
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await editor
    .getByRole("button", { name: "slotを削除", exact: true })
    .last()
    .click();
  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(
    initialRows,
  );
  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  expect((await saved(page)).equipmentTypes[0].slots).toHaveLength(initialRows);
});

test("empty custom kind can be renamed and deleted with Undo, and IME does not submit a row", async ({
  page,
}) => {
  const library = await start(page),
    editor = page.getByRole("region", { name: "機器種別の編集", exact: true });
  await editor.getByLabel("種別名", { exact: true }).fill("信号なし");
  await editor
    .getByRole("button", { name: "機器種別を作成", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "機器種別を適用", exact: true }),
  ).toBeVisible();
  const id = await editor
    .getByLabel("編集する機器種別", { exact: true })
    .inputValue();
  await editor.getByLabel("種別名", { exact: true }).fill("監視詳細なし");
  await editor
    .getByRole("button", { name: "機器種別を適用", exact: true })
    .click();
  expect(
    (await saved(page)).equipmentTypes.find((type: any) => type.id === id).name,
  ).toBe("監視詳細なし");
  await editor
    .getByRole("button", { name: "読取slotを追加", exact: true })
    .click();
  const role = editor.getByLabel("slot名", { exact: true });
  await role.fill("speed");
  await role.dispatchEvent("compositionstart");
  await role.press("Enter");
  await role.dispatchEvent("compositionend");
  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  await editor.getByLabel("編集する機器種別", { exact: true }).selectOption(id);
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(0);
  await editor
    .getByRole("button", { name: "この機器種別を削除", exact: true })
    .click();
  await expect(
    editor.getByLabel("編集する機器種別", { exact: true }),
  ).toHaveValue("");
  expect(
    (await saved(page)).equipmentTypes.some((type: any) => type.id === id),
  ).toBe(false);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  expect(
    (await saved(page)).equipmentTypes.find((type: any) => type.id === id)
      .slots,
  ).toEqual([]);
});

test("immediate navigation after a structural change cannot drop the draft, and cancelling type selection restores the selected option", async ({
  page,
}) => {
  const library = await start(page),
    editor = page.getByRole("region", { name: "機器種別の編集", exact: true });
  const selector = editor.getByLabel("編集する機器種別", { exact: true });
  await selector.selectOption(sample.equipmentTypes[0].id);
  const initialRows = await editor
    .locator("[data-equipment-type-slot]")
    .count();
  await library.evaluate((element) => {
    const buttons = [...element.querySelectorAll("button")];
    buttons
      .find((button) => button.textContent?.trim() === "読取slotを追加")!
      .click();
    buttons
      .find((button) => button.textContent?.trim() === "機器一覧")!
      .click();
  });
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(
    initialRows + 1,
  );
  await selector.selectOption("");
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(selector).toHaveValue(sample.equipmentTypes[0].id);
  await selector.selectOption("");
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(selector).toHaveValue("");
  await expect(editor.locator("[data-equipment-type-slot]")).toHaveCount(0);
});
