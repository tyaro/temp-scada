import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/recording.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
const dialog = (p: Page) =>
  p.getByRole("dialog", { name: "記録希望設定", exact: true });
const save = (p: Page) =>
  dialog(p).getByRole("button", { name: "Projectに保存", exact: true });
const saved = async (p: Page) =>
  JSON.parse((await downloadBytes(await downloadProject(p))).toString());
async function open(p: Page) {
  await p
    .getByRole("menubar")
    .getByRole("menuitem", { name: "ファイル", exact: true })
    .click();
  await p.getByRole("menuitem", { name: "記録希望設定", exact: true }).click();
}
async function load(p: Page, value: unknown = sample) {
  await openProject(p, {
    name: "recording.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
async function editMode(p: Page) {
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
}
for (const theme of ["light", "dark"] as const)
  test(`creates ordered number/bool desired settings in one Undo and round-trips (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1500, height: 1050 });
    await editMode(page);
    await chooseTheme(page, theme);
    await open(page);
    await dialog(page)
      .getByLabel("論理Hub参照", { exact: true })
      .fill("hub:test");
    await dialog(page)
      .getByLabel("タグ外部名 1", { exact: true })
      .fill(" 温度 ");
    await dialog(page).getByLabel("記録を希望する", { exact: true }).check();
    await dialog(page)
      .getByRole("button", { name: "系列を追加", exact: true })
      .click();
    await dialog(page)
      .getByLabel("タグ外部名 2", { exact: true })
      .fill("設備.運転");
    await dialog(page)
      .getByLabel("値の型 2", { exact: true })
      .selectOption("bool");
    await dialog(page)
      .getByRole("button", { name: "系列2を上へ", exact: true })
      .click();
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    const first = await saved(page);
    expect(first.recordingPlan).toMatchObject({
      revision: 1,
      enabled: true,
      group: { hubRef: "hub:test", periodMs: 1000 },
    });
    expect(
      first.recordingPlan.group.members.map((m: any) => [
        m.externalName,
        m.valueType,
      ]),
    ).toEqual([
      ["設備.運転", "bool"],
      [" 温度 ", "number"],
    ]);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    expect((await saved(page)).recordingPlan).toBeUndefined();
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    const redone = await saved(page);
    expect(redone.recordingPlan).toEqual(first.recordingPlan);
    await load(page, redone);
    expect((await saved(page)).recordingPlan).toEqual(first.recordingPlan);
    await open(page);
    await expect(save(page)).toBeEnabled();
    await page.screenshot({
      path: info.outputPath(`recording-editor-${theme}.png`),
    });
    await dialog(page)
      .getByRole("button", { name: "閉じる", exact: true })
      .last()
      .click();
    await expect(page.locator(".history-workspace")).toHaveCount(0);
  });
test("separates no-op/order edits, semantic revision updates and reversible removal while preserving unedited CR/LF", async ({
  page,
}) => {
  await editMode(page);
  const value = structuredClone(sample),
    text = " \r\n温度\u2028\u2029e\u0301 ";
  value.recordingPlan.group.members[0].externalName = text;
  await load(page, value);
  const original = await saved(page);
  await open(page);
  await save(page).click();
  expect(await saved(page)).toEqual(original);
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "系列2を上へ", exact: true })
    .click();
  await save(page).click();
  let state = await saved(page);
  expect(state.recordingPlan.revision).toBe(1);
  expect(state.recordingPlan.group.members).toEqual(
    [...original.recordingPlan.group.members].reverse(),
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await open(page);
  await dialog(page)
    .getByLabel("記録周期（ミリ秒）", { exact: true })
    .fill("2000");
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByLabel("希望設定の版", { exact: true })
    .fill("9007199254740991.1");
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByRole("button", { name: "次の版を使う", exact: true })
    .click();
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  state = await saved(page);
  expect(state.recordingPlan.revision).toBe(2);
  expect(state.recordingPlan.group.periodMs).toBe(2000);
  expect(state.recordingPlan.group.members[0].externalName).toBe(text);
  await open(page);
  await expect(dialog(page)).toContainText("稼働中の記録は停止しません");
  await dialog(page)
    .getByRole("button", { name: "Projectから除去", exact: true })
    .click();
  expect((await saved(page)).recordingPlan).toBeUndefined();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  expect((await saved(page)).recordingPlan).toEqual(state.recordingPlan);
});
test("protects invalid drafts, eight-member bounds, editable IDs, Escape and background shortcuts", async ({
  page,
}) => {
  await editMode(page);
  await load(page);
  const before = await saved(page);
  await open(page);
  const firstID = await dialog(page)
    .getByLabel("メンバーID 1", { exact: true })
    .inputValue();
  await dialog(page).getByLabel("メンバーID 2", { exact: true }).fill(firstID);
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByLabel("メンバーID 2", { exact: true })
    .fill("member:edited");
  await expect(
    dialog(page).getByLabel("メンバーID 2", { exact: true }),
  ).toBeFocused();
  for (let i = 2; i < 8; i++)
    await dialog(page)
      .getByRole("button", { name: "系列を追加", exact: true })
      .click();
  await expect(
    dialog(page).getByRole("button", { name: "系列を追加", exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .focus();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toContainText("未保存の入力があります");
  for (const key of ["Control+z", "Control+y", "Delete", "Control+a"])
    await page.keyboard.press(key);
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole("button", { name: "Projectから除去", exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole("button", { name: "入力を戻す", exact: true })
    .click();
  await expect(save(page)).toBeEnabled();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  expect(await saved(page)).toEqual(before);
});
test("maximum desired revision cannot overflow and a different plan ID is an explicit new plan", async ({
  page,
}) => {
  await editMode(page);
  const value = structuredClone(sample);
  value.recordingPlan.revision = Number.MAX_SAFE_INTEGER;
  await load(page, value);
  await open(page);
  await dialog(page).getByLabel("記録を希望する", { exact: true }).check();
  await expect(save(page)).toBeDisabled();
  await expect(
    dialog(page).getByRole("button", { name: "次の版を使う", exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByLabel("計画ID", { exact: true })
    .fill("plan:explicit-new");
  await dialog(page).getByLabel("希望設定の版", { exact: true }).fill("1");
  await save(page).click();
  expect((await saved(page)).recordingPlan).toMatchObject({
    planId: "plan:explicit-new",
    revision: 1,
    enabled: true,
  });
});
test("retires the old draft on same-ID/revision Project replacement and offers the sidebar entry", async ({
  page,
}) => {
  await editMode(page);
  await load(page);
  await open(page);
  await dialog(page)
    .getByLabel("タグ外部名 1", { exact: true })
    .fill("old draft");
  const replacement = structuredClone(sample);
  replacement.manifest.name = "入れ替え後";
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("project-status")).toHaveText(
    "Project を読み込みました。",
  );
  expect((await saved(page)).recordingPlan).toEqual(replacement.recordingPlan);
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "記録希望設定", exact: true }).click();
  await expect(
    dialog(page).getByLabel("タグ外部名 1", { exact: true }),
  ).toHaveValue(sample.recordingPlan.group.members[0].externalName);
  await save(page).click();
  await expect(
    page.getByRole("button", { name: "記録希望設定", exact: true }),
  ).toBeFocused();
  expect((await saved(page)).recordingPlan).toEqual(sample.recordingPlan);
});
test("resolves pending Project form edits before capturing the recording editor owner", async ({
  page,
}) => {
  await editMode(page);
  await selectPanel(page, "プロジェクト");
  const input = page
    .getByRole("form", { name: "プロジェクト情報" })
    .getByLabel("プロジェクト名", { exact: true });
  await input.fill("未適用のProject名");
  await open(page);
  const pending = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(pending).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await pending
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(input).toHaveValue("未適用のProject名");
  await open(page);
  await pending
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  const result = await saved(page);
  expect(result.manifest.name).toBe("未適用のProject名");
  expect(result.recordingPlan).toBeUndefined();
});
