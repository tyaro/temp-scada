import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/trend.project.json" with { type: "json" };
import { chooseTheme, mainCanvas, selectPanel } from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "トレンド定義・配置", exact: true });
const card = (page: Page) => mainCanvas(page).locator("[data-trend-card]");
const saved = async (page: Page) =>
  JSON.parse((await downloadBytes(await downloadProject(page))).toString());
async function open(page: Page) {
  const bar = page.getByRole("menubar");
  await bar.getByRole("menuitem", { name: "挿入", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "トレンド定義・配置", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function fill(page: Page, name = " 記録温度 ") {
  await dialog(page).getByLabel("トレンド名", { exact: true }).fill(name);
  await dialog(page)
    .getByLabel("履歴データ集合ID（namespace）")
    .fill("archive:test");
  await dialog(page)
    .getByLabel("系列ID 1", { exact: true })
    .fill("series:temperature");
  await dialog(page).getByLabel("凡例の別名 1", { exact: true }).fill(" 温度 ");
  await dialog(page).getByLabel("ペン色 1", { exact: true }).fill("#aB12Ef");
}
for (const theme of ["light", "dark"] as const)
  test(`Trend definition + placement is one Undo, preserves pens and round-trips in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await chooseTheme(page, theme);
    await open(page);
    await fill(page);
    await dialog(page)
      .getByRole("button", { name: "ペンを追加", exact: true })
      .click();
    await dialog(page)
      .getByLabel("系列ID 2", { exact: true })
      .fill("series:pressure");
    await dialog(page)
      .getByRole("button", { name: "ペン2を上へ", exact: true })
      .click();
    await dialog(page)
      .getByRole("button", { name: "保存して配置", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator("[data-trend-name]")).toHaveText(
      " 記録温度 ",
    );
    await expect(card(page)).toContainText("履歴トレンド");
    const before = await saved(page);
    expect(before.manifest.schemaVersion).toBe("0.36.0");
    expect(before.trends[0].pens.map((p: any) => p.seriesId)).toEqual([
      "series:pressure",
      "series:temperature",
    ]);
    expect(before.trends[0].pens[1]).toMatchObject({
      label: " 温度 ",
      color: "#aB12Ef",
    });
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(card(page)).toHaveCount(0);
    expect((await saved(page)).trends).toBeUndefined();
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    await expect(card(page)).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath(`project-trend-${theme}.png`),
    });
    const after = await saved(page);
    expect(after.trends).toEqual(before.trends);
    await openProject(page, {
      name: "trend-roundtrip.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(after)),
    });
    await expect(card(page)).toHaveCount(1);
    expect((await saved(page)).trends).toEqual(before.trends);
  });

test("invalid/dirty definition remains a draft, Escape is blocked and editor shortcuts cannot mutate behind Modal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const before = await saved(page);
  await open(page);
  await fill(page);
  await dialog(page)
    .getByRole("button", { name: "ペンを追加", exact: true })
    .click();
  await dialog(page)
    .getByLabel("系列ID 2", { exact: true })
    .fill("series:temperature");
  await expect(
    dialog(page).getByRole("button", { name: "定義を保存", exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .focus();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("未保存の入力があります");
  for (const key of ["Control+z", "Control+y", "Control+a"])
    await page.keyboard.press(key);
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  expect(await saved(page)).toEqual(before);
});

test("shared references update together, Inspector can make one independent and refuses clipboard cut", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "trend.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await selectPanel(page, "レイヤー");
  const id = sample.screens[0].objects[3].id;
  await page.locator(`button[data-layer-id="${id}"]`).click();
  await page.keyboard.press("Control+d");
  await expect(card(page)).toHaveCount(2);
  const initial = await saved(page);
  expect(initial.trends).toHaveLength(1);
  await page
    .getByRole("button", { name: "参照するトレンド定義を編集", exact: true })
    .click();
  await dialog(page).getByLabel("トレンド名", { exact: true }).fill("共有変更");
  await dialog(page)
    .getByRole("button", { name: "定義を保存", exact: true })
    .click();
  for (const item of await card(page).all())
    await expect(item.locator("[data-trend-name]")).toHaveText("共有変更");
  await page
    .getByRole("button", {
      name: "トレンド定義を複製してこの配置に適用",
      exact: true,
    })
    .click();
  const unique = await saved(page);
  expect(unique.trends).toHaveLength(2);
  expect(unique.trends[1].pens[0].id).not.toBe(unique.trends[0].pens[0].id);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "切り取り", exact: true }).click();
  await expect(page.getByTestId("project-status")).toContainText(
    "トレンドを含むコピー・切り取りは未対応",
  );
  expect((await saved(page)).screens[0].objects).toEqual(
    unique.screens[0].objects,
  );
  await page
    .getByLabel("参照するトレンド", { exact: true })
    .selectOption(sample.trends[0].id);
  await page.getByRole("button", { name: "変更を適用", exact: true }).click();
  expect((await saved(page)).screens[0].objects.at(-1).shape.trendId).toBe(
    sample.trends[0].id,
  );
  await page
    .getByRole("button", { name: "参照するトレンド定義を編集", exact: true })
    .click();
  await dialog(page)
    .getByLabel("編集するトレンド", { exact: true })
    .selectOption(unique.trends[1].id);
  await dialog(page)
    .getByRole("button", { name: "未使用定義を削除", exact: true })
    .click();
  expect((await saved(page)).trends).toHaveLength(1);
});

test("static card metadata reaches embedded, minimap and independent Popup without opening History", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    source = project.screens[0];
  project.screens.push({
    id: "0199f000-0000-7000-8000-000000000050",
    name: "トレンド一覧",
    width: 960,
    height: 540,
    background: "#ffffff",
    folders: [],
    groups: [],
    objects: [
      {
        id: "0199f000-0000-7000-8000-000000000051",
        order: 0,
        rotation: 0,
        x: 0,
        y: 0,
        width: 960,
        height: 540,
        shape: { type: "screenView", screenId: source.id, fit: "contain" },
      },
    ],
  });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/");
  await openProject(page, {
    name: "trend-views.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("navigation", { name: "画面タブ", exact: true })
    .getByRole("button", { name: "トレンド一覧", exact: true })
    .click();
  await expect(card(page).locator("[data-trend-name]")).toHaveText(
    sample.trends[0].name,
  );
  const minimap = page.locator('[aria-label="ミニマップ"]');
  await page.getByRole("button", { name: "編集", exact: true }).click();
  if (!(await minimap.isVisible())) {
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "表示", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "ミニマップを表示", exact: true })
      .click();
  }
  await expect(
    minimap.locator("[data-trend-card] [data-trend-name]"),
  ).toHaveText(sample.trends[0].name);
  await expect(
    minimap.getByRole("button", { name: /の履歴を開く/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(
    mainCanvas(page).getByRole("button", { name: /の履歴を開く/ }),
  ).toHaveCount(0);
  // Embedded screens are deliberately pointer-inert. Click their screen point.
  const bounds = (await card(page).boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(
    page.getByRole("dialog", { name: "履歴トレンド", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
    .click();
  const chooser = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await chooser.locator(`input[value="${source.id}"]`).check();
  await chooser
    .getByRole("button", { name: "小窓を表示", exact: true })
    .click();
  const popup = page.locator(`[data-preview-popup="${source.id}"]`);
  await expect(popup.locator("[data-trend-card] [data-trend-name]")).toHaveText(
    sample.trends[0].name,
  );
  await expect(
    page.getByRole("dialog", { name: "履歴トレンド", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await open(page);
  await dialog(page)
    .getByLabel("編集するトレンド", { exact: true })
    .selectOption(sample.trends[0].id);
  await dialog(page)
    .getByLabel("トレンド名", { exact: true })
    .fill("全投影の更新");
  await dialog(page)
    .getByRole("button", { name: "定義を保存", exact: true })
    .click();
  await expect(card(page).locator("[data-trend-name]")).toHaveText(
    "全投影の更新",
  );
  await expect(minimap.locator("[data-trend-name]")).toHaveText("全投影の更新");
  // The existing editor closes Popups when modes change. Reopen the source.
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
    .click();
  await chooser.locator(`input[value="${source.id}"]`).check();
  await chooser
    .getByRole("button", { name: "小窓を表示", exact: true })
    .click();
  await expect(popup.locator("[data-trend-name]")).toHaveText("全投影の更新");
});

test("Project replacement retires a pending Trend draft", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await open(page);
  await fill(page);
  await openProject(page, {
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(1);
  expect((await saved(page)).trends).toEqual(sample.trends);
});

test("only a visible interactive Trend changes preview semantics; static and edit screens remain images", async ({
  page,
}) => {
  await page.goto("/");
  await expect(mainCanvas(page)).toHaveAttribute("role", "img");
  await openProject(page, {
    name: "trend-accessibility.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(mainCanvas(page)).toHaveAttribute("role", "group");
  const action = mainCanvas(page).getByRole("button", {
    name: "工程温度の履歴を開く",
    exact: true,
  });
  await action.focus();
  await page.keyboard.press("Enter");
  const history = page.getByRole("dialog", {
    name: "履歴トレンド",
    exact: true,
  });
  await expect(history).toContainText("履歴サービスは未接続です");
  await history
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  await expect(action).toBeFocused();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(mainCanvas(page)).toHaveAttribute("role", "img");
  await expect(
    mainCanvas(page).getByRole("button", { name: /の履歴を開く/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const hidden = {
    ...sample,
    screens: sample.screens.map((screen) => ({
      ...screen,
      objects: screen.objects.map((object) =>
        object.shape.type === "trend" ? { ...object, visible: false } : object,
      ),
    })),
  };
  await openProject(page, {
    name: "hidden-trend.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(hidden)),
  });
  await expect(mainCanvas(page)).toHaveAttribute("role", "img");
  await expect(
    mainCanvas(page).getByRole("button", { name: /の履歴を開く/ }),
  ).toHaveCount(0);
});
