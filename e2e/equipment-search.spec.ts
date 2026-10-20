import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { fileCommand } from "./helpers/designer";

test("equipment search and bounded pages preserve the current draft and never enter Project", async ({
  page,
}) => {
  const project = structuredClone(sample);
  for (let i = 1; i <= 53; i++)
    project.equipment.push({
      id: `0199ff50-0000-7000-8000-${String(i).padStart(12, "0")}`,
      typeId: project.equipmentTypes[0].id,
      code: `FAN-${String(i).padStart(3, "0")}`,
      name: `排気送風機 ${i}`,
      bindings: [],
    });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  async function load() {
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "many.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
  }
  await load();
  const library = page.getByRole("region", { name: "機器台帳", exact: true });
  const choices = library.locator("button[data-equipment-choice]");
  const search = library.getByRole("searchbox", {
    name: "機器を検索",
    exact: true,
  });
  await expect(choices).toHaveCount(20);
  await library.getByRole("button", { name: "次の機器", exact: true }).click();
  await expect(choices).toHaveCount(20);
  await library.getByRole("button", { name: "次の機器", exact: true }).click();
  await expect(choices).toHaveCount(15);
  await expect(
    library.getByRole("button", { name: "次の機器", exact: true }),
  ).toBeDisabled();
  await search.fill("ＦＡＮ－０５３");
  await expect(choices).toHaveCount(1);
  await expect(choices.first()).toHaveText("FAN-053 · 排気送風機 53");
  await choices.first().click();
  const form = library.getByRole("form", {
    name: "機器情報と割付",
    exact: true,
  });
  await form.getByLabel("機器名", { exact: true }).fill("未適用の名前");
  await search.fill("no result");
  await expect(choices).toHaveCount(0);
  await expect(
    library.getByText("一致する機器はありません。", { exact: true }),
  ).toBeVisible();
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await expect(
    library.getByText("編集中: FAN-053（検索結果外）", { exact: true }),
  ).toBeVisible();
  await search.fill("fan-001");
  await choices.first().click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
    "FAN-053",
  );
  await expect(form.getByLabel("機器名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await choices.first().click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(form.getByLabel("機器番号", { exact: true })).toHaveValue(
    "FAN-001",
  );
  await search.fill("モーター");
  await expect(choices).toHaveCount(20);
  await expect(
    library.getByText("55件 / 全55件", { exact: true }),
  ).toBeVisible();
  await search.fill("");
  await expect(
    library.getByRole("button", { name: "前の機器", exact: true }),
  ).toBeDisabled();
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  expect(
    JSON.parse(await readFile((await (await pending).path())!, "utf8")),
  ).toEqual(project);
  await search.fill("fan-053");
  await load();
  await expect(search).toHaveValue("");
  await expect(choices).toHaveCount(20);
});
