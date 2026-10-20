import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileCommand } from "./helpers/designer";
const sample = JSON.parse(
  readFileSync("examples/equipment-symbol.project.json", "utf8"),
);
const object = sample.screens[0].objects[10],
  equipment = sample.equipment[0];
for (const theme of ["light", "dark"] as const) {
  test(`equipment association, usages, clearing and Undo in ${theme}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "テーマを変更", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: theme === "light" ? "ライト" : "ダーク",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "association.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .getByRole("button", { name: "P-101 · 循環ポンプ", exact: true })
      .click();
    await expect(
      library.getByRole("button", { name: "この機器を削除", exact: true }),
    ).toBeDisabled();
    const usages = library.getByRole("region", {
      name: "機器の使用先",
      exact: true,
    });
    await usages.getByRole("button").click();
    const form = page.locator('form[data-editor-form="object"]');
    const select = form.getByRole("combobox", {
      name: "関連付ける機器",
      exact: true,
    });
    await expect(select).toHaveValue(equipment.id);
    await select.selectOption("");
    await form.getByRole("button", { name: "変更を適用", exact: true }).click();
    await expect(usages).toContainText("図面の使用先 0 件");
    await expect(
      library.getByRole("button", { name: "この機器を削除", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(select).toHaveValue(equipment.id);
    const save = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await save).path())!, "utf8"),
    );
    expect(saved.manifest.schemaVersion).toBe("0.25.0");
    expect(saved.screens[0].objects[10].shape.equipmentId).toBe(equipment.id);
  });
}
test("bound equipment clipboard and cut reject the whole selection without changing clipboard or project", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "association.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
  await page.locator(`button[data-layer-id="${object.id}"]`).click();
  await page.evaluate(() =>
    navigator.clipboard.writeText("preserved clipboard"),
  );
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await canvas.focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("project-status")).toContainText("未対応");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "preserved clipboard",
  );
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(
    sample.screens[0].objects.length,
  );
  await page.keyboard.press("Control+d");
  await expect(page.locator(".sheet > svg [data-object-id]")).toHaveCount(
    sample.screens[0].objects.length + 1,
  );
});
