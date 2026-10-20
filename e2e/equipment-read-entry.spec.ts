import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { selectPanel, fileCommand } from "./helpers/designer";
import { readFile } from "node:fs/promises";
const opener = (page: Page) =>
  page.getByRole("button", { name: "関連機器の読取詳細を開く", exact: true });
async function start(page: Page, locked = false) {
  const project = structuredClone(sample);
  if (locked) (project.screens[0].objects[0] as any).locked = true;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "entry.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
    .click();
  return project;
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
test("locked Symbol opens its committed equipment without changing Project or adding Undo", async ({
  page,
}) => {
  const project = await start(page, true);
  await expect(opener(page)).toBeEnabled();
  await opener(page).click();
  const window = page.locator(
    `[data-preview-popup="${project.equipment[0].id}"][data-popup-kind="equipment"]`,
  );
  await expect(window).toBeVisible();
  await window.locator("[data-popup-move]").press("Escape");
  await expect(
    page.getByRole("button", { name: "機器の読取詳細", exact: true }),
  ).toBeFocused();
  expect(await saved(page)).toEqual(project);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("cancel retains a pending equipment edit; apply opens the newly committed equipment", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__resizeErrors = [];
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver"))
        (window as any).__resizeErrors.push(event.message);
    });
  });
  await start(page);
  const association = page.getByLabel("関連付ける機器", { exact: true });
  await association.selectOption(sample.equipment[1].id);
  await opener(page).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(association).toHaveValue(sample.equipment[1].id);
  await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
  await opener(page).click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.locator(`[data-preview-popup="${sample.equipment[1].id}"]`),
  ).toBeVisible();
  expect((await saved(page)).screens[0].objects[0].shape.equipmentId).toBe(
    sample.equipment[1].id,
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  expect((await saved(page)).screens[0].objects[0].shape.equipmentId).toBe(
    sample.equipment[0].id,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => (window as any).__resizeErrors)).toEqual([]);
});
test("discard opens the original equipment and an unbound Symbol explains the disabled entry", async ({
  page,
}) => {
  await start(page);
  await page
    .getByLabel("関連付ける機器", { exact: true })
    .selectOption(sample.equipment[1].id);
  await opener(page).click();
  await page
    .getByRole("dialog", { name: "未適用の入力があります", exact: true })
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(
    page.locator(`[data-preview-popup="${sample.equipment[0].id}"]`),
  ).toBeVisible();
  expect(await saved(page)).toEqual(sample);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page
    .locator(`button[data-layer-id="${sample.screens[0].objects[4].id}"]`)
    .click();
  await expect(opener(page)).toBeDisabled();
  await expect(
    page.getByText("機器を関連付けると読取詳細を開けます。", { exact: true }),
  ).toBeVisible();
});
test("applying removal of the equipment association stays in edit mode with no stale target", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("関連付ける機器", { exact: true }).selectOption("");
  await opener(page).click();
  await page
    .getByRole("dialog", { name: "未適用の入力があります", exact: true })
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(opener(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "編集", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
  expect(
    (await saved(page)).screens[0].objects[0].shape.equipmentId,
  ).toBeUndefined();
});
