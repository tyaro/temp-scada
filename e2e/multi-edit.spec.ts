import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("Shift selection moves, aligns, duplicates and deletes atomically with history and JSON round-trip", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const list = page.getByRole("navigation", { name: "図形一覧" });
  await selectPanel(page, "レイヤー");
  await list
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await list
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(2);
  const positions = () =>
    svg.locator("[data-object-id]").evaluateAll((nodes) =>
      nodes.map((n) => {
        const m = (n as SVGGElement).transform.baseVal.consolidate()!.matrix;
        return { x: m.e, y: m.f };
      }),
    );
  const original = await positions();
  await svg.scrollIntoViewIfNeeded();
  const point = await svg.evaluate((el) => {
    const m = (el as SVGSVGElement).getScreenCTM()!;
    const p = new DOMPoint(200, 250).matrixTransform(m);
    return { x: p.x, y: p.y, scale: m.a };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(
    point.x + 50 * point.scale,
    point.y - 20 * point.scale,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(2);
  const moved = await positions();
  expect(moved[0].x).toBeCloseTo(150, 0);
  expect(moved[0].y).toBeCloseTo(150, 0);
  expect(moved[1].x - moved[0].x).toBeCloseTo(original[1].x - original[0].x, 4);
  expect(moved[1].y - moved[0].y).toBeCloseTo(original[1].y - original[0].y, 4);
  await page.getByRole("button", { name: "左揃え", exact: true }).click();
  const aligned = await positions();
  expect(aligned[0].x).toBe(aligned[1].x);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  expect(await positions()).toEqual(moved);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  expect(await positions()).toEqual(original);
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  expect(await positions()).toEqual(moved);
  await page.keyboard.press("Control+d");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(2);
  await page
    .getByRole("button", { name: "選択図形を削除", exact: true })
    .click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await page.getByRole("button", { name: "すべて選択", exact: true }).click();
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(5);
  const beforeNumericMove = await positions();
  await page.getByLabel("移動量 X", { exact: true }).fill("10");
  await page.getByLabel("移動量 Y", { exact: true }).fill("5");
  await page.getByRole("button", { name: "まとめて移動", exact: true }).click();
  const afterNumericMove = await positions();
  afterNumericMove.forEach((p, i) => {
    expect(p.x).toBeCloseTo(beforeNumericMove[i].x + 10, 4);
    expect(p.y).toBeCloseTo(beforeNumericMove[i].y + 5, 4);
  });
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const download = await downloading;
  const json = await readFile((await download.path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.manifest.projectRevision).toBe(10);
  expect(new Set(saved.screens[0].objects.map((o: any) => o.id)).size).toBe(5);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "multi.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(svg.locator('[data-selected="true"]')).toHaveCount(0);
  expect(await positions()).toEqual(afterNumericMove);
});
for (const modifier of ["Shift", "Control", "Meta"] as const)
  test(`canvas ${modifier}-click toggles selection and preview disables batch shortcuts`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
    const objects = svg.locator("[data-object-id]");
    await objects.nth(0).click();
    await objects.nth(1).click({ modifiers: [modifier] });
    await expect(svg.locator('[data-selected="true"]')).toHaveCount(2);
    await objects.nth(1).click({ modifiers: [modifier] });
    await expect(svg.locator('[data-selected="true"]')).toHaveCount(1);
    await page.getByRole("button", { name: "すべて選択", exact: true }).focus();
    await page.keyboard.press("Control+a");
    await expect(svg.locator('[data-selected="true"]')).toHaveCount(3);
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+d");
    await expect(objects).toHaveCount(3);
    await expect(svg.locator('[data-selected="true"]')).toHaveCount(0);
  });
