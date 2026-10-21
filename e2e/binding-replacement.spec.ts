import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, fileCommand } from "./helpers/designer";
import sample from "../examples/tag-binding.project.json" with { type: "json" };
const from = "PLC01.Fast.Tank01.Level";
function fixture(locked = false, destination = false) {
  const p = structuredClone(sample);
  p.screens[0].name = "原水監視";
  const second = structuredClone(p.screens[0]);
  second.id = "0199f000-0000-7000-8000-000000000010";
  second.name = "処理水監視";
  second.objects.forEach(
    (o, i) => (o.id = `0199f000-0000-7000-8000-00000000001${i + 1}`),
  );
  Object.assign(second.objects[2], { visible: false, locked });
  if (destination)
    (second.objects[2].shape as any).binding.externalName = "New.Level";
  p.screens.push(second);
  return p;
}
async function setup(page: Page, locked = false, destination = false) {
  await page.goto("/");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture(locked, destination))),
  });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: "Project のタグ参照" })
    .click();
  await page
    .getByRole("button", { name: `${from} を一括置換`, exact: true })
    .click();
  return page.getByRole("form", { name: "タグ参照名の一括置換" });
}
for (const theme of ["light", "dark"] as const)
  test(`batch reference replacement previews all screens, preserves disconnected state and survives Undo/save in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const form = await setup(page);
    await chooseTheme(page, theme);
    await page.getByLabel("タグ参照を検索").fill("原水監視");
    await form.getByLabel("置換先", { exact: true }).fill("PLC01.New.Level");
    await form.getByRole("button", { name: "差分を確認", exact: true }).click();
    const diff = form.getByRole("region", { name: "置換の差分" });
    await expect(diff).toContainText("対象 2 配置");
    await expect(diff).toContainText("処理水監視");
    await expect(diff).toContainText("非表示");
    if (process.env.SCADA_SCREENSHOT_DIR) {
      await page
        .getByRole("separator", { name: "タグ参照パネルの高さ", exact: true })
        .press("End");
      await form.screenshot({
        path: `${process.env.SCADA_SCREENSHOT_DIR}/binding-replacement-${theme}.png`,
      });
    }
    await form
      .getByRole("button", { name: "全2配置を置換", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    await expect(
      page.locator('[data-tag-reference="PLC01.New.Level"]'),
    ).toContainText("未接続");
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(page.locator(`[data-tag-reference="${from}"]`)).toBeVisible();
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    for (const screen of saved.screens)
      expect(screen.objects[2].shape.binding.externalName).toBe(
        "PLC01.New.Level",
      );
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(saved)),
    });
    await expect(
      page.locator("summary").filter({ hasText: "Project のタグ参照" }),
    ).toContainText("1 タグ / 2 配置");
  });
test("invalid, no-op, IME and cancel never apply, and locked placements reject the entire replacement", async ({
  page,
}) => {
  const form = await setup(page, true);
  const input = form.getByLabel("置換先", { exact: true });
  await input.fill(" ");
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await input.fill(from);
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  await expect(form).toContainText("変更はありません");
  await expect(
    form.getByRole("button", { name: "全2配置を置換" }),
  ).toBeDisabled();
  await input.fill("New.Level");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(form.getByRole("region", { name: "置換の差分" })).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  await expect(form).toContainText("全件を置換できません");
  await expect(
    form.getByRole("button", { name: "全2配置を置換" }),
  ).toBeDisabled();
  await form.getByRole("button", { name: "置換を取消", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toContainText(
    "読込後の変更なし",
  );
});
test("pending replacement uses draft protection and cannot silently apply during another operation", async ({
  page,
}) => {
  const form = await setup(page);
  await form.getByLabel("置換先", { exact: true }).fill("New.Level");
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  await page
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(form.getByLabel("置換先", { exact: true })).toHaveValue(
    "New.Level",
  );
  await page
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.locator(`[data-tag-reference="${from}"]`)).toBeVisible();
  await expect(form).toBeVisible();
  await page
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(form.getByLabel("置換先", { exact: true })).toHaveValue("");
});

test("opening replacement preserves other drafts, and importing a Project clears the old replacement", async ({
  page,
}) => {
  let form = await setup(page);
  await form.getByRole("button", { name: "置換を取消", exact: true }).click();
  await page
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  const external = page.locator('input[name="externalName"]');
  await external.fill("Unsaved.Level");
  await page
    .getByRole("button", { name: `${from} を一括置換`, exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(external).toHaveValue("Unsaved.Level");
  await page
    .getByRole("button", { name: `${from} を一括置換`, exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  form = page.getByRole("form", { name: "タグ参照名の一括置換" });
  await form.getByLabel("置換先", { exact: true }).fill("New.Level");
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture())),
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(form.getByLabel("置換先", { exact: true })).toHaveValue(
    "New.Level",
  );
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture())),
  });
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toContainText(
    "読込後の変更なし",
  );
});

test("merging into an existing saved reference lists the destination and requires explicit application", async ({
  page,
}) => {
  const form = await setup(page, false, true);
  await form.getByLabel("置換先", { exact: true }).fill("New.Level");
  await form.getByRole("button", { name: "差分を確認", exact: true }).click();
  const diff = form.getByRole("region", { name: "置換の差分" });
  await expect(diff).toContainText("対象 1 配置 · 既存の置換先 1 配置");
  await expect(diff).toContainText("次の既存使用先と同じ参照名になります");
  await expect(diff).toContainText("処理水監視");
  await form
    .getByRole("button", { name: "全1配置を置換", exact: true })
    .click();
  await expect(
    page.locator("summary").filter({ hasText: "Project のタグ参照" }),
  ).toContainText("1 タグ / 2 配置");
});
