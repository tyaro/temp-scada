import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import {
  chooseTheme,
  fileCommand,
  openEquipmentLedger,
} from "./helpers/designer";

// The first test also waits for the dev server's first build.
test.describe.configure({ timeout: 60_000 });

// O1b: the operation (`write`) of a slot is edited on the equipment type, and
// the binding table lists the external names the Project may write.
async function load(page: Page, project: unknown = sample) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "operation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await openEquipmentLedger(page);
  return page.getByRole("region", { name: "機器台帳", exact: true });
}
async function saved(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

for (const theme of ["light", "dark"] as const)
  test(`slot operations are edited, checked and saved on the type in ${theme}`, async ({
    page,
  }) => {
    const library = await load(page);
    await chooseTheme(page, theme);
    await library
      .getByRole("button", { name: "機器種別", exact: true })
      .click();
    const editor = page.getByRole("region", {
      name: "機器種別の編集",
      exact: true,
    });
    await editor.getByLabel("種別名", { exact: true }).fill("ポンプ");
    const add = editor.getByRole("button", {
      name: "読取slotを追加",
      exact: true,
    });
    await add.click();
    await add.click();
    await add.click();
    const [command, speed, mode] = [0, 1, 2].map((index) =>
      editor.locator("[data-equipment-type-slot]").nth(index),
    );

    await command.getByLabel("slot名", { exact: true }).fill("command");
    await command.getByLabel("slot型", { exact: true }).selectOption("bool");
    await command.getByLabel("操作を定義する", { exact: false }).check();
    await command.getByLabel("操作の見出し", { exact: true }).fill("運転指令");
    await command.getByLabel("ボタン1の見出し", { exact: true }).fill("運転");
    await command.getByLabel("ボタン2の見出し", { exact: true }).fill("停止");
    // The same value twice is shown at once, with the button it is on.
    await command
      .getByLabel("ボタン2の値", { exact: true })
      .selectOption("true");
    await expect(command.getByRole("alert")).toHaveText(
      "ボタン2: 同じ値のボタンが上にあります",
    );
    await command
      .getByLabel("ボタン2の値", { exact: true })
      .selectOption("false");
    await expect(command.getByRole("alert")).toHaveCount(0);

    await speed.getByLabel("slot名", { exact: true }).fill("speedSp");
    await speed.getByLabel("操作を定義する", { exact: false }).check();
    await speed.getByLabel("操作の見出し", { exact: true }).fill("回転数 設定");
    await speed.getByLabel("入力の上限", { exact: true }).fill("6");
    await expect(speed.getByRole("alert")).toHaveCount(0);
    await speed.getByLabel("入力の下限", { exact: true }).fill("10");
    await expect(speed.getByRole("alert")).toHaveText(
      "入力の下限が上限より大きいです",
    );
    await speed.getByLabel("入力の下限", { exact: true }).fill("-1.5");
    await speed.getByLabel("入力の上限", { exact: true }).fill("60");
    // A button may hold a value outside the input range (e.g. a stop value).
    await speed
      .getByRole("button", { name: "ボタンを追加", exact: true })
      .click();
    await speed.getByLabel("ボタン1の見出し", { exact: true }).fill("最小");
    await speed.getByLabel("ボタン1の値", { exact: true }).fill("-100");

    await mode.getByLabel("slot名", { exact: true }).fill("mode");
    await mode.getByLabel("slot型", { exact: true }).selectOption("state");
    await mode.getByLabel("操作を定義する", { exact: false }).check();
    await expect(
      mode.getByLabel("数値を入れて書く", { exact: false }),
    ).toHaveCount(0);
    await mode.getByLabel("ボタン1の見出し", { exact: true }).fill("手動");
    await mode
      .getByRole("button", { name: "ボタンを追加", exact: true })
      .click();
    await expect(mode.getByLabel("ボタン2の値", { exact: true })).toHaveValue(
      "1",
    );
    await expect(mode.getByRole("alert")).toHaveText(
      "ボタン2: 見出しを入れてください",
    );
    await mode.getByLabel("ボタン2の値", { exact: true }).fill("1.5");
    await mode.getByLabel("ボタン2の見出し", { exact: true }).fill("自動");
    await expect(mode.getByRole("alert")).toHaveText(
      "ボタン2: 値は0〜2147483647の整数です",
    );
    // Saving is refused with where the problem is; the input is kept.
    await editor
      .getByRole("button", { name: "機器種別を作成", exact: true })
      .click();
    await expect(page.getByTestId("project-status")).toHaveText(
      "編集エラー: modeの操作: ボタン2: 値は0〜2147483647の整数です",
    );
    await mode.getByLabel("ボタン2の値", { exact: true }).fill("2");
    await page.screenshot({ path: `target/operation-write/edit-${theme}.png` });
    await editor
      .getByRole("button", { name: "機器種別を作成", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "機器種別を適用", exact: true }),
    ).toBeVisible();

    const type = (await saved(page)).equipmentTypes.find(
      (item: { name: string }) => item.name === "ポンプ",
    );
    expect(type.slots).toEqual([
      {
        name: "command",
        type: "bool",
        direction: "read",
        write: {
          label: "運転指令",
          buttons: [
            { label: "運転", value: true },
            { label: "停止", value: false },
          ],
        },
      },
      {
        name: "speedSp",
        type: "number",
        direction: "read",
        write: {
          label: "回転数 設定",
          input: { min: -1.5, max: 60 },
          buttons: [{ label: "最小", value: -100 }],
        },
      },
      {
        name: "mode",
        type: "state",
        direction: "read",
        stateDisplay: {
          source: "value",
          rows: [],
          otherwise: { text: "", color: "#64748b" },
        },
        write: {
          label: "選択",
          buttons: [
            { label: "手動", value: 0 },
            { label: "自動", value: 2 },
          ],
        },
      },
    ]);
  });

test("changing a slot type drops its operation; turning it off removes it", async ({
  page,
}) => {
  const library = await load(page);
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "機器種別の編集",
    exact: true,
  });
  await editor.getByLabel("種別名", { exact: true }).fill("弁");
  await editor
    .getByRole("button", { name: "読取slotを追加", exact: true })
    .click();
  const slot = editor.locator("[data-equipment-type-slot]").first();
  await slot.getByLabel("slot名", { exact: true }).fill("open");
  await slot.getByLabel("操作を定義する", { exact: false }).check();
  await expect(slot.getByLabel("入力の下限", { exact: true })).toHaveValue("0");
  await slot.getByLabel("slot型", { exact: true }).selectOption("bool");
  await expect(
    slot.getByLabel("操作を定義する", { exact: false }),
  ).not.toBeChecked();
  await slot.getByLabel("操作を定義する", { exact: false }).check();
  await expect(slot.getByLabel("ボタン1の値", { exact: true })).toHaveValue(
    "true",
  );
  await slot.getByLabel("操作を定義する", { exact: false }).uncheck();
  await expect(slot.getByLabel("操作の見出し", { exact: true })).toHaveCount(0);
});

test("the binding table lists write tags to copy or export as CSV", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const project = structuredClone(sample);
  (project.equipmentTypes[0].slots[0] as Record<string, unknown>).write = {
    label: "運転指令",
    buttons: [{ label: "運転", value: true }],
  };
  const library = await load(page, project);
  await library
    .getByRole("button", { name: "割付の一覧表", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "割付の一覧表" });
  await dialog
    .getByRole("button", { name: "書込みタグの一覧", exact: true })
    .click();
  const list = dialog.getByRole("region", { name: "書込みタグの一覧" });
  await expect(list.getByRole("table", { name: "書込みタグ" })).toContainText(
    "Demo.Water.Pump02.Run",
  );
  await expect(list).toContainText("書込みタグ 1件");
  // P-101 adopts the operated slot without a name: it cannot be written.
  await expect(list).toContainText("未割付の1件");
  await expect(list).toContainText("P-101 / running");
  await page.screenshot({ path: "target/operation-write/write-tags.png" });

  await list
    .getByRole("button", { name: "外部名をコピー", exact: true })
    .click();
  await expect(list).toContainText("1件の外部名をコピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Demo.Water.Pump02.Run",
  );
  const pending = page.waitForEvent("download");
  await list
    .getByRole("button", { name: "CSV を書き出す", exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^write-tags-.*\.csv$/);
  expect(await readFile((await download.path())!, "utf8")).toBe(
    "﻿externalName,equipmentCode,equipmentName,slot,slotType,label\r\n" +
      `Demo.Water.Pump02.Run,P-102,${project.equipment[1].name},running,bool,運転指令\r\n`,
  );
});
