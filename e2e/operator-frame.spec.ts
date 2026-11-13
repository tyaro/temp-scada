import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

const main = sample.screens[0];
const common = sample.screens[1];

async function open(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  // 共通画面は主画面の埋込表示に使われているので、使われていない画面を足す。
  const project = structuredClone(sample) as any;
  project.screens.push({
    id: "0199f600-0000-7000-8000-000000000a01",
    name: "枠用ヘッダー",
    width: 1920,
    height: 120,
    background: "#ffffff",
    objects: [],
    folders: [],
    groups: [],
  });
  await openProject(page, {
    name: "operator-frame.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
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
const form = (page: Page) =>
  page.getByRole("form", { name: "運転表示の設定", exact: true });

test("operator frame settings save, block screen deletion and clear", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  await form(page).getByLabel("開始画面", { exact: true }).selectOption({
    label: main.name,
  });
  await form(page).getByLabel("ヘッダー画面", { exact: true }).selectOption({
    label: "枠用ヘッダー",
  });
  await form(page)
    .getByRole("button", { name: "運転表示の設定を適用", exact: true })
    .click();
  expect((await save(page)).operatorFrame).toEqual({
    startScreenId: main.id,
    headerScreenId: "0199f600-0000-7000-8000-000000000a01",
  });

  // 枠で使っている画面は削除できない。
  await page
    .locator(`button[data-screen-id="0199f600-0000-7000-8000-000000000a01"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "画面を削除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "画面を削除しますか" })
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText(
    "運転表示のヘッダー画面",
  );
  expect((await save(page)).screens).toHaveLength(3);

  // 同じ画面を開始とヘッダーにはできない。
  await form(page).getByLabel("フッター画面", { exact: true }).selectOption({
    label: main.name,
  });
  await form(page)
    .getByRole("button", { name: "運転表示の設定を適用", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText("別の画面");

  // すべて「なし」にすると operatorFrame ごと保存しない。
  for (const name of ["開始画面", "ヘッダー画面", "フッター画面"])
    await form(page).getByLabel(name, { exact: true }).selectOption("");
  await form(page)
    .getByRole("button", { name: "運転表示の設定を適用", exact: true })
    .click();
  expect(await save(page)).not.toHaveProperty("operatorFrame");
  void common;
});
