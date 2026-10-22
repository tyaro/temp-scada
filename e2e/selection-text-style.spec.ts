import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process.project.json" with { type: "json" };
import equipment from "../examples/equipment-property.project.json" with { type: "json" };
import { selectPanel, chooseTheme, fileCommand } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const form = (page: Page) =>
  page.getByRole("form", { name: "選択した文字の書式を変更", exact: true });
const size = (page: Page) =>
  form(page).getByLabel("適用する文字サイズ", { exact: true });
const weight = (page: Page) =>
  form(page).getByLabel("適用する文字の太さ", { exact: true });
const align = (page: Page) =>
  form(page).getByLabel("適用する文字揃え", { exact: true });
const apply = (page: Page) =>
  form(page).getByRole("button", {
    name: "選択した文字に書式を適用",
    exact: true,
  });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const ids = sample.screens[0].objects
  .filter((o) => o.shape.type === "text")
  .slice(0, 2)
  .map((o) => o.id);
async function start(page: Page, fixture: object = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "text-style.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await selectPanel(page, "レイヤー");
}
async function two(page: Page, selected = ids) {
  await row(page, selected[0]).click();
  await row(page, selected[1]).click({ modifiers: ["ControlOrMeta"] });
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
for (const theme of ["light", "dark"] as const)
  test(`mixed Text styles apply specified fields once and retain body and bounds in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await two(page);
    await expect(
      page.getByRole("region", { name: "選択した文字の書式", exact: true }),
    ).toContainText("現在の文字サイズ：混在");
    await expect(size(page)).toHaveValue("");
    await expect(weight(page)).toHaveValue("");
    await expect(apply(page)).toBeDisabled();
    await size(page).fill("18");
    await size(page).press("Tab");
    await expect(button(page, "元に戻す")).toBeDisabled();
    await weight(page).selectOption("bold");
    await align(page).selectOption("right");
    await apply(page).click();
    await expect(size(page)).toHaveValue("");
    await expect(weight(page)).toHaveValue("");
    await expect(align(page)).toHaveValue("");
    for (const id of ids) {
      const text = page.locator(
        `.sheet > svg [data-object-id="${id}"] [data-text-content]`,
      );
      await expect(text).toHaveAttribute("font-size", "18");
      await expect(text).toHaveAttribute("font-weight", "bold");
    }
    const result = await saved(page);
    expect(result.screens[0].objects).toEqual(
      sample.screens[0].objects.map((o) =>
        ids.includes(o.id) && o.shape.type === "text"
          ? {
              ...o,
              shape: {
                ...o.shape,
                style: { fontSize: 18, fontWeight: "bold", align: "right" },
              },
            }
          : o,
      ),
    );
    await weight(page).selectOption("bold");
    await apply(page).click();
    await button(page, "元に戻す").click();
    await expect(button(page, "元に戻す")).toBeDisabled();
    await button(page, "やり直す").click();
  });
test("invalid values, IME and other pending forms preserve drafts and selection guards", async ({
  page,
}) => {
  await start(page);
  await two(page);
  await size(page).fill("513");
  await apply(page).click();
  await expect(size(page)).toHaveValue("513");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await size(page).fill("18");
  await size(page).dispatchEvent("compositionstart");
  await size(page).press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await size(page).dispatchEvent("compositionend");
  await row(
    page,
    sample.screens[0].objects.find((o) => o.shape.type !== "text")!.id,
  ).click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(size(page)).toHaveValue("18");
  await page.getByLabel("適用する不透明度（%）", { exact: true }).fill("50");
  await apply(page).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("適用する不透明度（%）", { exact: true }).fill("");
  await size(page).press("Enter");
  await expect(size(page)).toHaveValue("");
});
test("mixed non-Text and locked selections cannot be partially styled, hidden Text stays hidden", async ({
  page,
}) => {
  await start(page);
  await two(page, [
    ids[0],
    sample.screens[0].objects.find((o) => o.shape.type !== "text")!.id,
  ]);
  await expect(form(page)).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "選択した文字の書式", exact: true }),
  ).toContainText("Textだけを選択");
  const fixture = structuredClone(sample);
  Object.assign(
    fixture.screens[0].objects.find((o) => o.id === ids[0])!,
    { visible: false },
  );
  Object.assign(
    fixture.screens[0].objects.find((o) => o.id === ids[1])!,
    { locked: true },
  );
  await start(page, fixture);
  await two(page);
  await expect(size(page)).toBeDisabled();
  delete (fixture.screens[0].objects.find((o) => o.id === ids[1])! as any)
    .locked;
  await start(page, fixture);
  await two(page);
  await expect(
    page.getByRole("region", { name: "選択した文字の書式", exact: true }),
  ).toContainText("うち非表示 1 件");
  await size(page).fill("20");
  await apply(page).click();
  const result = await saved(page);
  expect(
    result.screens[0].objects.find((o: any) => o.id === ids[0]),
  ).toMatchObject({ visible: false, shape: { style: { fontSize: 20 } } });
});
test("definition-owned metadata and slot Text retain their display sources and placed Symbol frames", async ({
  page,
}) => {
  await start(page, equipment);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const texts = [
    equipment.symbols[0].objects.find(
      (o) => o.shape.type === "text" && "slotBinding" in o.shape,
    )!,
    equipment.symbols[0].objects.find(
      (o) => o.shape.type === "text" && "equipmentProperty" in o.shape,
    )!,
  ];
  await two(
    page,
    texts.map((o) => o.id),
  );
  await weight(page).selectOption("bold");
  await apply(page).click();
  const result = await saved(page);
  expect(result.screens).toEqual(equipment.screens);
  expect(result.equipment).toEqual(equipment.equipment);
  expect(result.symbols[0].objects).toEqual(
    equipment.symbols[0].objects.map((o) =>
      texts.some((t) => t.id === o.id) && o.shape.type === "text"
        ? {
            ...o,
            shape: {
              ...o.shape,
              style: { ...o.shape.style, fontWeight: "bold" },
            },
          }
        : o,
    ),
  );
});
