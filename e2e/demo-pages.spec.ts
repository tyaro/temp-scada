import { test, expect, type Locator, type Page } from "@playwright/test";
import water from "../examples/demo-water.project.json" with { type: "json" };
import { chooseTheme, mainCanvas } from "./helpers/designer";

// GitHub Pages のデモ（トップページ・模擬値 feed・排水処理の Project）。
// 入口は製品の index.html とは別の pages/*.html で、開発サーバーが同じ origin で配る。
// `at` は模擬値の筋書きを止める秒（apps/banto-scada/src/demo/scenarios/water.scenario.json）。
const LANDING = "/pages/index.html";
const demo = (view: string, at?: number) =>
  `/pages/demo.html?demo=water&view=${view}${at === undefined ? "" : `&at=${at}`}`;

type Named = { id: string; name?: string };
const screenNamed = (name: string) =>
  water.screens.find((screen) => screen.name === name)!;
const objectId = (screen: string, name: string) =>
  (screenNamed(screen).objects as Named[]).find((row) => row.name === name)!.id;
const OVERVIEW = screenNamed("全体フロー").id;
const PUMPS = screenNamed("原水ポンプ場").id;
const LIST = screenNamed("計測一覧").id;

const operator = (page: Page) => page.getByRole("region", { name: "運転表示" });
const region = (page: Page, role: "header" | "main" | "footer") =>
  operator(page).locator(`[data-operator-region="${role}"]`);
const placed = (page: Page, screen: string, name: string) =>
  region(page, "main").locator(`[data-object-id="${objectId(screen, name)}"]`);
/** 図面の文字（SVG の text）。同じ文字を持つ title は数えない。 */
const shown = (scope: Locator, text: string | RegExp) =>
  scope.locator("text").filter({ hasText: text }).first();
const badge = (page: Page, screen: string, name: string) =>
  placed(page, screen, name).locator("[data-alarm-badge]");

test("the top page offers both entries of each subject and opens the operator view", async ({
  page,
}) => {
  await page.goto(LANDING);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Banto SCADA デモ",
  );
  await expect(page.locator(".badge")).toHaveText("デモ（模擬値）");
  const card = page.locator('[data-demo-subject="water"]');
  await expect(card.getByRole("heading")).toHaveText("排水処理設備");
  await expect(
    card.getByRole("link", { name: "編集モードで開く" }),
  ).toHaveAttribute("href", "./demo.html?demo=water&view=edit");
  await card.getByRole("link", { name: "運転表示で見る" }).click();
  await expect(page).toHaveURL(/demo\.html\?demo=water&view=operator$/);
  await expect(operator(page)).toHaveAttribute(
    "data-operator-screen",
    OVERVIEW,
  );
  await expect(page.locator("[data-demo-note]")).toContainText(
    "デモ（模擬値）",
  );
});

test("an unknown subject returns to the top page", async ({ page }) => {
  await page.goto("/pages/demo.html?demo=unknown");
  await expect(page).toHaveURL(/\/pages\/index\.html$/);
});

for (const theme of ["light", "dark"] as const)
  test(`the water demo follows its scenario in the editor and the operator view in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    // 70 秒: 2 台で送水中。液位は H（80 %）を越え、HH（90 %）の手前。pH は H を越える。
    await page.goto(demo("edit", 70));
    await chooseTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("[data-demo-status]").first()).toContainText(
      "デモ（模擬値）",
    );
    await expect(
      page.getByRole("button", { name: "編集", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const canvas = mainCanvas(page);
    const level = canvas.locator(
      `[data-object-id="${objectId("全体フロー", "T-101 原水槽 液位")}"] [data-level-state]`,
    );
    await expect(level).toHaveAttribute("data-level-state", "good");
    await expect(level.locator("[data-level-fill]")).toHaveCount(1);
    await expect(
      canvas.locator(
        `[data-object-id="${objectId("全体フロー", "警報の小札 H")}"] [data-alarm-badge]`,
      ),
    ).toHaveAttribute("data-alarm-state", "activeUnacked");
    await expect(shown(canvas, "88.7 %")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`water-edit-${theme}.png`) });

    // 運転表示: 枠（ヘッダー・フッター）、時計、最新の警報の帯、状態色、画面切替。
    await page.goto(demo("operator", 70));
    await expect(operator(page)).toHaveAttribute(
      "data-operator-screen",
      OVERVIEW,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(badge(page, "全体フロー", "警報の小札 H")).toHaveAttribute(
      "data-alarm-state",
      "activeUnacked",
    );
    await expect(badge(page, "全体フロー", "警報の小札 HH")).toHaveAttribute(
      "data-alarm-state",
      "normal",
    );
    await expect(
      region(page, "header").locator("[data-alarm-banner]"),
    ).toHaveAttribute("data-alarm-banner-kind", "alarm");
    await expect(
      shown(region(page, "header"), /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/),
    ).toBeVisible();
    await expect(
      shown(
        placed(page, "全体フロー", "P-102 原水ポンプ 2 号（予備）"),
        "運転",
      ),
    ).toBeVisible();
    await expect(
      shown(placed(page, "全体フロー", "送水の状態"), "送水中"),
    ).toBeVisible();
    await expect(region(page, "footer")).toContainText("デモ（模擬値）");
    await page.screenshot({
      path: info.outputPath(`water-overview-${theme}.png`),
    });

    // 110 秒: P-102 が故障（bit の警報）。詳細画面へ移って確かめる。
    await page.goto(demo("operator", 110));
    await region(page, "main")
      .getByRole("button", { name: "原水ポンプ場の詳細 ▶：原水ポンプ場へ移る" })
      .click();
    await expect(operator(page)).toHaveAttribute("data-operator-screen", PUMPS);
    await expect(
      badge(page, "原水ポンプ場", "警報の小札 故障"),
    ).toHaveAttribute("data-alarm-state", "activeUnacked");
    await expect(
      shown(
        placed(page, "原水ポンプ場", "P-102 原水ポンプ 2 号（予備）"),
        "故障",
      ),
    ).toBeVisible();
    await expect(
      shown(placed(page, "原水ポンプ場", "原水槽 液位（大）"), "60.0 %"),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`water-pumps-${theme}.png`),
    });

    // 150 秒: 液位が L（20 %）を下回り、P-101 が止まる。計測一覧の表と bit の文字。
    await page.goto(demo("operator", 150));
    await region(page, "header")
      .getByRole("button", { name: "計測一覧：計測一覧へ移る" })
      .click();
    await expect(operator(page)).toHaveAttribute("data-operator-screen", LIST);
    await expect(
      shown(placed(page, "計測一覧", "P-101 原水ポンプ 1 号 の状態"), "停止"),
    ).toBeVisible();
    await expect(
      shown(placed(page, "計測一覧", "計測値の表"), "0.0 m³/h"),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`water-list-${theme}.png`) });
    // アラーム一覧（ヘッダーの画面切替ボタンから）に、発生中の警報が出る。
    await region(page, "header")
      .getByRole("button", { name: /^アラーム一覧/ })
      .click();
    await expect(
      page.getByRole("dialog", { name: "アラーム一覧", exact: true }),
    ).toContainText("原水槽 液位 低");
  });

test("a trend card opens the history of the simulated values", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // 履歴は現在時刻までを作るので、筋書きを止めずに開く。
  await page.goto(demo("operator"));
  await region(page, "main")
    .getByRole("button", { name: "原水槽 液位・送水流量の履歴を開く" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "履歴トレンド",
    exact: true,
  });
  await dialog.getByRole("button", { name: "いまを終了にする" }).click();
  await dialog.getByRole("button", { name: "取得", exact: true }).click();
  await expect(dialog.locator("[data-history-phase]")).toHaveAttribute(
    "data-history-phase",
    "ready",
  );
});
