import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const id = (n: number) =>
  `0199fc80-0000-7000-8000-${String(n).padStart(12, "0")}`;
const folder = (p: Page, n: number) =>
  p.locator(`button[data-layer-folder="${id(n)}"][aria-expanded]`);
const sourceFolder = (p: Page, n: number) =>
  p.locator(`[data-folder-drag-source="${id(n)}"]`);
const row = (p: Page, key: string) =>
  p.locator(`button[data-layer-id="${key}"]`);
const orderRow = (p: Page, key: string) =>
  p.locator(`[data-layer-order-id="${key}"]`);
const undo = (p: Page) =>
  p.getByRole("button", { name: "元に戻す", exact: true });
const guard = (p: Page) =>
  p.getByRole("dialog", { name: "未適用の入力があります", exact: true });
function fixture(): any {
  const p = structuredClone(sample) as any,
    s = p.screens[0];
  s.folders = [
    { id: id(1), name: "設備A", order: 0 },
    { id: id(2), name: "子フォルダー", order: 2, parentId: id(1) },
    { id: id(3), name: "設備B", order: 5 },
    { id: id(4), name: "設備C", order: 9 },
  ];
  s.objects.forEach((o: any, i: number) => {
    o.order = i * 5;
    o.folderId = id(1);
  });
  for (let n = 3; n < 6; n++)
    s.objects.push({
      ...structuredClone(s.objects[0]),
      id: id(100 + n),
      order: n * 5,
      name: `追加${n}`,
    });
  s.objects[3].folderId = id(3);
  return p;
}
async function start(p: Page, project = fixture()) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "order.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(p, "レイヤー");
  await row(p, project.screens[0].objects[5].id).click();
  const close = p.locator(".toast-host button.close");
  while (await close.count()) await close.first().click();
  return project;
}
async function saved(p: Page) {
  const wait = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
const ids = (s: any) =>
  [...s.objects]
    .sort((a: any, b: any) => a.order - b.order)
    .map((o: any) => o.id);
async function begin(p: Page, source: Locator) {
  const data = await p.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: data });
  return data;
}
async function at(
  p: Page,
  target: Locator,
  position: "before" | "after",
  data: any,
  event = "dragover",
) {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await target.dispatchEvent(event, {
    dataTransfer: data,
    clientX: b.x + 50,
    clientY: position === "before" ? b.y + 2 : b.y + b.height - 2,
  });
}
async function native(
  p: Page,
  source: Locator,
  target: Locator,
  position: "before" | "after",
) {
  await source.scrollIntoViewIfNeeded();
  const b = (await source.boundingBox())!;
  await p.mouse.move(b.x + 12, b.y + b.height / 2);
  await p.mouse.down();
  await p.mouse.move(b.x + 32, b.y + b.height / 2, { steps: 5 });
  await expect(p.locator(".layer-drag-guide")).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const t = (await target.boundingBox())!;
  const x = t.x + 50,
    y = position === "before" ? t.y + 2 : t.y + t.height - 2;
  await p.mouse.move(x, y, { steps: 8 });
  await p.mouse.move(x, y);
  await expect(target).toHaveClass(new RegExp(`insert-${position}`));
  await p.mouse.up();
}
for (const theme of ["light", "dark"] as const)
  test(`native sibling insertion preserves selection, folders and single Undo in ${theme}`, async ({
    page,
  }) => {
    const before = await start(page),
      s = before.screens[0],
      original = ids(s);
    await chooseTheme(page, theme);
    await native(
      page,
      row(page, original[0]),
      orderRow(page, original[2]),
      "after",
    );
    let next = await saved(page);
    expect(ids(next.screens[0])).toEqual([
      original[1],
      original[2],
      original[0],
      ...original.slice(3),
    ]);
    expect(next.screens[0].folders).toEqual(s.folders);
    await expect(row(page, original[5])).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await undo(page).click();
    expect((await saved(page)).screens).toEqual(before.screens);
    await expect(undo(page)).toBeDisabled();
    await folder(page, 1).click();
    await native(page, sourceFolder(page, 1), orderRow(page, id(4)), "after");
    next = await saved(page);
    expect(next.screens[0].folders.map((f: any) => f.order)).toEqual([
      9, 2, 0, 5,
    ]);
    expect(next.screens[0].objects).toEqual(s.objects);
    await expect(folder(page, 1)).toHaveAttribute("aria-expanded", "false");
    await undo(page).click();
    expect((await saved(page)).screens).toEqual(before.screens);
  });
test("insertion rejects search, mixed kinds and foreign parents without falling back to membership", async ({
  page,
}) => {
  const p = await start(page),
    s = p.screens[0],
    original = ids(s);
  let data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[3]), "after", data);
  await expect(page.locator(".layer-drag-guide")).toContainText("同じ親");
  await expect(page.locator(".insert-after")).toHaveCount(0);
  await at(page, orderRow(page, original[3]), "after", data, "drop");
  expect((await saved(page)).screens).toEqual(p.screens);
  await page.keyboard.press("Escape");
  data = await begin(page, sourceFolder(page, 1));
  await at(page, orderRow(page, original[0]), "before", data);
  await expect(page.locator(".layer-drag-guide")).toContainText("同じ種類");
  await page.keyboard.press("Escape");
  await page.getByRole("searchbox", { name: "レイヤーを検索" }).fill("設備A");
  data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[2]), "before", data);
  await expect(page.locator(".layer-drag-guide")).toContainText("検索を解除");
  await at(page, orderRow(page, original[2]), "before", data, "drop");
  await page.keyboard.press("Escape");
  await expect(undo(page)).toBeDisabled();
});
test("drop protects exact pending inputs and separates apply from relative order in Undo", async ({
  page,
}) => {
  const p = await start(page),
    s = p.screens[0],
    original = ids(s);
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("並べ替え前の入力");
  let data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[2]), "after", data, "drop");
  await guard(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(name).toHaveValue("並べ替え前の入力");
  await expect(undo(page)).toBeDisabled();
  data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[2]), "after", data, "drop");
  await row(page, original[0]).dispatchEvent("dragend", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  expect(ids((await saved(page)).screens[0])).toEqual([
    original[1],
    original[2],
    original[0],
    ...original.slice(3),
  ]);
  await undo(page).click();
  let next = await saved(page);
  expect(ids(next.screens[0])).toEqual(original);
  expect(next.screens[0].objects[5].name).toBe("並べ替え前の入力");
  await undo(page).click();
  expect((await saved(page)).screens).toEqual(p.screens);
});
test("whole group insertion never splits source or destination; external and stale tokens do not edit", async ({
  page,
}) => {
  const p = fixture(),
    s = p.screens[0],
    original = ids(s);
  s.objects[3].folderId = id(1);
  s.groups = [
    { id: id(20), name: "元グループ", memberIds: original.slice(0, 2) },
    { id: id(21), name: "先グループ", memberIds: original.slice(3, 5) },
  ];
  await start(page, p);
  const data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[3]), "after", data, "drop");
  expect(ids((await saved(page)).screens[0])).toEqual([
    original[2],
    original[3],
    original[4],
    original[0],
    original[1],
    original[5],
  ]);
  const interrupted = await begin(page, row(page, original[0]));
  await undo(page).evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.locator(".layer-drag-guide")).toHaveCount(0);
  await expect(undo(page)).toBeDisabled();
  await at(page, orderRow(page, original[3]), "after", interrupted, "drop");
  await expect(undo(page)).toBeDisabled();
  await at(page, orderRow(page, original[3]), "after", data, "drop");
  await expect(undo(page)).toBeDisabled();
  const forged = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData("application/x-banto-scada-layer-membership", "foreign");
    return d;
  });
  await at(page, orderRow(page, original[3]), "after", forged, "drop");
  expect((await saved(page)).screens).toEqual(p.screens);
});
test("same-position insertion is a no-op and folder center keeps existing membership semantics", async ({
  page,
}) => {
  const p = await start(page),
    original = ids(p.screens[0]);
  let data = await begin(page, row(page, original[0]));
  await at(page, orderRow(page, original[1]), "before", data, "drop");
  await expect(undo(page)).toBeDisabled();
  expect((await saved(page)).screens).toEqual(p.screens);
  data = await begin(page, row(page, original[0]));
  const target = folder(page, 3),
    b = (await target.boundingBox())!;
  await target.dispatchEvent("dragover", {
    dataTransfer: data,
    clientX: b.x + 50,
    clientY: b.y + b.height / 2,
  });
  await expect(page.locator(".layer-folder.drop-hover")).toHaveAttribute(
    "data-layer-drop-folder",
    id(3),
  );
  await target.dispatchEvent("drop", {
    dataTransfer: data,
    clientX: b.x + 50,
    clientY: b.y + b.height / 2,
  });
  const next = await saved(page);
  expect(next.screens[0].objects[0].folderId).toBe(id(3));
  expect(ids(next.screens[0])).toEqual(original);
});
