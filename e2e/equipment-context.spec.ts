import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
async function start(page: Page, locked = false) {
  const project: any = structuredClone(sample);
  if (locked) project.screens[0].objects[0].locked = true;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "equipment-context.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  return project;
}
const action = (page: Page, name: string) =>
  page.getByRole("menu").getByRole("menuitem", { name, exact: true });
for (const source of ["canvas", "layer-keyboard"] as const)
  test(`equipment settings and read details open from ${source} with properties hidden`, async ({
    page,
  }) => {
    const project = await start(page, source === "layer-keyboard");
    await chooseTheme(page, source === "canvas" ? "light" : "dark");
    await page
      .getByRole("button", { name: "プロパティを隠す", exact: true })
      .click();
    const row = page.locator(
      `button[data-layer-id="${project.screens[0].objects[0].id}"]`,
    );
    async function open() {
      if (source === "canvas")
        await page
          .locator(
            `.sheet > svg [data-object-id="${project.screens[0].objects[0].id}"]`,
          )
          .first()
          .click({ button: "right" });
      else {
        await row.focus();
        await row.press("Shift+F10");
      }
    }
    await open();
    await expect(action(page, "関連機器の台帳設定を開く")).toBeEnabled();
    await action(page, "関連機器の台帳設定を開く").click();
    await expect(
      page
        .getByRole("form", { name: "機器情報と割付", exact: true })
        .getByLabel("機器番号", { exact: true }),
    ).toHaveValue(project.equipment[0].code);
    await selectPanel(page, "レイヤー");
    await open();
    await action(page, "関連機器の読取詳細を開く").click();
    await expect(
      page.locator(
        `[data-popup-kind="equipment"][data-preview-popup="${project.equipment[0].id}"]`,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "編集", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
  });
test("unbound Symbol disables equipment actions and multiple selection has no single-equipment actions", async ({
  page,
}) => {
  const project = await start(page);
  const unbound = project.screens[0].objects.find(
    (object: any) =>
      object.shape.type === "symbol" && !object.shape.equipmentId,
  );
  const row = page.locator(`button[data-layer-id="${unbound.id}"]`);
  await row.click({ button: "right" });
  await expect(action(page, "関連機器の台帳設定を開く")).toBeDisabled();
  await expect(action(page, "関連機器の読取詳細を開く")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
    .click();
  await row.click({ modifiers: ["Shift"] });
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(action(page, "関連機器の台帳設定を開く")).toHaveCount(0);
  await expect(action(page, "関連機器の読取詳細を開く")).toHaveCount(0);
});
test("equipment context action resolves a pending association before opening the target", async ({
  page,
}) => {
  const project = await start(page);
  const row = page.locator(
    `button[data-layer-id="${project.screens[0].objects[0].id}"]`,
  );
  await row.click();
  await page
    .getByLabel("関連付ける機器", { exact: true })
    .selectOption(project.equipment[1].id);
  await row.press("Shift+F10");
  await action(page, "関連機器の台帳設定を開く").click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("関連付ける機器", { exact: true })).toHaveValue(
    project.equipment[1].id,
  );
  await row.press("Shift+F10");
  await action(page, "関連機器の台帳設定を開く").click();
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  await expect(
    page
      .getByRole("form", { name: "機器情報と割付", exact: true })
      .getByLabel("機器番号", { exact: true }),
  ).toHaveValue(project.equipment[1].code);
});
