import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { fileCommand, mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

const main = sample.screens[0].id;
const common = sample.screens[1].id;
const toCommon = "0199f6ab-0000-7000-8000-000000000901";
const toSelf = "0199f6ab-0000-7000-8000-000000000902";
const back = "0199f6ab-0000-7000-8000-000000000903";
const toMain = "0199f6ab-0000-7000-8000-000000000904";

function button(
  id: string,
  order: number,
  x: number,
  y: number,
  label: string,
  target: object,
) {
  return {
    id,
    order,
    x,
    y,
    width: 120,
    height: 40,
    rotation: 0,
    shape: {
      type: "navButton",
      target,
      label,
      fontSize: 16,
      fill: "#334155",
      textColor: "#f8fafc",
      currentFill: "#0ea5e9",
      currentTextColor: "#0f172a",
    },
  };
}
function navProject() {
  const project = structuredClone(sample) as any;
  project.screens[0].objects.push(
    button(toCommon, 900, 20, 840, "共通へ", {
      kind: "screen",
      screenId: common,
    }),
    button(toSelf, 901, 160, 840, "読取", { kind: "screen", screenId: main }),
    button(back, 902, 300, 840, "戻る", { kind: "back" }),
  );
  project.screens[1].objects.push(
    button(toMain, 900, 820, 190, "読取へ", { kind: "screen", screenId: main }),
  );
  return project;
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await openProject(page, {
    name: "nav-button.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(navProject())),
  });
}
const tab = (page: Page, id: string) =>
  page.locator(`[data-screen-tab="${id}"]`);
const painted = (page: Page, id: string) =>
  mainCanvas(page).locator(`[data-object-id="${id}"] [data-nav-button]`);

test("the preview moves to the target screen and highlights the current one", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(tab(page, main)).toHaveAttribute("aria-current", "page");

  // The button to the shown screen uses the current colors; the others do not.
  await expect(painted(page, toSelf)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
  await expect(
    painted(page, toSelf).locator("[data-nav-fill]"),
  ).toHaveAttribute("fill", "#0ea5e9");
  await expect(painted(page, toCommon)).not.toHaveAttribute("data-nav-current");
  await expect(
    painted(page, toCommon).locator("[data-nav-fill]"),
  ).toHaveAttribute("fill", "#334155");
  // Back has no history in the preview: faded and not a button.
  await expect(painted(page, back)).toHaveAttribute(
    "data-nav-disabled",
    "true",
  );
  await expect(
    mainCanvas(page).locator(`[data-object-id="${back}"]`),
  ).not.toHaveAttribute("role", "button");

  const link = mainCanvas(page).getByRole("button", {
    name: "共通へ：読取共通画面へ移る",
  });
  await link.click();
  await expect(tab(page, common)).toHaveAttribute("aria-current", "page");
  await expect(mainCanvas(page)).toHaveAttribute("aria-label", "読取共通画面");

  // Enter on the focused button moves back.
  const home = mainCanvas(page).locator(`[data-object-id="${toMain}"]`);
  await home.focus();
  await page.keyboard.press("Enter");
  await expect(tab(page, main)).toHaveAttribute("aria-current", "page");
  await expect(painted(page, toSelf)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
});

test("editing selects a nav button without moving and edits its target", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const placed = mainCanvas(page).locator(`[data-object-id="${toCommon}"]`);
  await expect(placed).not.toHaveAttribute("role", "button");
  await placed.click();
  await expect(placed).toHaveAttribute("data-selected", "true");
  await expect(tab(page, main)).toHaveAttribute("aria-current", "page");
  // Editing shows the current-screen color too.
  await expect(painted(page, toSelf)).toHaveAttribute(
    "data-nav-current",
    "true",
  );

  const form = page.locator('form[data-editor-form="object"]');
  const target = form.getByLabel("画面切替ボタンの行き先", { exact: true });
  await expect(target).toHaveValue(`screen:${common}`);
  await expect(form.getByLabel("ボタンの文字", { exact: true })).toHaveValue(
    "共通へ",
  );
  await target.selectOption(`screen:${main}`);
  await form.getByLabel("ボタンの文字", { exact: true }).fill("読取へ戻る");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(painted(page, toCommon)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
  await expect(painted(page, toCommon).locator("[data-nav-label]")).toHaveText(
    "読取へ戻る",
  );

  // The layer shows the kind name.
  await selectPanel(page, "レイヤー");
  await expect(page.locator(`button[data-layer-id="${back}"]`)).toContainText(
    "画面切替",
  );
});

test("a nav button is added from the part palette without a target", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", {
    name: "部品パレット",
    exact: true,
  });
  await palette.getByRole("searchbox", { name: "部品を検索" }).fill("遷移");
  await palette
    .getByRole("button", { name: "画面切替ボタンを追加", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const project = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  const placed = project.screens[0].objects.at(-1);
  expect(placed.shape).toMatchObject({ type: "navButton", label: "画面切替" });
  expect(placed.shape.target).toBeUndefined();
  expect(placed.fill).toBeUndefined();
});
