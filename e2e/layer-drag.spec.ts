import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const folderId = "0199fe00-0000-7000-8000-000000000001";
const nestedId = "0199fe00-0000-7000-8000-000000000002";
const ids = sample.screens[0].objects.map((o) => o.id);
const row = (page: Page, id = ids[0]) =>
  page.locator(`button[data-layer-id="${id}"]`);
const folder = (page: Page, id = folderId) =>
  page.locator(`button[data-layer-folder="${id}"][aria-expanded]`);
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const guard = (page: Page) =>
  page.getByRole("dialog", { name: "未適用の入力があります", exact: true });
async function start(
  page: Page,
  options: { hidden?: boolean; locked?: boolean; long?: boolean } = {},
) {
  const project: any = structuredClone(sample);
  const owner = project.screens[0];
  owner.folders = [
    { id: folderId, name: "ポンプ", order: 0 },
    { id: nestedId, name: "予備", parentId: folderId, order: 1 },
  ];
  owner.objects[0].folderId = nestedId;
  if (options.hidden) owner.objects[1].visible = false;
  if (options.locked) owner.objects[1].locked = true;
  if (options.long)
    for (let i = 2; i < 40; i++)
      owner.folders.push({
        id: `0199fe00-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
        name: `設備${i}`,
        order: i,
      });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "drag.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  return project;
}
async function saved(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}
async function begin(page: Page, source: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  const box = (await source.boundingBox())!;
  await source.dispatchEvent("dragover", {
    dataTransfer,
    clientX: box.x + 40,
    clientY: box.y + box.height / 2,
  });
  return dataTransfer;
}
for (const theme of ["light", "dark"] as const)
  test(`native membership drag preserves selection, geometry and one Undo in ${theme}`, async ({
    page,
  }) => {
    const before = await start(page);
    await chooseTheme(page, theme);
    await row(page, ids[1]).click();
    // An unselected source moves itself; the selection is deliberately retained.
    const sourceBox = (await row(page).boundingBox())!;
    await page.mouse.move(sourceBox.x + 30, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + 45,
      sourceBox.y + sourceBox.height / 2,
      { steps: 5 },
    );
    await expect(page.locator(".layer-drag-guide")).toBeVisible();
    const targetBox = (await folder(page).boundingBox())!;
    await page.mouse.move(
      targetBox.x + 40,
      targetBox.y + targetBox.height / 2,
      { steps: 10 },
    );
    await page.mouse.move(targetBox.x + 40, targetBox.y + targetBox.height / 2);
    await expect(page.locator(".layer-folder.drop-hover")).toHaveAttribute(
      "data-layer-drop-folder",
      folderId,
    );
    await page.mouse.up();
    await expect(row(page, ids[1])).toHaveAttribute("aria-pressed", "true");
    await expect(row(page)).toHaveAttribute("aria-pressed", "false");
    const result = await saved(page);
    expect(result.screens[0].objects).toEqual(
      before.screens[0].objects.map((o: any, i: number) =>
        i === 0 ? { ...o, folderId } : o,
      ),
    );
    await button(page, "元に戻す").click();
    expect((await saved(page)).screens[0]).toEqual(before.screens[0]);
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
    expect((await saved(page)).screens[0].objects[0].folderId).toBe(folderId);
  });
test("multiple selected sources include hidden objects; closed destinations open; root removal and no-op preserve history", async ({
  page,
}) => {
  await start(page, { hidden: true });
  await folder(page, nestedId).click();
  await row(page, ids[1]).click();
  await row(page, ids[2]).click({ modifiers: ["Shift"] });
  const transfer = await begin(page, row(page, ids[1]));
  await expect(page.locator(".layer-drag-guide")).toContainText(
    "2 件を移動（非表示 1 件）",
  );
  await folder(page, nestedId).dispatchEvent("dragover", {
    dataTransfer: transfer,
  });
  await expect(page.locator(".layer-drag-guide")).toContainText(
    "ポンプ / 予備 直下へ",
  );
  await folder(page, nestedId).dispatchEvent("drop", {
    dataTransfer: transfer,
    ctrlKey: true,
  });
  await expect(folder(page, nestedId)).toHaveAttribute("aria-expanded", "true");
  let result = await saved(page);
  expect(result.screens[0].objects).toHaveLength(3);
  expect(
    result.screens[0].objects
      .slice(1)
      .every((o: any) => o.folderId === nestedId),
  ).toBe(true);
  expect(result.screens[0].objects[1].visible).toBe(false);
  let data = await begin(page, row(page, ids[1]));
  await folder(page, nestedId).dispatchEvent("drop", { dataTransfer: data });
  expect((await saved(page)).manifest.projectRevision).toBe(
    result.manifest.projectRevision,
  );
  data = await begin(page, row(page, ids[1]));
  await page
    .locator('[data-layer-drop-folder=""]')
    .dispatchEvent("drop", { dataTransfer: data });
  result = await saved(page);
  expect(
    result.screens[0].objects
      .slice(1)
      .every((o: any) => o.folderId === undefined),
  ).toBe(true);
  await button(page, "元に戻す").click();
  expect((await saved(page)).screens[0].objects[1].folderId).toBe(nestedId);
});
test("locked selections reject the whole drag and eye, lock, more and folder buttons are not drag sources", async ({
  page,
}) => {
  const before = await start(page, { locked: true });
  await row(page).click();
  await row(page, ids[1]).click({ modifiers: ["Shift"] });
  await row(page).dragTo(folder(page));
  await expect(page.locator(".layer-drag-guide")).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).screens[0]).toEqual(before.screens[0]);
  for (const selector of [
    ".layer-visible",
    ".layer-lock",
    ".layer-more",
    "[data-layer-folder]",
  ]) {
    expect(
      await page.locator(selector).first().getAttribute("draggable"),
    ).not.toBe("true");
  }
});
test("drafts are prompted at drop, cancellation keeps text, and applying commits the captured IDs", async ({
  page,
}) => {
  await start(page);
  await row(page).click();
  const name = page.getByLabel("配置名", { exact: true });
  await name.fill("未適用の名前");
  let data = await begin(page, row(page));
  await expect(guard(page)).toHaveCount(0);
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(name).toHaveValue("未適用の名前");
  await expect(button(page, "元に戻す")).toBeDisabled();
  data = await begin(page, row(page));
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  // Native dragend must not erase the already captured drop intent.
  await row(page).dispatchEvent("dragend", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  const result = await saved(page);
  expect(result.screens[0].objects[0]).toMatchObject({
    name: "未適用の名前",
    folderId,
  });
  await button(page, "元に戻す").click();
  expect((await saved(page)).screens[0].objects[0]).toMatchObject({
    name: "未適用の名前",
    folderId: nestedId,
  });
});
test("invalid drafts prevent membership changes; discarded drafts allow the drop", async ({
  page,
}) => {
  await start(page);
  await row(page).click();
  await page.getByLabel("x", { exact: true }).fill("invalid");
  await page.getByLabel("配置名", { exact: true }).focus();
  let data = await begin(page, row(page));
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("invalid");
  data = await begin(page, row(page));
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  await guard(page)
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  expect((await saved(page)).screens[0].objects[0].folderId).toBe(folderId);
});
test("external tokens, cancelled drags, source tab changes and object-row drops never edit", async ({
  page,
}) => {
  await start(page);
  const external = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData("application/x-banto-scada-layer-membership", "external");
    return d;
  });
  await folder(page).dispatchEvent("drop", { dataTransfer: external });
  let data = await begin(page, row(page));
  await folder(page).dispatchEvent("drop", { dataTransfer: external });
  await row(page, ids[1]).dispatchEvent("drop", { dataTransfer: data });
  await page.keyboard.press("Escape");
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  data = await begin(page, row(page));
  await selectPanel(page, "プロジェクト");
  await selectPanel(page, "レイヤー");
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  await expect(page.locator(".layer-drag-guide")).toHaveCount(0);
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("dragging near the panel edge scrolls the long tree and stops on cancellation", async ({
  page,
}) => {
  await start(page, { long: true });
  const panel = page.getByRole("tabpanel", { name: "レイヤー", exact: true });
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const data = await begin(page, row(page, ids[2]));
  const box = (await panel.boundingBox())!;
  await page.locator(".layer-browser").dispatchEvent("dragover", {
    dataTransfer: data,
    clientX: box.x + 30,
    clientY: box.y + 8,
  });
  await expect
    .poll(() => panel.evaluate((el) => el.scrollTop))
    .toBeLessThan(100);
  await page.keyboard.press("Escape");
  const scroll = await panel.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(150);
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(scroll);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("invalidating the drag session stops autoscroll without waiting for native dragend", async ({
  page,
}) => {
  await start(page, { long: true });
  const panel = page.locator("#designer-panel-layers");
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const data = await begin(page, row(page, ids[2]));
  const box = (await panel.boundingBox())!;
  const before = await panel.evaluate((el) => el.scrollTop);
  await page.locator(".layer-browser").dispatchEvent("dragover", {
    dataTransfer: data,
    clientX: box.x + 30,
    clientY: box.y + 8,
  });
  await expect
    .poll(() => panel.evaluate((el) => el.scrollTop))
    .toBeLessThan(before - 50);
  await selectPanel(page, "プロジェクト");
  const position = await panel.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(150);
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(position);
  await selectPanel(page, "レイヤー");
  await expect(page.locator(".layer-drag-guide")).toHaveCount(0);
});
test("shared definition membership and a new file generation keep the captured owner isolated", async ({
  page,
}) => {
  await start(page);
  const project = JSON.parse(
    await readFile("examples/process.project.json", "utf8"),
  );
  project.symbols[0].folders = [{ id: folderId, name: "構成図形", order: 0 }];
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "definition.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const child = project.symbols[0].objects[0];
  let data = await begin(page, row(page, child.id));
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  const result = await saved(page);
  expect(result.symbols[0].objects[0]).toEqual({ ...child, folderId });
  expect(result.screens).toEqual(project.screens);
  data = await begin(page, row(page, child.id));
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "generation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(result)),
  });
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await folder(page).dispatchEvent("drop", { dataTransfer: data });
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await saved(page)).symbols).toEqual(result.symbols);
});
