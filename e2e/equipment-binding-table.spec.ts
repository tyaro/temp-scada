import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, fileCommand } from "./helpers/designer";
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
async function leaving(page: Page) {
  return page.evaluate(() =>
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  );
}
async function open(page: Page, theme: string, project: unknown = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await chooseTheme(page, theme);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "binding-table.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("region", { name: "機器台帳", exact: true })
    .getByRole("button", { name: "割付の一覧表", exact: true })
    .click();
  return page.getByRole("dialog", { name: "割付の一覧表" });
}
async function paste(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

for (const theme of ["light", "dark"] as const) {
  test(`binding table edits, pastes, reviews and applies as one edit in ${theme}`, async ({
    page,
  }) => {
    const dialog = await open(page, theme);
    const table = dialog.getByRole("table", { name: "モーターの割付" });
    // Two prefix cells and four slot cells.
    await expect(table.getByRole("textbox")).toHaveCount(6);
    await expect(dialog.getByLabel("P-101のrunning")).toHaveValue("");
    await expect(dialog.getByLabel("P-101のrunning")).toHaveAttribute(
      "placeholder",
      "未割付",
    );
    await expect(dialog.getByLabel("P-101のcurrent")).toHaveAttribute(
      "placeholder",
      "未採用",
    );
    await expect(dialog.getByLabel("P-102のrunning")).toHaveValue(
      "Demo.Water.Pump02.Run",
    );
    await expect(dialog.getByText("未解決", { exact: true })).toHaveCount(1);

    await paste(
      page,
      "P-101のrunning",
      "Demo.Water.Pump01.Running\tDemo.Water.Pump01.Pressure\r\nDemo.Water.Pump01.Pressure\t \textra\r\n",
    );
    await expect(dialog).toContainText(
      "4セルを貼り付けました。表の外の1セルは入れていません。",
    );
    await expect(dialog.getByLabel("P-101のcurrent")).toHaveValue(
      "Demo.Water.Pump01.Pressure",
    );
    // A number tag in a bool slot is flagged, but can still be applied.
    await expect(
      dialog.getByText("型が合わない・無効", { exact: true }),
    ).toHaveCount(1);
    await expect(dialog).toContainText("変更 3件");

    await dialog.getByRole("button", { name: "差分を確認（3件）" }).click();
    const review = dialog.getByRole("table", { name: "割付の変更点" });
    await expect(review.getByRole("row")).toHaveCount(4);
    await expect(review).toContainText("未採用");
    await expect(review).toContainText("Demo.Water.Pump02.Run");
    await expect(dialog).toContainText(
      "タグ一覧にない名前・型が合わない名前が1件あります",
    );
    await dialog.getByRole("button", { name: "3件を適用" }).click();
    await expect(dialog).toBeHidden();

    const saved = await save(page);
    expect(saved.equipment[0].bindings).toEqual([
      { slotName: "running", externalName: "Demo.Water.Pump01.Running" },
      { slotName: "current", externalName: "Demo.Water.Pump01.Pressure" },
    ]);
    expect(saved.equipment[1].bindings).toEqual([
      { slotName: "running", externalName: "Demo.Water.Pump01.Pressure" },
      { slotName: "current", externalName: null },
    ]);

    await page.keyboard.press("Control+z");
    const undone = await save(page);
    expect(undone.equipment).toEqual(sample.equipment);
  });
}

test("closing with unapplied cells asks before discarding", async ({
  page,
}) => {
  const dialog = await open(page, "light");
  expect(await leaving(page)).toBe(true);
  await dialog.getByLabel("P-101のcurrent").fill("Demo.Water.Pump01.Pressure");
  // Unapplied cells are protected from reload like other unapplied input.
  expect(await leaving(page)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("alert")).toContainText(
    "未適用の変更が1件あります",
  );
  await dialog.getByRole("button", { name: "表へ戻る" }).click();
  await expect(dialog.getByLabel("P-101のcurrent")).toHaveValue(
    "Demo.Water.Pump01.Pressure",
  );
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "破棄して閉じる" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "割付の一覧表", exact: true }),
  ).toBeFocused();
  expect(await leaving(page)).toBe(true);
  const saved = await save(page);
  expect(saved.equipment).toEqual(sample.equipment);
});

test("over-long names block the review until fixed", async ({ page }) => {
  const dialog = await open(page, "light");
  const cell = dialog.getByLabel("P-101のcurrent");
  await cell.fill("x".repeat(513));
  await expect(cell).toHaveAttribute("aria-invalid", "true");
  await expect(
    dialog.getByRole("button", { name: "差分を確認（1件）" }),
  ).toBeDisabled();
  await cell.fill("ok");
  await expect(
    dialog.getByRole("button", { name: "差分を確認（1件）" }),
  ).toBeEnabled();
});

test("fills tag names from row prefixes and the slot suffixes set on the type", async ({
  page,
}) => {
  // P-101 has no running binding, so a blanked running cell adopts it unassigned.
  const project = structuredClone(sample);
  project.equipment[0].bindings = [];
  await open(page, "light", project);
  await page.keyboard.press("Escape");
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library.getByRole("button", { name: "機器種別", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "機器種別の編集",
    exact: true,
  });
  await editor
    .getByLabel("編集する機器種別", { exact: true })
    .selectOption(sample.equipmentTypes[0].id);
  const [running, current] = [
    editor.locator("[data-equipment-type-slot]").nth(0),
    editor.locator("[data-equipment-type-slot]").nth(1),
  ];
  await running.getByLabel("タグ名の末尾", { exact: true }).fill("Running");
  await running.getByLabel(/未割付を許す/).check();
  await current.getByLabel("タグ名の末尾", { exact: true }).fill("Pressure");
  await editor
    .getByRole("button", { name: "機器種別を適用", exact: true })
    .click();
  await expect(
    editor.getByLabel("タグ名の末尾", { exact: true }).first(),
  ).toHaveValue("Running");

  await library.getByRole("button", { name: "機器一覧", exact: true }).click();
  await library
    .getByRole("button", { name: "割付の一覧表", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "割付の一覧表" });
  // A vertical paste fills the prefixes of following rows.
  await paste(
    page,
    "P-101の接頭辞",
    "Demo.Water.Pump09.\r\nDemo.Water.Pump01.\r\n",
  );
  await expect(dialog.getByLabel("P-102の接頭辞")).toHaveValue(
    "Demo.Water.Pump01.",
  );
  await dialog.getByRole("button", { name: "接頭辞から入れる" }).click();
  await expect(dialog).toContainText(
    "3件を入れました。未割付を許すslotで見つからない1件は空欄にしました。",
  );
  await expect(dialog.getByLabel("P-101のrunning")).toHaveValue("");
  await expect(dialog.getByLabel("P-101のrunning")).toHaveAttribute(
    "placeholder",
    "未割付",
  );
  // A missing name of a slot that must be assigned is kept and shown.
  await expect(dialog.getByLabel("P-101のcurrent")).toHaveValue(
    "Demo.Water.Pump09.Pressure",
  );
  await expect(dialog.getByText("未解決", { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel("P-102のrunning")).toHaveValue(
    "Demo.Water.Pump01.Running",
  );
  await expect(dialog).toContainText("変更 4件");

  await dialog.getByRole("button", { name: "差分を確認（4件）" }).click();
  await expect(
    dialog.getByRole("table", { name: "割付の変更点" }).getByRole("row"),
  ).toHaveCount(5);
  await dialog.getByRole("button", { name: "4件を適用" }).click();
  await expect(dialog).toBeHidden();
  const saved = await save(page);
  expect(
    saved.equipmentTypes[0].slots.map((slot: any) => slot.tagSuffix),
  ).toEqual(["Running", "Pressure"]);
  expect(saved.equipment[0].bindings).toEqual([
    { slotName: "running", externalName: null },
    { slotName: "current", externalName: "Demo.Water.Pump09.Pressure" },
  ]);
  expect(saved.equipment[1].bindings).toEqual([
    { slotName: "running", externalName: "Demo.Water.Pump01.Running" },
    { slotName: "current", externalName: "Demo.Water.Pump01.Pressure" },
  ]);
});

test("exports the saved names missing from the Hub tag list as a Hub tag CSV", async ({
  page,
}) => {
  const project = structuredClone(sample);
  project.equipment[0].bindings = [
    { slotName: "running", externalName: "Demo.Pump01.Running" },
    // In the tag list, so left out before any split.
    { slotName: "current", externalName: "Demo.Water.Pump01.Pressure" },
  ];
  const dialog = await open(page, "light", project);
  const exportButton = dialog.getByRole("button", {
    name: "Hub 登録用 CSV を書き出す",
  });
  // Unapplied cells stop the export until they are applied or undone.
  await dialog.getByLabel("P-102のcurrent").fill("Demo.Water.Pump02.Current");
  await exportButton.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "未適用の変更が1件あります。",
  );
  await dialog.getByRole("button", { name: "変更を取り消す" }).click();

  const pending = page.waitForEvent("download");
  await exportButton.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(
    "hub-tags-共有Symbol _ 読取slotの状態確認.csv",
  );
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toBe(
    "\uFEFFconnection,group,name,address,dataType,stringLength,stringEncoding,unit,decimals,rawLo,rawHi,engLo,engHi,enabled,writable,tagKind,expression,retain,comment\r\n" +
      "Demo,Pump01,Running,,bit,,,,,,,,,true,false,plc,,false,P-101 循環ポンプ / running\r\n",
  );
  await expect(dialog).toContainText(
    "Hub 登録用 CSV に1件を書き出しました。Hub のタグ一覧に既にある1件を除きました。接続.グループ.タグに分けられない1件を除きました",
  );
  const skipped = dialog.getByRole("table", { name: "書き出さなかった名前" });
  await expect(skipped.getByRole("row")).toHaveCount(2);
  // Four parts cannot be told apart, so the name is not split.
  await expect(skipped).toContainText("P-102");
  await expect(skipped).toContainText("Demo.Water.Pump02.Run");
});
