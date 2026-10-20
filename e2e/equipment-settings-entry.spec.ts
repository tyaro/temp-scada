import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
const entry = (page: Page) =>
  page.getByRole("button", { name: "関連機器の台帳設定を開く", exact: true });
async function start(page: Page, locked = false) {
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].locked = locked;
  if (!locked) delete project.screens[0].objects[0].locked;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
    .click();
  return project;
}
for (const theme of ["light", "dark"] as const)
  test(`locked placement opens its equipment settings, restores panels and leaves Project unchanged in ${theme}`, async ({
    page,
  }) => {
    const project = await start(page, true);
    await chooseTheme(page, theme);
    await selectPanel(page, "プロジェクト");
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .getByRole("searchbox", { name: "機器を検索", exact: true })
      .fill("no match");
    await library
      .getByRole("button", { name: "機器種別", exact: true })
      .click();
    await page
      .locator("summary")
      .filter({ has: page.getByText("機器", { exact: true }) })
      .click();
    await page
      .getByRole("button", { name: "左パネルを隠す", exact: true })
      .click();
    await expect(entry(page)).toBeEnabled();
    await entry(page).click();
    const form = library.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
      project.equipment[0].code,
    );
    await expect(form.getByLabel("機器番号", { exact: true })).toBeFocused();
    await expect(
      library.getByRole("searchbox", { name: "機器を検索", exact: true }),
    ).toHaveValue("no match");
    await expect(library).toContainText(
      `編集中: ${project.equipment[0].code}（検索結果外）`,
    );
    await expect(
      page.getByRole("button", { name: "編集", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
    const pending = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    expect(
      JSON.parse(await readFile((await (await pending).path())!, "utf8")),
    ).toEqual(project);
  });
for (const resolution of ["適用して続行", "入力を破棄して続行"] as const)
  test(`settings entry rereads the equipment after ${resolution}`, async ({
    page,
  }) => {
    await start(page);
    const association = page.getByLabel("関連付ける機器", { exact: true });
    await association.selectOption(sample.equipment[1].id);
    await entry(page).click();
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(association).toHaveValue(sample.equipment[1].id);
    await entry(page).click();
    await page.getByRole("button", { name: resolution, exact: true }).click();
    const form = page.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
      sample.equipment[resolution === "適用して続行" ? 1 : 0].code,
    );
  });
test("settings entry protects an existing ledger draft and refuses a removed association", async ({
  page,
}) => {
  const project = await start(page);
  await selectPanel(page, "プロジェクト");
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library
    .locator(`[data-equipment-choice="${project.equipment[1].id}"]`)
    .click();
  const form = library.getByRole("form", {
    name: "機器情報と割付",
    exact: true,
  });
  await form.getByLabel("機器名", { exact: true }).fill("保護する入力");
  await selectPanel(page, "レイヤー");
  await entry(page).click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await selectPanel(page, "プロジェクト");
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "保護する入力",
  );
  await entry(page).click();
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
    project.equipment[0].code,
  );
  await page.getByLabel("関連付ける機器", { exact: true }).selectOption("");
  await entry(page).click();
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  await expect(entry(page)).toBeDisabled();
  await expect(page.getByTestId("project-status")).toHaveText(
    "機器の関連付けを確認してください。",
  );
});
