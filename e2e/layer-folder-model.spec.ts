import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process.project.json" with { type: "json" };
import minimal from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const canvas = (page: Page) => page.locator(".sheet > svg");
function fixture() {
  const project: any = structuredClone(sample);
  [project.screens[0], project.symbols[0]].forEach((owner, i) => {
    const id = `0199fd00-0000-7000-8000-00000000000${i}`;
    owner.folders = [{ id, name: "設備", order: 0 }];
    owner.objects.forEach((o: any) => (o.folderId = id));
  });
  return project;
}
async function load(page: Page, project: object) {
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "folders.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(button(page, "元に戻す")).toBeDisabled();
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
}
async function saved(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
}
test("folder metadata does not change rendering, and Inspector edits retain membership", async ({
  page,
}) => {
  await start(page);
  await load(page, sample);
  await page.evaluate(() => document.fonts.ready);
  const before = await canvas(page).screenshot({ animations: "disabled" });
  const project = fixture();
  await load(page, project);
  expect(await canvas(page).screenshot({ animations: "disabled" })).toEqual(
    before,
  );
  await selectPanel(page, "レイヤー");
  const id = project.screens[0].objects[0].id;
  await page.locator(`button[data-layer-id="${id}"]`).click();
  await page.getByLabel("配置名", { exact: true }).fill("所属を保つ配置");
  await button(page, "変更を適用").click();
  const result = await saved(page);
  expect(result.screens[0].folders).toEqual(project.screens[0].folders);
  expect(result.screens[0].objects.map((o: any) => o.folderId)).toEqual(
    project.screens[0].objects.map((o: any) => o.folderId),
  );
  expect(result.symbols).toEqual(project.symbols);
});
test("screen and definition duplication renew folder IDs and retain internal references", async ({
  page,
}) => {
  await start(page);
  const project = fixture();
  await load(page, project);
  await selectPanel(page, "プロジェクト");
  await button(page, "画面を複製").click();
  await button(page, "定義を複製").click();
  const result = await saved(page);
  const copy = result.screens[1];
  expect(copy.folders[0].id).not.toBe(project.screens[0].folders[0].id);
  expect(
    copy.objects.every((o: any) => o.folderId === copy.folders[0].id),
  ).toBe(true);
  const definition = result.symbols.at(-1);
  expect(definition.folders[0].id).not.toBe(project.symbols[0].folders[0].id);
  expect(
    definition.objects.every(
      (o: any) => o.folderId === definition.folders[0].id,
    ),
  ).toBe(true);
  expect(result.screens[0]).toEqual(project.screens[0]);
  expect(result.symbols[0]).toEqual(project.symbols[0]);
});
test("native cross-project clipboard pastes at root and remaps dependency folders", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  const project = fixture();
  await load(page, project);
  await selectPanel(page, "レイヤー");
  const source = project.screens[0].objects.find(
    (o: any) => o.shape.type === "symbol",
  );
  await page.locator(`button[data-layer-id="${source.id}"]`).click();
  await page.keyboard.press("Control+c");
  const fragment = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(fragment.project.screens[0].folders).toEqual([]);
  expect(fragment.project.screens[0].objects[0].folderId).toBeUndefined();
  await load(page, minimal);
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+v");
  await expect(canvas(page).locator("[data-object-id]")).toHaveCount(4);
  const result = await saved(page);
  expect(result.screens[0].objects.at(-1).folderId).toBeUndefined();
  expect(result.screens[0].folders).toEqual([]);
  expect(result.symbols[0].folders[0].id).not.toBe(
    project.symbols[0].folders[0].id,
  );
  expect(
    result.symbols[0].objects.every(
      (o: any) => o.folderId === result.symbols[0].folders[0].id,
    ),
  ).toBe(true);
});
