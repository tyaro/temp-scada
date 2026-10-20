import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileCommand } from "./helpers/designer";
const sample = JSON.parse(
  readFileSync("examples/equipment.project.json", "utf8"),
);
for (const theme of ["light", "dark"] as const) {
  test(`equipment registration and adopted slot states round-trip in ${theme}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "テーマを変更", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: theme === "light" ? "ライト" : "ダーク",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .getByRole("button", { name: "FAN-101 · 誘引送風機", exact: true })
      .click();
    const form = page.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    const states = form.getByRole("combobox", {
      name: "採用・割付状態",
      exact: true,
    });
    await expect(states.nth(0)).toHaveValue("unassigned");
    await expect(states.nth(1)).toHaveValue("unadopted");
    await states.nth(0).selectOption("assigned");
    await form
      .locator('input[name="tag:running"]')
      .fill("PLC01.Fast.Fan01.Run");
    await states.nth(1).selectOption("unassigned");
    await form
      .getByRole("button", { name: "機器情報と割付を適用", exact: true })
      .click();
    const saving = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await saving).path())!, "utf8"),
    );
    expect(saved.manifest.schemaVersion).toBe("0.26.0");
    expect(saved.equipment[0].bindings).toEqual([
      { slotName: "running", externalName: "PLC01.Fast.Fan01.Run" },
      { slotName: "current", externalName: null },
    ]);
    await library
      .getByRole("button", { name: "機器を新規登録", exact: true })
      .click();
    const create = page.getByRole("form", { name: "機器を登録", exact: true });
    await create.getByLabel("機器番号", { exact: true }).fill("FAN-102");
    await create.getByLabel("機器名", { exact: true }).fill("押込送風機");
    await create
      .getByRole("button", { name: "機器を登録", exact: true })
      .click();
    await expect(
      library.getByRole("button", {
        name: "FAN-102 · 押込送風機",
        exact: true,
      }),
    ).toBeVisible();
    await library
      .getByRole("button", { name: "FAN-102 · 押込送風機", exact: true })
      .click();
    await expect(states.nth(0)).toHaveValue("unadopted");
  });
}
test("equipment drafts guard switching, Undo and invalid duplicate codes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "equipment.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library
    .getByRole("button", { name: "FAN-101 · 誘引送風機", exact: true })
    .click();
  const form = page.getByRole("form", { name: "機器情報と割付", exact: true });
  await form.getByLabel("機器名", { exact: true }).fill("未適用の名称");
  await library
    .getByRole("button", { name: "機器を新規登録", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "キャンセル", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "未適用の名称",
  );
  await form
    .getByRole("button", { name: "機器情報と割付を適用", exact: true })
    .click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "誘引送風機",
  );
  await library
    .getByRole("button", { name: "機器を新規登録", exact: true })
    .click();
  const create = page.getByRole("form", { name: "機器を登録", exact: true });
  await create.getByLabel("機器番号", { exact: true }).fill("FAN-101");
  await create.getByLabel("機器名", { exact: true }).fill("重複");
  await create.getByRole("button", { name: "機器を登録", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "FAN-101 · 重複", exact: true }),
  ).toHaveCount(0);
  await expect(create.getByLabel("機器名", { exact: true })).toHaveValue(
    "重複",
  );
});

test("preset registration has no phantom draft, prevents duplicates and ignores IME submit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library
    .getByRole("button", { name: "送風機種別を追加", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "送風機種別を追加", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(library).toHaveCount(0);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const form = page.getByRole("form", { name: "機器を登録", exact: true });
  await form.getByLabel("機器番号", { exact: true }).fill("FAN-201");
  const name = form.getByLabel("機器名", { exact: true });
  await name.fill("送風機201");
  await name.dispatchEvent("compositionstart");
  await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
  await expect(
    library.getByRole("button", { name: "FAN-201 · 送風機201", exact: true }),
  ).toHaveCount(0);
  await name.dispatchEvent("compositionend");
  await form.getByRole("button", { name: "機器を登録", exact: true }).click();
  await expect(
    page.getByRole("form", { name: "機器情報と割付", exact: true }),
  ).toBeVisible();
});

test("equipment import rejects the previous schema and retains the current project", async ({
  page,
}) => {
  await page.goto("/");
  const old = structuredClone(sample);
  old.manifest.schemaVersion = "0.22.0";
  old.manifest.minRuntimeVersion = "0.22.0";
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(old)),
  });
  await expect(page.getByTestId("project-status")).not.toHaveText(
    "Project を読み込みました。",
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "機器台帳", exact: true })
      .getByRole("button", { name: "FAN-101 · 誘引送風機", exact: true }),
  ).toHaveCount(0);
});
