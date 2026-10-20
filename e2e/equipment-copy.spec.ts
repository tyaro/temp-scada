import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, fileCommand } from "./helpers/designer";
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
for (const theme of ["light", "dark"] as const) {
  test(`registering a separate equipment copies adoption without external bindings in ${theme}`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample);
    const source = project.equipment[0];
    const type = project.equipmentTypes.find(
      (item: any) => item.id === source.typeId,
    );
    type.slots.push({ name: "fault", type: "bool", direction: "read" });
    source.bindings = [
      { slotName: "running", externalName: "Plant.Pump01.Running" },
      { slotName: "current", externalName: null },
    ];
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "equipment-copy.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library.locator(`[data-equipment-choice="${source.id}"]`).click();
    await library
      .getByRole("button", {
        name: "この機器を元に別の機器を登録",
        exact: true,
      })
      .click();
    const form = page.getByRole("form", { name: "機器を登録", exact: true });
    await expect(form).toContainText("採用slot 2件");
    await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue("");
    await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
      source.name,
    );
    await expect(form.getByRole("combobox")).toHaveCount(0);
    await expect(form.locator('input[name^="tag:"]')).toHaveCount(0);
    await form.getByLabel("機器番号", { exact: true }).fill(source.code);
    await form.getByRole("button", { name: "機器を登録", exact: true }).click();
    await expect(form).toBeVisible();
    await expect(library.locator("[data-equipment-choice]")).toHaveCount(
      project.equipment.length,
    );
    await form.getByLabel("機器番号", { exact: true }).fill("P-103");
    await form.getByLabel("機器名", { exact: true }).fill("新しい循環ポンプ");
    await form.getByRole("button", { name: "機器を登録", exact: true }).click();
    const editing = page.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    await expect(editing.getByLabel("機器番号", { exact: true })).toHaveValue(
      "P-103",
    );
    const saved = await save(page);
    expect(saved.equipment.slice(0, -1)).toEqual(project.equipment);
    expect(saved.screens).toEqual(project.screens);
    expect(saved.equipmentTypes).toEqual(project.equipmentTypes);
    const created = saved.equipment.at(-1);
    expect(created.id).not.toBe(source.id);
    expect(created).toEqual({
      id: expect.any(String),
      typeId: source.typeId,
      code: "P-103",
      name: "新しい循環ポンプ",
      bindings: [
        { slotName: "running", externalName: null },
        { slotName: "current", externalName: null },
      ],
    });
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    expect(await save(page)).toEqual({
      ...project,
      manifest: {
        ...project.manifest,
        projectRevision: project.manifest.projectRevision + 2,
      },
    });
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    expect(await save(page)).toEqual({
      ...saved,
      manifest: {
        ...saved.manifest,
        projectRevision: saved.manifest.projectRevision + 2,
      },
    });
  });
}
test("copy registration protects source drafts, cancellation and unsaved candidate inputs", async ({
  page,
}) => {
  const project = structuredClone(sample),
    source = project.equipment[0];
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "copy-draft.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  await library.locator(`[data-equipment-choice="${source.id}"]`).click();
  const editing = page.getByRole("form", {
    name: "機器情報と割付",
    exact: true,
  });
  await editing.getByLabel("機器名", { exact: true }).fill("適用後の登録元");
  await library
    .getByRole("button", { name: "この機器を元に別の機器を登録", exact: true })
    .click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(editing.getByLabel("機器名", { exact: true })).toHaveValue(
    "適用後の登録元",
  );
  await library
    .getByRole("button", { name: "この機器を元に別の機器を登録", exact: true })
    .click();
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  const form = page.getByRole("form", { name: "機器を登録", exact: true });
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "適用後の登録元",
  );
  await form.getByLabel("機器番号", { exact: true }).fill("P-104");
  await library
    .getByRole("button", {
      name: "登録元の機器へ戻る",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
    "P-104",
  );
  await library
    .getByRole("button", {
      name: "登録元の機器へ戻る",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(editing.getByLabel("機器番号", { exact: true })).toHaveValue(
    source.code,
  );
  const saved = await save(page);
  project.equipment[0].name = "適用後の登録元";
  expect(saved).toEqual({
    ...project,
    manifest: {
      ...project.manifest,
      projectRevision: project.manifest.projectRevision + 1,
    },
  });
  await library
    .getByRole("button", { name: "この機器を元に別の機器を登録", exact: true })
    .click();
  await form.getByLabel("機器番号", { exact: true }).fill("P-105");
  await library
    .getByRole("button", { name: "登録元の機器へ戻る", exact: true })
    .click();
  await page.getByRole("button", { name: "適用して続行", exact: true }).click();
  await expect(editing.getByLabel("機器番号", { exact: true })).toHaveValue(
    source.code,
  );
  const applied = await save(page);
  expect(applied.equipment).toHaveLength(project.equipment.length + 1);
  expect(applied.equipment.at(-1).code).toBe("P-105");
  expect(applied.equipment.slice(0, -1)).toEqual(project.equipment);
});
