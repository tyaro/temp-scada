import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, fileCommand } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`read details navigate to a hidden locked usage without changing it in ${theme}`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample);
    const hidden = structuredClone(project.screens[0].objects[0]);
    hidden.id = "0199ff60-0000-7000-8000-000000000001";
    hidden.name = "隠れたポンプ";
    hidden.visible = false;
    hidden.locked = true;
    project.screens.push({
      id: "0199ff60-0000-7000-8000-000000000002",
      name: "別の設備画面",
      width: 960,
      height: 540,
      background: "#ffffff",
      folders: [],
      groups: [],
      objects: [hidden],
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "usage.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page
      .getByRole("button", { name: "機器の読取詳細", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "機器の読取詳細を開く",
      exact: true,
    });
    await picker.locator(`input[value="${project.equipment[0].id}"]`).check();
    await picker
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    const window = page.locator('[data-popup-kind="equipment"]');
    await expect(window.locator("[data-equipment-usage]")).toHaveCount(2);
    await expect(
      window.locator(`[data-equipment-usage="${hidden.id}"]`),
    ).toContainText("非表示");
    await window.locator(`[data-equipment-usage="${hidden.id}"]`).click();
    await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "編集", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(`button[data-layer-id="${hidden.id}"]`),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "配置を再表示", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ロックを解除", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(`.sheet > svg [data-object-id="${hidden.id}"]`),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
    const pending = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    expect(
      JSON.parse(await readFile((await (await pending).path())!, "utf8")),
    ).toEqual(project);
  });
test("read detail usage lists are bounded to twenty placements and paginate independently", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    screen = project.screens[0];
  const original = structuredClone(screen.objects[0]);
  screen.objects = [];
  for (let i = 0; i < 24; i++)
    screen.objects.push({
      ...structuredClone(original),
      id: `0199ff61-0000-7000-8000-${String(i).padStart(12, "0")}`,
      order: i,
      name: `ポンプ表示${i}`,
    });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "usages.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "機器の読取詳細", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "機器の読取詳細を開く",
    exact: true,
  });
  await picker.locator(`input[value="${project.equipment[0].id}"]`).check();
  await picker.getByRole("button", { name: "小窓を表示", exact: true }).click();
  const window = page.locator('[data-popup-kind="equipment"]');
  await expect(window.locator("[data-equipment-usage]")).toHaveCount(20);
  await window.getByRole("button", { name: "次の使用先", exact: true }).click();
  await expect(window.locator("[data-equipment-usage]")).toHaveCount(4);
  await expect(window.locator("[data-equipment-slot]")).toHaveCount(
    project.equipment[0].bindings.length,
  );
  await window.getByRole("button", { name: "前の使用先", exact: true }).click();
  await expect(window.locator("[data-equipment-usage]")).toHaveCount(20);
});

test("opening a grouped usage selects the whole geometric group without editing it", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  const screen = project.screens[0];
  screen.groups = [
    {
      id: "0199ff62-0000-7000-8000-000000000001",
      name: "ポンプ組",
      memberIds: [screen.objects[0].id, screen.objects[2].id],
    },
  ];
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "group-usage.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "機器の読取詳細", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "機器の読取詳細を開く",
    exact: true,
  });
  await picker.locator(`input[value="${project.equipment[0].id}"]`).check();
  await picker.getByRole("button", { name: "小窓を表示", exact: true }).click();
  await page
    .locator(`[data-equipment-usage="${screen.objects[0].id}"]`)
    .click();
  await expect(page.getByLabel("グループ名", { exact: true })).toHaveValue(
    "ポンプ組",
  );
  await expect(
    page.getByRole("button", { name: "グループ解除", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  expect(
    JSON.parse(await readFile((await (await pending).path())!, "utf8")),
  ).toEqual(project);
});
