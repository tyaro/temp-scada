import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import type { Project } from "../apps/banto-scada/src/lib/project";
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function open(
  page: Page,
  project: Project = structuredClone(sample) as Project,
) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "array.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+a");
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "配列複製", exact: true });
async function exported(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  ) as Project;
}
for (const theme of ["light", "dark"] as const)
  test(`array toolbar action copies all selected placements and supports one Undo in ${theme}`, async ({
    page,
  }) => {
    await open(page);
    await chooseTheme(page, theme);
    await button(page, "配列複製").click();
    const form = dialog(page).getByRole("form", {
      name: "配列複製の設定",
      exact: true,
    });
    await form.getByLabel("列数", { exact: true }).fill("3");
    await form.getByLabel("行数", { exact: true }).fill("2");
    await form.getByLabel("横の間隔", { exact: true }).fill("125.5");
    await form.getByLabel("縦の間隔", { exact: true }).fill("-73.25");
    await expect(form).toContainText("追加15配置");
    await form.getByRole("button", { name: "配列を複製", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    const next = await exported(page);
    expect(next.screens[0].objects).toHaveLength(18);
    expect(next.screens[0].objects.slice(0, 3)).toEqual(
      sample.screens[0].objects,
    );
    expect(next.screens[0].objects[3].x).toBe(
      sample.screens[0].objects[0].x + 125.5,
    );
    expect(next.screens[0].objects.at(-1)!.y).toBe(
      sample.screens[0].objects[2].y - 73.25,
    );
    await button(page, "元に戻す").click();
    await expect(button(page, "元に戻す")).toBeDisabled();
    expect((await exported(page)).screens).toEqual(sample.screens);
    await button(page, "やり直す").click();
    expect((await exported(page)).screens).toEqual(next.screens);
  });
test("context action resolves pending input before opening and preserves separate Undo", async ({
  page,
}) => {
  await open(page);
  const color = page.getByLabel("適用する色", { exact: true });
  await color.fill("#123456");
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[0].id}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "配列複製", exact: true }).click();
  const pending = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(pending).toBeVisible();
  await pending
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(dialog(page)).toBeHidden();
  await button(page, "配列複製").click();
  await pending
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "配列を複製", exact: true })
    .click();
  expect((await exported(page)).screens[0].objects).toHaveLength(6);
  await button(page, "元に戻す").click();
  const colored = await exported(page);
  expect(colored.screens[0].objects).toHaveLength(3);
  expect(colored.screens[0].objects[2].fill).toBe("#123456");
  await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(sample.screens);
});
test("invalid steps, budgets and composing Enter cannot apply, cancel leaves no history", async ({
  page,
}) => {
  await open(page);
  await button(page, "配列複製").click();
  const form = dialog(page).getByRole("form");
  await form.getByLabel("横の間隔", { exact: true }).fill("0");
  await form.getByRole("button", { name: "配列を複製", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("0以外");
  await form.getByLabel("横の間隔", { exact: true }).fill("100");
  await form.getByLabel("列数", { exact: true }).fill("101");
  await form.getByRole("button", { name: "配列を複製", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("2〜100");
  const columns = form.getByLabel("列数", { exact: true });
  await columns.fill("3");
  await columns.dispatchEvent("compositionstart");
  await columns.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await columns.dispatchEvent("compositionend");
  await page.keyboard.press("Control+s");
  await expect(dialog(page)).toBeVisible();
  await form.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await exported(page)).screens).toEqual(sample.screens);
});
test("array copies independent group memberships and keeps incomplete groups out of editing", async ({
  page,
}) => {
  const project = structuredClone(sample) as Project;
  project.screens[0].groups = [
    {
      id: "019a0000-0000-7000-8000-000000009800",
      name: "計器ユニット",
      memberIds: project.screens[0].objects.slice(0, 2).map((o) => o.id),
    },
  ];
  await open(page, project);
  await button(page, "配列複製").click();
  await dialog(page)
    .getByRole("button", { name: "配列を複製", exact: true })
    .click();
  const next = await exported(page);
  expect(next.screens[0].objects).toHaveLength(6);
  expect(next.screens[0].groups).toHaveLength(2);
  expect(next.screens[0].groups[1].memberIds).toEqual(
    next.screens[0].objects.slice(3, 5).map((o) => o.id),
  );
  await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(project.screens);
});
test("replacement invalidates the open request and a locked source disables array copy", async ({
  page,
}) => {
  await open(page);
  await button(page, "配列複製").click();
  const replacement = structuredClone(sample) as Project;
  replacement.manifest.name = "置換したプロジェクト";
  replacement.screens[0].objects[0].locked = true;
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(dialog(page)).toBeHidden();
  for (const [index, object] of replacement.screens[0].objects.entries())
    await page
      .locator(`button[data-layer-id="${object.id}"]`)
      .click({ modifiers: index ? ["Shift"] : [] });
  await expect(button(page, "配列複製")).toBeDisabled();
  expect((await exported(page)).screens).toEqual(replacement.screens);
});
test("definition array uses its own 100-placement budget and edits only shared children", async ({
  page,
}) => {
  const project = structuredClone(sample) as Project,
    owner = project.screens[0];
  const definition = {
    id: "019a0000-0000-7000-8000-000000009950",
    name: "配列用の共有定義",
    width: 640,
    height: 400,
    folders: [],
    objects: owner.objects,
  };
  owner.objects = [];
  project.symbols.push(definition);
  await open(page, project);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+a");
  await button(page, "配列複製").click();
  await expect(dialog(page)).toContainText("共有定義内の上限100配置");
  await dialog(page).getByLabel("列数", { exact: true }).fill("34");
  await dialog(page)
    .getByRole("button", { name: "配列を複製", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert")).toContainText("上限100件");
  await dialog(page).getByLabel("列数", { exact: true }).fill("2");
  await dialog(page)
    .getByRole("button", { name: "配列を複製", exact: true })
    .click();
  const next = await exported(page);
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects).toHaveLength(6);
  await button(page, "元に戻す").click();
  expect((await exported(page)).symbols).toEqual(project.symbols);
});
