import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function open(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "slots.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
}
for (const theme of ["light", "dark"] as const)
  test(`slot contexts remain distinct across preview and editing in ${theme}`, async ({
    page,
  }) => {
    await open(page);
    await chooseTheme(page, theme);
    const canvas = page.locator(".sheet > svg");
    const text = (index: number) =>
      canvas.locator(
        `[data-object-id="${sample.screens[0].objects[index].id}"] [data-tag-state]`,
      );
    await expect(text(0).nth(0)).toHaveAttribute(
      "data-tag-state",
      "unassigned",
    );
    await expect(text(0).nth(1)).toHaveAttribute("data-tag-state", "unadopted");
    await expect(text(2).nth(0)).toHaveAttribute(
      "data-tag-state",
      "disconnected",
    );
    await expect(text(2).nth(1)).toHaveAttribute(
      "data-tag-state",
      "unassigned",
    );
    await expect(text(4).nth(0)).toHaveAttribute("data-tag-state", "unbound");
    await expect(canvas).not.toContainText("STATIC FALLBACK");
    await button(page, "表示プレビュー").click();
    await expect(text(0).nth(0)).toHaveAttribute(
      "data-tag-state",
      "unassigned",
    );
    await expect(text(2).nth(0)).toHaveAttribute(
      "data-tag-state",
      "disconnected",
    );
    await button(page, "編集").click();
    await selectPanel(page, "プロジェクト");
    await button(page, "定義を編集").click();
    await expect(canvas.locator('[data-tag-state="unbound"]')).toHaveCount(2);
    await button(page, "value · number 表示を追加").click();
    await expect(canvas.locator('[data-tag-state="unbound"]')).toHaveCount(3);
    await button(page, "元に戻す").click();
    await expect(canvas.locator('[data-tag-state="unbound"]')).toHaveCount(2);
    await button(page, "やり直す").click();
    await expect(canvas.locator('[data-tag-state="unbound"]')).toHaveCount(3);
    const download = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(saved.symbols[0].readSlots).toHaveLength(3);
    expect(saved.symbols[0].objects.at(-1).shape.slotBinding).toEqual({
      slotName: "value",
    });
    expect(saved.manifest.schemaVersion).toBe("0.25.0");
  });
test("slot selection is draft protected, applies with Undo and refuses clipboard cut", async ({
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
  const slot = form.getByRole("combobox", { name: "読取slot", exact: true });
  await expect(slot).toHaveValue("running");
  await slot.selectOption("current");
  await button(page, "画面へ戻る").click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(slot).toHaveValue("current");
  await form.getByRole("button", { name: "変更を適用", exact: true }).click();
  await button(page, "元に戻す").click();
  await expect(slot).toHaveValue("running");
  await page.evaluate(() =>
    navigator.clipboard.writeText("preserved clipboard"),
  );
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("project-status")).toContainText(
    "slot表示単体",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "preserved clipboard",
  );
  await expect(
    page.locator(`.sheet > svg [data-object-id="${object.id}"]`),
  ).toHaveCount(1);
});
