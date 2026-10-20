import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
import grouped from "../examples/geometric-groups.project.json" with { type: "json" };
import processSample from "../examples/process.project.json" with { type: "json" };
import { chooseTheme, selectPanel, mainCanvas } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const members = sample.screens[0].objects
  .slice(0, 2)
  .map((object) => object.id);
const groupRow = (page: Page) => page.locator("button[data-layer-group]");
async function start(page: Page, project: any = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "groups.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await expect(mainCanvas(page).locator("[data-object-id]")).toHaveCount(
    project.screens[0].objects.length,
  );
  if (project.screens[0].groups.length)
    await expect(groupRow(page)).toHaveCount(project.screens[0].groups.length);
}
async function saved(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}
async function create(page: Page) {
  await row(page, members[0]).click();
  await row(page, members[1]).click({ modifiers: ["Shift"] });
  await button(page, "グループ化").click();
  await expect(groupRow(page)).toHaveCount(1);
}
for (const theme of ["light", "dark"] as const)
  test(`create, rename, move, rotate and ungroup with one-step Undo in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await create(page);
    await expect(page.getByLabel("グループ名", { exact: true })).toBeVisible();
    await expect(page.getByLabel("x", { exact: true })).toHaveCount(0);
    await page
      .getByLabel("グループ名", { exact: true })
      .fill(" 原水ポンプユニット ");
    await button(page, "グループ名を適用").click();
    await expect(groupRow(page)).toHaveText("原水ポンプユニット · 2 配置");
    await expect(page.getByLabel("グループ名", { exact: true })).toHaveValue(
      "原水ポンプユニット",
    );
    await page.getByLabel("移動量 X", { exact: true }).fill("20");
    await page.getByLabel("移動量 Y", { exact: true }).fill("-10");
    await button(page, "まとめて移動").click();
    const moved = await saved(page);
    members.forEach((id, index) => {
      const object = moved.screens[0].objects.find(
        (item: any) => item.id === id,
      );
      expect(object.x).toBe(sample.screens[0].objects[index].x + 20);
      expect(object.y).toBe(sample.screens[0].objects[index].y - 10);
    });
    await button(page, "右へ90°回転").click();
    const rotated = await saved(page);
    expect(
      rotated.screens[0].objects
        .slice(0, 2)
        .map((object: any) => object.rotation),
    ).toEqual([90, 90]);
    await groupRow(page).click();
    await page.keyboard.press("Control+z");
    expect((await saved(page)).screens[0].objects).toEqual(
      moved.screens[0].objects,
    );
    await groupRow(page).click();
    await page.keyboard.press("Control+Shift+g");
    await expect(groupRow(page)).toHaveCount(0);
    await expect(row(page, members[0])).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, members[1])).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+z");
    await expect(groupRow(page)).toHaveCount(1);
  });
test("keyboard grouping respects text input and dirty group-name cancellation", async ({
  page,
}) => {
  await start(page);
  await row(page, members[0]).click();
  await row(page, members[1]).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+g");
  await expect(groupRow(page)).toHaveCount(1);
  const input = page.getByLabel("グループ名", { exact: true });
  await input.fill("未適用の名前");
  await input.press("Control+Shift+g");
  await expect(groupRow(page)).toHaveCount(1);
  await groupRow(page).click({ button: "right" });
  // Selection is unchanged; choosing an operation must still protect the form.
  await page
    .getByRole("menuitem", { name: "グループ解除", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(input).toHaveValue("未適用の名前");
  await expect(groupRow(page)).toHaveCount(1);
});
test("layer and canvas select whole units; mixed lock is excluded from Ctrl+A and can be unlocked", async ({
  page,
}) => {
  const fixture = structuredClone(grouped) as any;
  fixture.screens[0].objects[1].locked = true;
  await start(page, fixture);
  await groupRow(page).click();
  await expect(button(page, "グループ解除")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /一部ロック・解除/ }),
  ).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(groupRow(page)).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, sample.screens[0].objects[2].id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /一部ロック・解除/ }).click();
  await groupRow(page).click();
  await expect(button(page, "グループ解除")).toBeEnabled();
  await mainCanvas(page).locator(`[data-object-id="${members[1]}"]`).click();
  await expect(mainCanvas(page).locator('[data-selected="true"]')).toHaveCount(
    2,
  );
});
test("search routes child names to one group row; context order changes preserve block membership", async ({
  page,
}) => {
  await start(page, grouped);
  await page.getByLabel("レイヤーを検索", { exact: true }).fill("ellipse");
  await expect(groupRow(page)).toHaveCount(1);
  await expect(groupRow(page)).toContainText("タンク設備");
  await groupRow(page).click();
  await groupRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "最前面へ", exact: true }).click();
  const data = await saved(page);
  expect(data.screens[0].groups[0].memberIds).toEqual(members);
  expect(
    [...data.screens[0].objects]
      .sort((a: any, b: any) => a.order - b.order)
      .slice(-2)
      .map((object: any) => object.id),
  ).toEqual(members);
});
test("refuses non-consecutive grouping without changing geometry or membership", async ({
  page,
}) => {
  await start(page);
  await row(page, members[0]).click();
  await row(page, sample.screens[0].objects[2].id).click({
    modifiers: ["Shift"],
  });
  await button(page, "グループ化").click();
  await expect(page.getByTestId("project-status")).toContainText("連続");
  const data = await saved(page);
  expect(data.screens[0].groups).toEqual([]);
  expect(data.screens[0].objects).toEqual(sample.screens[0].objects);
});
test("drag and keyboard move both members once; the group exposes no child resize handles", async ({
  page,
}) => {
  await start(page, grouped);
  const object = mainCanvas(page).locator(`[data-object-id="${members[1]}"]`);
  await object.click();
  await expect(mainCanvas(page).locator('[data-selected="true"]')).toHaveCount(
    2,
  );
  await expect(mainCanvas(page).locator("[data-resize-handle]")).toHaveCount(0);
  const box = (await object.boundingBox())!;
  const scale = await mainCanvas(page).evaluate(
    (svg) => (svg as SVGSVGElement).getScreenCTM()!.a,
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 40 * scale,
    box.y + box.height / 2 + 20 * scale,
    { steps: 5 },
  );
  await page.mouse.up();
  const data = await saved(page);
  members.forEach((id, index) => {
    const moved = data.screens[0].objects.find((entry: any) => entry.id === id);
    expect(moved.x).toBe(sample.screens[0].objects[index].x + 40);
    expect(moved.y).toBe(sample.screens[0].objects[index].y + 20);
  });
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const nudged = await saved(page);
  expect(nudged.screens[0].objects[0].x).toBeGreaterThan(
    data.screens[0].objects[0].x,
  );
  expect(nudged.screens[0].objects[0].x - data.screens[0].objects[0].x).toBe(
    nudged.screens[0].objects[1].x - data.screens[0].objects[1].x,
  );
  await groupRow(page).click();
  await page.keyboard.press("Control+z");
  expect((await saved(page)).screens[0].objects).toEqual(
    data.screens[0].objects,
  );
});
test("F2 edits the group and Undo refreshes the committed draft name", async ({
  page,
}) => {
  await start(page, grouped);
  await groupRow(page).click();
  await page.keyboard.press("F2");
  const input = page.getByLabel("グループ名", { exact: true });
  await expect(input).toBeFocused();
  await expect(mainCanvas(page).locator('[data-selected="true"]')).toHaveCount(
    2,
  );
  await expect(page.getByLabel("x", { exact: true })).toHaveCount(0);
  await input.fill("前回の確定名");
  await input.press("Enter");
  await expect(groupRow(page)).toContainText("前回の確定名");
  await groupRow(page).click();
  await page.keyboard.press("Control+z");
  await expect(input).toHaveValue("タンク設備");
  await input.fill("前回の確定名");
  await row(page, sample.screens[0].objects[2].id).click();
  const prompt = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(input).toHaveValue("前回の確定名");
  await expect(groupRow(page)).toHaveAttribute("aria-pressed", "true");
});
test("IME confirmation cannot submit the group name; hiding clears the unit selection", async ({
  page,
}) => {
  await start(page, grouped);
  await groupRow(page).click();
  const input = page.getByLabel("グループ名", { exact: true });
  await input.focus();
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    field.value = "変換中";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await input.press("Enter");
  await expect(groupRow(page)).toContainText("タンク設備");
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect(groupRow(page)).toContainText("変換中");
  await page
    .getByRole("button", { name: "非表示：変換中 · 2 配置", exact: true })
    .click();
  await expect(groupRow(page)).toHaveAttribute("aria-pressed", "false");
  await expect(mainCanvas(page).locator("[data-object-id]")).toHaveCount(1);
  await page
    .getByRole("button", { name: "再表示：変換中 · 2 配置", exact: true })
    .click();
  await expect(mainCanvas(page).locator("[data-object-id]")).toHaveCount(3);
});
test("jumping to a grouped Symbol usage retains the complete unit and reveals the member", async ({
  page,
}) => {
  const fixture: any = structuredClone(processSample),
    screen = fixture.screens[0];
  screen.groups = [
    {
      id: "0199f500-0000-7000-8000-000000000001",
      name: "設備全体",
      memberIds: [...screen.objects]
        .sort((a: any, b: any) => a.order - b.order)
        .map((object: any) => object.id),
    },
  ];
  await start(page, fixture);
  await selectPanel(page, "プロジェクト");
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  const name = fixture.symbols[0].name;
  await button(page, `共有定義：${name}`).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "使用先を確認", exact: true })
    .click();
  const usages = page.getByRole("region", {
    name: "共有定義の使用先",
    exact: true,
  });
  await usages
    .getByRole("button", { name: /を表示$/ })
    .first()
    .click();
  await expect(mainCanvas(page).locator('[data-selected="true"]')).toHaveCount(
    screen.objects.length,
  );
  const symbol = screen.objects.find(
    (object: any) =>
      object.shape.type === "symbol" &&
      object.shape.symbolId === fixture.symbols[0].id,
  );
  await expect(
    mainCanvas(page).locator(`[data-object-id="${symbol.id}"]`),
  ).toBeInViewport({ ratio: 0.1 });
});
