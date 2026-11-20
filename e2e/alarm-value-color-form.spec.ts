import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { selectPanel } from "./helpers/designer";
import {
  downloadBytes,
  downloadProject,
  openProject,
} from "./helpers/project-files";

// 数値の Text の「警報の色」フォーム。仕様: docs/design/graphics/alarm-value-color.md
// 文字の色（描画）は見ない。保存した Project の alarmColor で確かめる。
const TEMP_TAG = "Demo.Water.Tank01.Temperature";
const [TEMP_DEF, PUMP_DEF] = sample.alarms.definitions.map((row) => row.id);
const SPARE_DEF = "0199f6a1-0000-7000-8000-000000000199";
const objects = sample.screens[0].objects.filter(
  (object) => object.shape.type === "text",
);
const textIndex = (id: string) =>
  sample.screens[0].objects.findIndex((object) => object.id === id);
const PLAIN = objects[0].id; // タグ無し
const BOUND = objects[1].id; // タグ結合
const BOOL = objects[2].id; // タグ結合 + boolDisplay
const COLORED = objects[3].id; // タグ結合 + alarmColor

function buildProject(mutate?: (project: any) => void) {
  const project = structuredClone(sample) as any;
  const shapes = [BOUND, BOOL, COLORED].map(
    (id) => project.screens[0].objects[textIndex(id)],
  );
  shapes.unshift(undefined);
  shapes[1].shape.binding = { externalName: TEMP_TAG };
  shapes[2].shape.binding = { externalName: "Demo.Water.Pump01.Running" };
  shapes[2].shape.boolDisplay = {
    true: { text: "運転", color: "#16a34a" },
    false: { text: "停止", color: "#64748b" },
    unknownColor: "#d97706",
  };
  shapes[3].shape.binding = { externalName: TEMP_TAG };
  shapes[3].shape.alarmColor = { alarmId: PUMP_DEF };
  project.alarms.definitions.push({
    ...structuredClone(project.alarms.definitions[1]),
    id: SPARE_DEF,
    name: "X-03 予備",
    enabled: false,
  });
  mutate?.(project);
  return project;
}

async function open(page: Page, project: unknown) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "alarm-color.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
}
const pick = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`).click();
const colorForm = (page: Page) =>
  page.getByRole("form", { name: "警報の色", exact: true });
const select = (page: Page) =>
  colorForm(page).getByLabel("警報の定義", { exact: true });
const apply = (page: Page) =>
  colorForm(page).getByRole("button", {
    name: "警報の色を適用",
    exact: true,
  });
async function saved(page: Page, id: string) {
  const project = JSON.parse(
    (await downloadBytes(await downloadProject(page))).toString(),
  );
  return project.screens[0].objects.find((o: any) => o.id === id).shape
    .alarmColor;
}

test("sets, clears and undoes the alarm color of a tag-bound Text", async ({
  page,
}) => {
  await open(page, buildProject());
  await pick(page, PLAIN);
  await expect(colorForm(page)).toHaveCount(0);
  await pick(page, BOUND);
  await expect(select(page)).toHaveValue("");
  await select(page).selectOption(TEMP_DEF);
  await apply(page).click();
  await expect(select(page)).toHaveValue(TEMP_DEF);
  expect(await saved(page, BOUND)).toEqual({ alarmId: TEMP_DEF });

  await page.keyboard.press("Control+z");
  await expect(select(page)).toHaveValue("");
  expect(await saved(page, BOUND)).toBeUndefined();
  await page.keyboard.press("Control+y");
  await expect(select(page)).toHaveValue(TEMP_DEF);

  await select(page).selectOption("");
  await apply(page).click();
  expect(await saved(page, BOUND)).toBeUndefined();
});

test("lists the bound tag's definitions first and marks disabled ones", async ({
  page,
}) => {
  await open(page, buildProject());
  await pick(page, BOUND);
  const groups = await select(page).evaluate((element) =>
    [...(element as HTMLSelectElement).querySelectorAll("optgroup")].map(
      (group) => ({
        label: group.label,
        options: [...group.querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      }),
    ),
  );
  expect(groups).toEqual([
    { label: "このタグの警報", options: ["T-01 温度"] },
    { label: "ほかのタグの警報", options: ["P-01 停止", "X-03 予備（無効）"] },
  ]);
  // 無効の定義も選べる。
  await select(page).selectOption(SPARE_DEF);
  await apply(page).click();
  expect(await saved(page, BOUND)).toEqual({ alarmId: SPARE_DEF });
});

test("disables the select when the Project has no alarm definitions", async ({
  page,
}) => {
  await open(
    page,
    buildProject((project) => {
      project.screens[0].objects[textIndex(COLORED)].shape.alarmColor =
        undefined;
      delete project.alarms;
    }),
  );
  await pick(page, BOUND);
  await expect(select(page)).toBeDisabled();
  await expect(colorForm(page)).toContainText("警報の定義がありません");
});

test("alarm color and bool display exclude each other", async ({ page }) => {
  await open(page, buildProject());
  // boolDisplay の Text には警報の色のフォームを出さない。
  await pick(page, BOOL);
  await expect(colorForm(page)).toHaveCount(0);
  await expect(
    page.getByRole("form", { name: "bool の表示", exact: true }),
  ).toBeVisible();
  // alarmColor の Text は bool の表示を使えず、解除の案内を出す。解除すると使える。
  await pick(page, COLORED);
  await expect(
    page.getByRole("form", { name: "bool の表示", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "bool の表示", exact: true }),
  ).toContainText("警報の色を持つTextでは使えません");
  await expect(select(page)).toHaveValue(PUMP_DEF);
  await select(page).selectOption("");
  await apply(page).click();
  expect(await saved(page, COLORED)).toBeUndefined();
  await expect(
    page.getByRole("form", { name: "bool の表示", exact: true }),
  ).toBeVisible();
});

test("is not offered while editing a Symbol definition", async ({ page }) => {
  await open(page, buildProject());
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("button", { name: "定義を編集", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "画面へ戻る", exact: true }),
  ).toBeVisible();
  await selectPanel(page, "レイヤー");
  const layers = page.locator("button[data-layer-id]");
  const count = await layers.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    await layers.nth(index).click();
    await expect(colorForm(page)).toHaveCount(0);
  }
});
