import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { fileCommand, chooseTheme } from "./helpers/designer";
import { readFile } from "node:fs/promises";

// A4: the state rows of an equipment-type slot are edited in the type editor.
async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "types.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  return page.getByRole("region", { name: "機器種別の編集", exact: true });
}
async function saved(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

for (const theme of ["light", "dark"] as const)
  test(`state rows and bool labels are edited and saved on the slot in ${theme}`, async ({
    page,
  }) => {
    const editor = await start(page);
    await chooseTheme(page, theme);
    await editor.getByLabel("種別名", { exact: true }).fill("モータ");
    const add = editor.getByRole("button", {
      name: "読取slotを追加",
      exact: true,
    });
    await add.click();
    await add.click();
    const [run, status] = [
      editor.locator("[data-equipment-type-slot]").nth(0),
      editor.locator("[data-equipment-type-slot]").nth(1),
    ];
    await run.getByLabel("slot名", { exact: true }).fill("run");
    await run.getByLabel("slot型", { exact: true }).selectOption("bool");
    await run.getByLabel("true／falseの文字と色を決める").check();
    await run.getByLabel("falseの文字", { exact: true }).fill("休止");

    await status.getByLabel("slot名", { exact: true }).fill("status");
    await status.getByLabel("slot型", { exact: true }).selectOption("state");
    await status
      .getByLabel("状態の元の値", { exact: true })
      .selectOption("bits");
    await status
      .getByRole("button", { name: "例を入れる", exact: true })
      .click();
    await expect(status.getByLabel("行1のビット", { exact: true })).toHaveValue(
      "2",
    );
    await expect(status.getByLabel("行1の文字", { exact: true })).toHaveValue(
      "故障",
    );
    // The added row takes the lowest unused bit; a duplicate is shown at once.
    await status
      .getByRole("button", { name: "状態の行を追加", exact: true })
      .click();
    await expect(status.getByLabel("行3のビット", { exact: true })).toHaveValue(
      "1",
    );
    await status.getByLabel("行3の文字", { exact: true }).fill("自動");
    await status.getByLabel("行3のビット", { exact: true }).fill("0");
    await expect(status.getByRole("alert")).toHaveText(
      "同じビットの行が上にあります",
    );
    await status.getByLabel("行3のビット", { exact: true }).fill("3");
    await expect(status.getByRole("alert")).toHaveCount(0);
    // Raise the new row above "運転" so it wins when both bits are set.
    await status
      .getByRole("button", { name: "行3を上へ", exact: true })
      .click();
    await expect(status.getByLabel("行2の文字", { exact: true })).toHaveValue(
      "自動",
    );
    await status.getByLabel("行3の色", { exact: true }).fill("#0ea5e9");
    await status.getByLabel("未割付を許す", { exact: false }).check();
    await page.screenshot({
      path: `target/slot-state-rows/edit-${theme}.png`,
    });
    await editor
      .getByRole("button", { name: "機器種別を作成", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "機器種別を適用", exact: true }),
    ).toBeVisible();

    const data = await saved(page);
    const type = data.equipmentTypes.find(
      (item: any) => item.name === "モータ",
    );
    expect(type.slots).toEqual([
      {
        name: "run",
        type: "bool",
        direction: "read",
        boolDisplay: {
          true: { text: "運転", color: "#16a34a" },
          false: { text: "休止", color: "#64748b" },
        },
      },
      {
        name: "status",
        type: "state",
        direction: "read",
        allowUnassigned: true,
        stateDisplay: {
          source: "bits",
          rows: [
            { match: 2, text: "故障", color: "#dc2626" },
            { match: 3, text: "自動", color: "#f59e0b" },
            { match: 0, text: "運転", color: "#0ea5e9" },
          ],
          otherwise: { text: "停止", color: "#64748b" },
        },
      },
    ]);
  });

test("a broken row is refused with where it is and the input is kept", async ({
  page,
}) => {
  const editor = await start(page);
  await editor.getByLabel("種別名", { exact: true }).fill("計器");
  await editor
    .getByRole("button", { name: "読取slotを追加", exact: true })
    .click();
  const slot = editor.locator("[data-equipment-type-slot]").first();
  await slot.getByLabel("slot名", { exact: true }).fill("mode");
  await slot.getByLabel("slot型", { exact: true }).selectOption("state");
  await slot.getByRole("button", { name: "例を入れる", exact: true }).click();
  // Switching to bits leaves values that are not bits; the form names the row.
  await slot.getByLabel("状態の元の値", { exact: true }).selectOption("bits");
  await slot.getByLabel("行1のビット", { exact: true }).fill("40");
  await expect(slot.getByRole("alert")).toHaveText("ビットは0〜31です");
  await editor
    .getByRole("button", { name: "機器種別を作成", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toHaveText(
    "編集エラー: modeの行1: ビットは0〜31です",
  );
  await expect(slot.getByLabel("行1のビット", { exact: true })).toHaveValue(
    "40",
  );
  await expect(
    editor.getByRole("button", { name: "機器種別を作成", exact: true }),
  ).toBeVisible();
});
