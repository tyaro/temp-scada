import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import { mainCanvas } from "./helpers/designer";

// 段階3の運転操作 §8（O3c-2）: Editor の表示プレビューの「実行」は Hub へ送らず、
// slot のタグの模擬値を書いた値に変える。
const [pump] = sample.equipment;
const linkedId = "0199f600-0000-7000-8000-000000000020";

/** The sample with `write` on the motor type's slots (as runtime-mode.spec.ts). */
function operationProject() {
  const project = structuredClone(sample) as any;
  for (const type of project.equipmentTypes)
    for (const slot of type.slots)
      if (slot.name === "running")
        slot.write = {
          label: "運転指令",
          buttons: [
            { label: "運転", value: true },
            { label: "停止", value: false },
          ],
        };
      else if (slot.name === "current")
        slot.write = { label: "電流 設定", input: { min: 0, max: 100 } };
  return project;
}

async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "operation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(operationProject())),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
}

test("the preview's 実行 changes the simulated value and shows 模擬", async ({
  page,
}) => {
  await start(page);
  await mainCanvas(page).locator(`g[data-object-id="${linkedId}"]`).click();
  const rows = page.getByRole("region", { name: "機器の操作" });
  await expect(rows.locator("[data-operation-simulated]")).toHaveText("模擬");
  await expect(rows.locator("[data-operation-disabled]")).toHaveCount(0);
  await expect(rows.locator("[data-operation-banner]")).toHaveCount(0);
  const running = rows.locator("[data-operation-slot='running']");
  await expect(running.locator(".value")).not.toContainText("SIM");

  await running.getByRole("button", { name: "運転", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "操作の確認" });
  await expect(dialog.locator("[data-operation-simulated]")).toContainText(
    "模擬",
  );
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await dialog.getByRole("button", { name: "実行" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(running.locator("[data-operation-result]")).toContainText(
    "書込みました",
  );
  await expect(running.locator("[data-operation-result]")).toContainText(
    "要求値 運転（true）",
  );
  await expect(running.locator(".value")).toContainText("SIM · true");
  // The read details of the same popup show the simulated value too.
  await expect(
    page.locator(
      `[data-preview-popup="${pump.id}"] [data-equipment-slot="running"]`,
    ),
  ).toContainText("SIM");

  // An input goes through the same check, then sets the simulated value.
  const current = rows.locator("[data-operation-slot='current']");
  await current.getByRole("textbox").fill("12.5");
  await current.getByRole("button", { name: "設定" }).click();
  await dialog.getByRole("button", { name: "実行" }).click();
  await expect(current.locator("[data-operation-result]")).toContainText(
    "書込みました",
  );
  await expect(current.locator(".value")).toContainText("SIM · 12.5");
});

test("the Editor's operator view writes simulated values with its note", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "運転表示", exact: true }).click();
  await expect(page.getByText("表示確認（模擬の書込み）")).toBeVisible();
  await page
    .getByRole("region", { name: "運転表示" })
    .locator(`[data-equipment-link="${pump.id}"]`)
    .first()
    .click();
  const rows = page.getByRole("region", { name: "機器の操作" });
  await expect(rows.locator("[data-operation-simulated]")).toHaveText("模擬");
  await rows.getByRole("button", { name: "停止", exact: true }).click();
  await page
    .getByRole("dialog", { name: "操作の確認" })
    .getByRole("button", { name: "実行" })
    .click();
  await expect(
    rows.locator("[data-operation-slot='running'] [data-operation-result]"),
  ).toContainText("書込みました");
  await expect(
    rows.locator("[data-operation-slot='running'] .value"),
  ).toContainText("SIM · false");
});
