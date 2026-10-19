import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const folderIds = Array.from(
  { length: 20 },
  (_, i) => `0199fc00-0000-7000-8000-${String(i + 100).padStart(12, "0")}`,
);
const [a, b, c, d] = folderIds;
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const folder = (page: Page, id: string) =>
  page.locator(`button[data-layer-folder="${id}"][aria-expanded]`);
const source = (page: Page, id: string) =>
  page.locator(`[data-folder-drag-source="${id}"]`);
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const guard = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
function fixture(): any {
  const project: any = structuredClone(sample),
    owner = project.screens[0];
  owner.folders = [
    { id: a, name: "設備", order: 0 },
    { id: b, name: "ポンプ", order: 1, parentId: a },
    { id: c, name: "移動先", order: 2 },
    { id: d, name: "予備", order: 3, parentId: b },
  ];
  owner.objects[0].folderId = b;
  owner.objects[0].locked = true;
  owner.objects[1].folderId = d;
  owner.objects[1].visible = false;
  return project;
}
async function start(page: Page, project = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "folder.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await row(page, project.screens[0].objects[2].id).click();
  return project;
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
async function begin(page: Page, id: string) {
  const data = await page.evaluateHandle(() => new DataTransfer());
  await source(page, id).dispatchEvent("dragstart", { dataTransfer: data });
  await source(page, id).dispatchEvent("dragover", { dataTransfer: data });
  return data;
}
for (const theme of ["light", "dark"])
  test(`native folder drag changes only parent and keeps locks, hidden objects, selection and collapsed state in ${theme}`, async ({
    page,
  }) => {
    const before = await start(page);
    await chooseTheme(page, theme);
    await folder(page, a).click();
    await expect(folder(page, a)).toHaveAttribute("aria-expanded", "false");
    const box = (await source(page, a).boundingBox())!;
    await page.mouse.move(box.x + 18, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 35, box.y + box.height / 2, { steps: 5 });
    await expect(page.locator(".layer-drag-guide")).toContainText(
      "フォルダー「設備」と配下を移動",
    );
    const target = (await folder(page, c).boundingBox())!;
    await page.mouse.move(target.x + 50, target.y + target.height / 2, {
      steps: 10,
    });
    await page.mouse.move(target.x + 50, target.y + target.height / 2);
    await expect(page.locator(".layer-folder.drop-hover")).toHaveAttribute(
      "data-layer-drop-folder",
      c,
    );
    await page.mouse.up();
    const next = await saved(page);
    expect(next.screens[0].objects).toEqual(before.screens[0].objects);
    expect(next.screens[0].folders).toEqual(
      before.screens[0].folders.map((f: any) =>
        f.id === a ? { ...f, parentId: c } : f,
      ),
    );
    await expect(row(page, before.screens[0].objects[2].id)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(folder(page, a)).toHaveAttribute("aria-expanded", "false");
    await button(page, "元に戻す").click();
    expect((await saved(page)).screens).toEqual(before.screens);
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
    expect((await saved(page)).screens[0].folders[0].parentId).toBe(c);
  });
test("self and descendant targets are forbidden at hover and drop; root and current-parent drops are atomic", async ({
  page,
}) => {
  const before = await start(page);
  let data = await begin(page, a);
  for (const id of [a, b, d]) {
    await folder(page, id).dispatchEvent("dragover", { dataTransfer: data });
    await expect(page.locator(".layer-drag-guide")).toContainText(
      "自分自身または配下",
    );
    await expect(page.locator(".layer-folder.drop-hover")).toHaveCount(0);
    await folder(page, id).dispatchEvent("drop", { dataTransfer: data });
  }
  await page.keyboard.press("Escape");
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).screens).toEqual(before.screens);
  data = await begin(page, b);
  await folder(page, a).dispatchEvent("drop", { dataTransfer: data });
  await expect(button(page, "元に戻す")).toBeDisabled();
  data = await begin(page, b);
  await page
    .locator('[data-layer-drop-folder=""]')
    .dispatchEvent("drop", { dataTransfer: data });
  let next = await saved(page);
  expect(
    next.screens[0].folders.find((f: any) => f.id === b).parentId,
  ).toBeUndefined();
  expect(next.screens[0].objects).toEqual(before.screens[0].objects);
  await button(page, "元に戻す").click();
  expect((await saved(page)).screens).toEqual(before.screens);
});
test("draft cancellation and application preserve the captured folder and independent Undo", async ({
  page,
}) => {
  const before = await start(page);
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("未適用Text");
  let data = await begin(page, b);
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(name).toHaveValue("未適用Text");
  await expect(button(page, "元に戻す")).toBeDisabled();
  data = await begin(page, b);
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  await source(page, b).dispatchEvent("dragend", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  expect(
    (await saved(page)).screens[0].folders.find((f: any) => f.id === b)
      .parentId,
  ).toBe(c);
  await button(page, "元に戻す").click();
  let next = await saved(page);
  expect(next.screens[0].folders).toEqual(before.screens[0].folders);
  expect(next.screens[0].objects[2].name).toBe("未適用Text");
  await button(page, "元に戻す").click();
  expect((await saved(page)).screens).toEqual(before.screens);
});
test("depth validation includes descendants and cancellation rejects an old token", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].folders = [
    { id: a, name: "source", order: 0 },
    { id: b, parentId: a, name: "child", order: 1 },
    ...folderIds.slice(2, 17).map((id, i) => ({
      id,
      name: `depth${i + 1}`,
      order: i + 2,
      ...(i ? { parentId: folderIds[i + 1] } : {}),
    })),
  ];
  project.screens[0].objects.forEach((o: any) => delete o.folderId);
  await start(page, project);
  const data = await begin(page, a);
  const target = folderIds[16];
  await folder(page, target).dispatchEvent("dragover", { dataTransfer: data });
  await expect(page.locator(".layer-drag-guide")).toContainText("16段");
  await folder(page, target).dispatchEvent("drop", { dataTransfer: data });
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.keyboard.press("Escape");
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  expect((await saved(page)).screens).toEqual(project.screens);
});
test("name and icon are the only folder drag source; invalid input blocks commit", async ({
  page,
}) => {
  const before = await start(page);
  expect(await folder(page, a).getAttribute("draggable")).not.toBe("true");
  expect(
    await folder(page, a).locator(".folder-chevron").getAttribute("draggable"),
  ).not.toBe("true");
  expect(await source(page, a).getAttribute("draggable")).toBe("true");
  await page.getByLabel("x", { exact: true }).fill("bad");
  const data = await begin(page, b);
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("bad");
  await page.getByLabel("x", { exact: true }).press("Escape");
  expect((await saved(page)).screens).toEqual(before.screens);
});

test("search stays active when a folder moves outside the ancestor-path result", async ({
  page,
}) => {
  const before = await start(page);
  const query = page.getByLabel("レイヤーを検索", { exact: true });
  await query.fill("設備");
  const data = await begin(page, b);
  await page
    .locator('[data-layer-drop-folder=""]')
    .dispatchEvent("drop", { dataTransfer: data });
  await expect(query).toHaveValue("設備");
  await expect(folder(page, b)).toHaveCount(0);
  await expect(page.getByTestId("project-status")).toContainText(
    "検索条件外のフォルダー",
  );
  const next = await saved(page);
  expect(next.screens[0].objects).toEqual(before.screens[0].objects);
  expect(
    next.screens[0].folders.find((f: any) => f.id === b).parentId,
  ).toBeUndefined();
  await query.fill("");
  await expect(folder(page, b)).toBeVisible();
});

test("shared-definition folder parenting stays isolated and a file reload invalidates the token", async ({
  page,
}) => {
  const owner = fixture().screens[0],
    project: any = structuredClone(sample);
  const definition = {
    ...owner,
    id: "0199fc00-0000-7000-8000-000000000999",
    name: "設備定義",
  };
  delete definition.background;
  definition.objects.forEach(
    (o: any, i: number) =>
      (o.id = `0199fc00-0000-7000-8000-${String(900 + i).padStart(12, "0")}`),
  );
  project.symbols = [definition];
  await start(page, project);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  let data = await begin(page, b);
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  const next = await saved(page);
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects).toEqual(definition.objects);
  expect(next.symbols[0].folders.find((f: any) => f.id === b).parentId).toBe(c);
  data = await begin(page, b);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "reload.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(next)),
  });
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await folder(page, a).dispatchEvent("drop", { dataTransfer: data });
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).symbols).toEqual(next.symbols);
});

test("Undo changing a captured parent stops autoscroll without another dragover", async ({
  page,
}) => {
  const project = fixture();
  for (let i = 0; i < 40; i++)
    project.screens[0].folders.push({
      id: `0199fc00-0000-7000-8000-${String(500 + i).padStart(12, "0")}`,
      name: `設備${i}`,
      order: 10 + i,
    });
  await start(page, project);
  let data = await begin(page, b);
  await folder(page, c).dispatchEvent("drop", { dataTransfer: data });
  data = await begin(page, b);
  const panel = page.locator("#designer-panel-layers");
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const box = (await panel.boundingBox())!,
    before = await panel.evaluate((el) => el.scrollTop);
  await page.locator(".layer-browser").dispatchEvent("dragover", {
    dataTransfer: data,
    clientX: box.x + 30,
    clientY: box.y + 8,
  });
  await expect
    .poll(() => panel.evaluate((el) => el.scrollTop))
    .toBeLessThan(before - 50);
  await page.keyboard.press("Control+z");
  await expect(button(page, "元に戻す")).toBeDisabled();
  const position = await panel.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(150);
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(position);
  await page.keyboard.press("Escape");
  expect((await saved(page)).screens).toEqual(project.screens);
});
