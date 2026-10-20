import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import type { Project } from "../apps/banto-scada/src/lib/project";
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const horizontal = "隙間を水平方向に均等化",
  vertical = "隙間を垂直方向に均等化";
function fixture(axis: "x" | "y" = "x"): Project {
  const project = structuredClone(sample) as Project,
    dimension = axis === "x" ? "width" : "height";
  project.screens[0].objects.forEach((object, index) => {
    if (!("width" in object)) throw new Error("fixture");
    object[axis] = [10, 85, 330][index];
    object[dimension] = [40, 80, 60][index];
    object.rotation = 0;
  });
  return project;
}
async function open(page: Page, project = fixture()) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "gaps.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
async function selectAll(page: Page) {
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+a");
}
async function exported(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  ) as Project;
}
for (const theme of ["light", "dark"] as const)
  test(`unequal gaps via toolbar preserve endpoints, snap, repeat no-op and one Undo in ${theme}`, async ({
    page,
  }) => {
    const project = fixture();
    await open(page, project);
    await chooseTheme(page, theme);
    await page
      .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
      .click();
    await expect(button(page, horizontal)).toBeDisabled();
    await selectAll(page);
    await expect(button(page, horizontal)).toBeEnabled();
    await page.getByLabel("グリッドにスナップ", { exact: true }).check();
    await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
    await button(page, horizontal).click();
    const next = await exported(page);
    expect(next.screens[0].objects[0]).toEqual(project.screens[0].objects[0]);
    expect(next.screens[0].objects[2]).toEqual(project.screens[0].objects[2]);
    expect(next.screens[0].objects[1]).toEqual({
      ...project.screens[0].objects[1],
      x: 150,
    });
    await button(page, horizontal).click();
    await button(page, "元に戻す").click();
    await expect(button(page, "元に戻す")).toBeDisabled();
    expect((await exported(page)).screens).toEqual(project.screens);
    await button(page, "やり直す").click();
    expect((await exported(page)).screens).toEqual(next.screens);
  });
test("vertical context action resolves color draft separately and keeps one geometry Undo", async ({
  page,
}) => {
  const project = fixture("y");
  await open(page, project);
  await selectAll(page);
  const color = page.getByLabel("適用する色", { exact: true });
  await color.fill("#123456");
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: vertical, exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(color).toHaveValue("#123456");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, vertical).click();
  await dialog
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  expect((await exported(page)).screens[0].objects[1].y).toBe(150);
  await button(page, "元に戻す").click();
  const colored = await exported(page);
  expect(colored.screens[0].objects.map((o) => o.y)).toEqual(
    project.screens[0].objects.map((o) => o.y),
  );
  expect(colored.screens[0].objects[2].fill).toBe("#123456");
  await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(project.screens);
});
test("insufficient space rejects atomically and locked endpoint disables the action", async ({
  page,
}) => {
  const project = fixture();
  project.screens[0].objects[2].x = 110;
  await open(page, project);
  await selectAll(page);
  await button(page, horizontal).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "両端の間に収まりません" })
      .first(),
  ).toBeVisible();
  await expect(button(page, "元に戻す")).toBeDisabled();
  expect((await exported(page)).screens).toEqual(project.screens);
  const locked = fixture();
  locked.screens[0].objects[0].locked = true;
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "locked.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(locked)),
  });
  for (const [index, object] of locked.screens[0].objects.entries())
    await page
      .locator(`button[data-layer-id="${object.id}"]`)
      .click({ modifiers: index ? ["Shift"] : [] });
  await expect(button(page, horizontal)).toBeDisabled();
});
test("geometric group counts as a unit and keeps member offsets", async ({
  page,
}) => {
  const project = fixture();
  const objects = project.screens[0].objects;
  const copy = structuredClone(objects[1]);
  copy.id = "019a0000-0000-7000-8000-000000009500";
  copy.x += 40;
  copy.order = 10;
  objects.push(copy);
  objects[2].x = 510;
  objects[2].order = 20;
  project.screens[0].groups = [
    {
      id: "019a0000-0000-7000-8000-000000009501",
      name: "中央の機器",
      memberIds: [objects[1].id, copy.id],
    },
  ];
  await open(page, project);
  await selectAll(page);
  await button(page, horizontal).click();
  const next = await exported(page);
  expect(next.screens[0].objects[3].x - next.screens[0].objects[1].x).toBe(40);
  expect(next.screens[0].groups).toEqual(project.screens[0].groups);
  const bounds = [
    { x: next.screens[0].objects[0].x, width: 40 },
    { x: next.screens[0].objects[1].x, width: 120 },
    { x: next.screens[0].objects[2].x, width: 60 },
  ];
  expect(bounds[1].x - bounds[0].x - bounds[0].width).toBeCloseTo(
    bounds[2].x - bounds[1].x - bounds[1].width,
    10,
  );
  await button(page, "元に戻す").click();
  expect((await exported(page)).screens).toEqual(project.screens);
});
