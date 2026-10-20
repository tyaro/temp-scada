import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, fileCommand } from "./helpers/designer";
const ids = Array.from(
  { length: 5 },
  (_, i) => `0199fe00-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
);
const folder = (p: Page, id: string) =>
  p.locator(`button[data-layer-folder="${id}"][aria-expanded]`);
const rows = (p: Page) => p.locator("button[data-layer-folder][aria-expanded]");
const menu = (p: Page) =>
  p.getByRole("menu", { name: "フォルダー の操作", exact: true });
async function start(p: Page) {
  const project: any = structuredClone(sample);
  project.screens[0].folders = [
    { id: ids[0], name: "設備A", order: 0 },
    { id: ids[1], name: "ポンプA1", order: 1, parentId: ids[0] },
    { id: ids[2], name: "設備B", order: 2 },
    { id: ids[3], name: "ポンプA2", order: 3, parentId: ids[0] },
    { id: ids[4], name: "設備C", order: 4 },
  ];
  Object.assign(project.screens[0].objects[0], {
    folderId: ids[1],
    locked: true,
    visible: false,
  });
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "folders.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(p, "レイヤー");
  return project;
}
async function order(p: Page) {
  return rows(p).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-layer-folder")),
  );
}
async function action(p: Page, id: string, label: string) {
  await folder(p, id).click({ button: "right" });
  await menu(p).getByRole("menuitem", { name: label, exact: true }).click();
  await expect(menu(p)).toBeHidden();
}
async function saved(p: Page) {
  const pending = p.waitForEvent("download");
  await fileCommand(p, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
test("folder context ordering keeps drawing pixels, placement state, parent IDs and one Undo", async ({
  page,
}) => {
  const project = await start(page);
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const before = await svg.screenshot({ animations: "disabled" });
  await folder(page, ids[2]).focus();
  await page.keyboard.press("Shift+F10");
  await menu(page)
    .getByRole("menuitem", { name: "同じ階層で一つ上へ", exact: true })
    .click();
  await expect
    .poll(() => order(page))
    .toEqual([ids[2], ids[0], ids[1], ids[3], ids[4]]);
  await expect(folder(page, ids[2])).toBeFocused();
  expect(await svg.screenshot({ animations: "disabled" })).toEqual(before);
  const result = await saved(page);
  expect(result.screens[0].objects).toEqual(project.screens[0].objects);
  expect(result.screens[0].folders.map((f: any) => f.parentId)).toEqual(
    project.screens[0].folders.map((f: any) => f.parentId),
  );
  expect(result.screens[0].folders.map((f: any) => f.order)).toEqual([
    2, 1, 0, 3, 4,
  ]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => order(page))
    .toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  await page.keyboard.press("Control+y");
  await expect
    .poll(() => order(page))
    .toEqual([ids[2], ids[0], ids[1], ids[3], ids[4]]);
  await folder(page, ids[2]).click({ button: "right" });
  await expect(
    menu(page).getByRole("menuitem", {
      name: "同じ階層で一つ上へ",
      exact: true,
    }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await action(page, ids[3], "同じ階層で一つ上へ");
  await expect
    .poll(() => order(page))
    .toEqual([ids[2], ids[0], ids[3], ids[1], ids[4]]);
});
test("search disables reordering and clearing the query restores sibling boundary checks", async ({
  page,
}) => {
  await start(page);
  const search = page.getByLabel("レイヤーを検索", { exact: true });
  await search.fill("設備B");
  await folder(page, ids[2]).click({ button: "right" });
  for (const label of [
    "同じ階層で一つ上へ（検索中は不可）",
    "同じ階層で一つ下へ（検索中は不可）",
  ])
    await expect(
      menu(page).getByRole("menuitem", { name: label, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await search.fill("");
  await action(page, ids[2], "同じ階層で一つ下へ");
  await expect
    .poll(() => order(page))
    .toEqual([ids[0], ids[1], ids[3], ids[4], ids[2]]);
});
test("folder reorder protects a pending property name and Undo separates apply from tree order", async ({
  page,
}) => {
  const project = await start(page);
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[1].id}"]`)
    .click();
  await page.getByLabel("配置名", { exact: true }).fill("未適用の名前");
  await action(page, ids[2], "同じ階層で一つ上へ");
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect
    .poll(() => order(page))
    .toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await action(page, ids[2], "同じ階層で一つ上へ");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect
    .poll(() => order(page))
    .toEqual([ids[2], ids[0], ids[1], ids[3], ids[4]]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => order(page))
    .toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  expect((await saved(page)).screens[0].objects[1].name).toBe("未適用の名前");
});
