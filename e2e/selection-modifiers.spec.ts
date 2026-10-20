import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { fileCommand, selectPanel } from "./helpers/designer";
const ids = sample.screens[0].objects.map((o) => o.id);
const selected = (p: Page) =>
  p.locator('.sheet > svg > [data-selected="true"]');
const row = (p: Page, i: number) =>
  p.locator(`button[data-layer-id="${ids[i]}"]`);
async function start(p: Page) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(p, "レイヤー");
}
test("Ctrl and Command toggle whole groups from layers and canvas without editing Project or Undo", async ({
  page,
}) => {
  await start(page);
  const project = structuredClone(sample);
  project.screens[0].groups = [
    {
      id: "0199f000-0000-7000-8000-000000000099",
      memberIds: ids.slice(0, 2),
      name: "設備",
    },
  ];
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "group.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  for (const modifier of ["Control", "Meta"] as const) {
    await row(page, 0).click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(2);
    await row(page, 2).click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(3);
    await row(page, 0).click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(1);
    await row(page, 2).click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(0);
    await page.locator(`.sheet > svg > [data-object-id="${ids[0]}"]`).click();
    await page
      .locator(`.sheet > svg > [data-object-id="${ids[2]}"]`)
      .click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(3);
    await page
      .locator(`.sheet > svg > [data-object-id="${ids[1]}"]`)
      .click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(1);
    await row(page, 2).click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  expect(
    JSON.parse(await readFile((await (await pending).path())!, "utf8")),
  ).toEqual(project);
});
test("Ctrl range adds and Ctrl blank click preserves selection; Escape cancels the range", async ({
  page,
}) => {
  await start(page);
  await row(page, 2).click();
  const points = await page
    .getByRole("img", { name: "プロセス画面", exact: true })
    .evaluate((el) => {
      const m = (el as SVGSVGElement).getScreenCTM()!;
      return [
        { x: 80, y: 150 },
        { x: 400, y: 370 },
      ].map((p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform(m);
        return { x: q.x, y: q.y };
      });
    });
  await page.keyboard.down("Control");
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 4 });
  await page.mouse.up();
  await expect(selected(page)).toHaveCount(2);
  await page.mouse.click(points[0].x, points[0].y);
  await expect(selected(page)).toHaveCount(2);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(selected(page)).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("Ctrl selection preserves explicit name drafts on cancel and resumes additively after apply", async ({
  page,
}) => {
  await start(page);
  await row(page, 0).click();
  await page.getByLabel("配置名", { exact: true }).fill("未適用の名前");
  await row(page, 1).click({ modifiers: ["Control"] });
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(selected(page)).toHaveCount(1);
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await row(page, 1).click({ modifiers: ["Control"] });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(selected(page)).toHaveCount(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await row(page, 0).click();
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue("");
});
