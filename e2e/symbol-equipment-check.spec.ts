import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
async function start(page: Page, project: any) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "check.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page
    .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
    .click();
  const check = page.getByRole("region", {
    name: "関連付け候補の確認",
    exact: true,
  });
  await check.locator("summary").click();
  return check;
}
for (const theme of ["light", "dark"] as const)
  test(`configuration check follows both pending selectors, cancel, discard, apply and Undo in ${theme}`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample);
    const other = structuredClone(project.symbols[0]);
    other.id = "0199ff71-0000-7000-8000-000000000001";
    other.name = "別の読取定義";
    other.readSlots = [
      { name: "enabled", type: "bool", direction: "read" },
      { name: "current", type: "bool", direction: "read" },
    ];
    other.objects.forEach((object: any, i: number) => {
      object.id = `0199ff71-0000-7000-8000-${String(i + 2).padStart(12, "0")}`;
      if (object.shape.slotBinding?.slotName === "running")
        object.shape.slotBinding.slotName = "enabled";
    });
    project.symbols.push(other);
    project.symbols[0].readSlots.push({
      name: "unused",
      type: "bool",
      direction: "read",
    });
    project.symbols[0].objects.find(
      (object: any) => object.shape.slotBinding?.slotName === "running",
    ).visible = false;
    const check = await start(page, project);
    await chooseTheme(page, theme);
    const row = (name: string) =>
      check.locator(`[data-equipment-check-slot="${name}"]`);
    await expect(row("running")).toHaveAttribute(
      "data-equipment-check-state",
      "unassigned",
    );
    await expect(row("current")).toHaveAttribute(
      "data-equipment-check-state",
      "unadopted",
    );
    await expect(check).toContainText("未使用の宣言slot 1件");
    const definition = page.getByLabel("参照する Symbol 定義", { exact: true }),
      equipment = page.getByLabel("関連付ける機器", { exact: true });
    await definition.selectOption(other.id);
    await equipment.selectOption(project.equipment[1].id);
    await expect(check).toContainText("別の読取定義");
    await expect(row("enabled")).toHaveAttribute(
      "data-equipment-check-state",
      "missingSlot",
    );
    await expect(row("current")).toHaveAttribute(
      "data-equipment-check-state",
      "typeMismatch",
    );
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(definition).toHaveValue(other.id);
    await expect(row("enabled")).toHaveAttribute(
      "data-equipment-check-state",
      "missingSlot",
    );
    await definition.selectOption(project.symbols[0].id);
    await expect(row("running")).toHaveText(
      "running · bool外部名あり・catalog未確認",
    );
    await page.getByRole("button", { name: "変更を適用", exact: true }).click();
    await expect(equipment).toHaveValue(project.equipment[1].id);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(equipment).toHaveValue(project.equipment[0].id);
    await expect(row("running")).toHaveAttribute(
      "data-equipment-check-state",
      "unassigned",
    );
    await equipment.selectOption(project.equipment[1].id);
    await definition.selectOption(other.id);
    await expect(row("current")).toHaveAttribute(
      "data-equipment-check-state",
      "typeMismatch",
    );
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page
      .getByRole("button", { name: "入力を破棄して続行", exact: true })
      .click();
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "レイヤー");
    await page
      .locator(`button[data-layer-id="${project.screens[0].objects[0].id}"]`)
      .click();
    if (!(await check.locator("details").getAttribute("open")))
      await check.locator("summary").click();
    await expect(row("running")).toHaveAttribute(
      "data-equipment-check-state",
      "unassigned",
    );
    await expect(
      check.locator('[data-equipment-check-slot="enabled"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
  });
test("locked selectors still provide read-only configuration and empty equipment stays unbound", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.screens[0].objects[0].locked = true;
  delete project.screens[0].objects[0].shape.equipmentId;
  const check = await start(page, project);
  await expect(
    page.getByLabel("関連付ける機器", { exact: true }),
  ).toBeDisabled();
  await expect(
    check.locator('[data-equipment-check-state="unbound"]'),
  ).toHaveCount(2);
  await expect(check).toContainText("機器: 関連付けなし");
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
test("used-role checks paginate at twenty and switching candidate resets the page", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    definition = project.symbols[0];
  const text = structuredClone(
    definition.objects.find((object: any) => object.shape.type === "text"),
  );
  definition.readSlots = [];
  definition.objects = [];
  for (let i = 0; i < 24; i++) {
    const name = `signal${i}`;
    definition.readSlots.push({ name, type: "bool", direction: "read" });
    const object = structuredClone(text);
    object.id = `0199ff72-0000-7000-8000-${String(i).padStart(12, "0")}`;
    object.order = i;
    object.shape.slotBinding.slotName = name;
    definition.objects.push(object);
  }
  const check = await start(page, project);
  await expect(check.locator("[data-equipment-check-slot]")).toHaveCount(20);
  await check.getByRole("button", { name: "次の確認", exact: true }).click();
  await expect(check.locator("[data-equipment-check-slot]")).toHaveCount(4);
  await page.getByLabel("関連付ける機器", { exact: true }).selectOption("");
  await expect(check.locator("[data-equipment-check-slot]")).toHaveCount(20);
  await expect(
    check.locator('[data-equipment-check-state="unbound"]'),
  ).toHaveCount(20);
});
