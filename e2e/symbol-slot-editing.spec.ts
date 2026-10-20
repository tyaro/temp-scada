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
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  return page.getByRole("region", {
    name: "共有Symbolの読取slot",
    exact: true,
  });
}
for (const theme of ["light", "dark"] as const)
  test(`arbitrary slot declarations edit, undo, persist and protect used Text in ${theme}`, async ({
    page,
  }) => {
    const panel = await open(page);
    await chooseTheme(page, theme);
    const used = panel.getByRole("region", {
      name: "slot宣言 running",
      exact: true,
    });
    await expect(
      used.getByRole("button", { name: "宣言を削除", exact: true }),
    ).toBeDisabled();
    await expect(used).toContainText("Text 1 件で使用中");
    const create = panel.getByRole("form", {
      name: "読取slotを追加",
      exact: true,
    });
    await create.getByLabel("slot名", { exact: true }).fill("pressure");
    await create.getByLabel("slot型", { exact: true }).selectOption("number");
    await create
      .getByRole("button", { name: "宣言を追加", exact: true })
      .click();
    await expect(create.getByLabel("slot名", { exact: true })).toHaveValue("");
    const pressure = panel.getByRole("form", {
      name: "slot宣言 pressure を編集",
      exact: true,
    });
    await pressure.getByLabel("slot名", { exact: true }).fill("enabled");
    await pressure.getByLabel("slot型", { exact: true }).selectOption("bool");
    await pressure
      .getByRole("button", { name: "宣言を適用", exact: true })
      .click();
    await expect(
      panel.getByRole("form", { name: "slot宣言 enabled を編集", exact: true }),
    ).toBeVisible();
    await button(page, "元に戻す").click();
    await expect(pressure.getByLabel("slot名", { exact: true })).toHaveValue(
      "pressure",
    );
    await button(page, "やり直す").click();
    const enabled = panel.getByRole("region", {
      name: "slot宣言 enabled",
      exact: true,
    });
    await enabled
      .getByRole("button", { name: "enabled · bool 表示を追加", exact: true })
      .click();
    await expect(
      enabled.getByRole("button", { name: "宣言を削除", exact: true }),
    ).toBeDisabled();
    await expect(enabled).toContainText("Text 1 件で使用中");
    const waiting = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await waiting).path())!, "utf8"),
    );
    expect(saved.symbols[0].readSlots.at(-1)).toEqual({
      name: "enabled",
      type: "bool",
      direction: "read",
    });
    expect(saved.equipment).toEqual(sample.equipment);
    expect(saved.manifest.schemaVersion).toBe("0.28.0");
    await button(page, "画面へ戻る").click();
    await expect(
      page.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
    ).toHaveCount(0);
  });
test("slot drafts survive duplicate rejection, other row actions and IME, then unused declarations can be removed", async ({
  page,
}) => {
  const panel = await open(page),
    create = panel.getByRole("form", { name: "読取slotを追加", exact: true });
  const name = create.getByLabel("slot名", { exact: true });
  await name.fill("pressure");
  await name.dispatchEvent("compositionstart");
  await name.press("Enter");
  await expect(
    panel.getByRole("region", { name: "slot宣言 pressure", exact: true }),
  ).toHaveCount(0);
  await name.dispatchEvent("compositionend");
  await create.getByRole("button", { name: "宣言を追加", exact: true }).click();
  const pressure = panel.getByRole("form", {
    name: "slot宣言 pressure を編集",
    exact: true,
  });
  await pressure.getByLabel("slot名", { exact: true }).fill("running");
  await pressure
    .getByRole("button", { name: "宣言を適用", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText("重複");
  await expect(pressure.getByLabel("slot名", { exact: true })).toHaveValue(
    "running",
  );
  await panel
    .getByRole("button", { name: "value · number 表示を追加", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(pressure.getByLabel("slot名", { exact: true })).toHaveValue(
    "running",
  );
  await pressure.getByLabel("slot名", { exact: true }).fill("pressure");
  const row = panel.getByRole("region", {
    name: "slot宣言 pressure",
    exact: true,
  });
  await row.getByRole("button", { name: "宣言を削除", exact: true }).click();
  await expect(row).toHaveCount(0);
  await button(page, "元に戻す").click();
  await expect(row).toBeVisible();
  await create.getByLabel("slot名", { exact: true }).fill("pending");
  await button(page, "画面へ戻る").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(create.getByLabel("slot名", { exact: true })).toHaveValue(
    "pending",
  );
});

test("applying a rename before delayed Text insertion never recreates the old declaration", async ({
  page,
}) => {
  const panel = await open(page),
    create = panel.getByRole("form", { name: "読取slotを追加", exact: true });
  await create.getByLabel("slot名", { exact: true }).fill("pressure");
  await create.getByRole("button", { name: "宣言を追加", exact: true }).click();
  const pressure = panel.getByRole("region", {
    name: "slot宣言 pressure",
    exact: true,
  });
  await pressure.getByLabel("slot名", { exact: true }).fill("enabled");
  await pressure
    .getByRole("button", { name: "pressure · number 表示を追加", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(pressure).toHaveCount(0);
  const enabled = panel.getByRole("region", {
    name: "slot宣言 enabled",
    exact: true,
  });
  await expect(
    enabled.getByRole("button", { name: "宣言を削除", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("project-status")).toContainText(
    "変更されました",
  );
});
