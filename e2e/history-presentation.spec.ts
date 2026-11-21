import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    await route.fulfill({
      response,
      body: original.replace(
        mount,
        `const { default: HistoryFixture } = await import("/src/lib/history/__fixtures__/HistoryPresentation.svelte"); mount(HistoryFixture,{target:document.getElementById("app")});`,
      ),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "履歴表示のローカル受入" }),
  ).toBeVisible();
}
async function load(page: Page, scenario = "raw") {
  await page.getByLabel("応答ケース").selectOption(scenario);
  await page.getByRole("button", { name: "取得", exact: true }).click();
}
async function reply(page: Page) {
  await page.getByRole("button", { name: "応答", exact: true }).click();
  await expect(page.locator("[data-history-phase]")).toHaveAttribute(
    "data-history-phase",
    "ready",
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`raw points are shown as markers with a legend and unknown series stays explicit in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280, height: 960 });
    await fixture(page);
    await page
      .getByRole("button", {
        name: theme === "light" ? "ライト" : "ダーク",
        exact: true,
      })
      .click();
    await load(page);
    await reply(page);
    const chart = page.getByLabel("履歴トレンドのグラフ");
    await expect(chart).toBeVisible();
    await expect(page.locator(".history-trend .mode")).toHaveText(
      "観測点を表示します。点の間は結びません。",
    );
    // raw は線を描かず、点だけを描く。
    await expect(chart.locator("path.bi-trend__marker").first()).toBeVisible();
    await expect(chart.locator("path.bi-trend__line")).toHaveCount(0);
    await expect(
      page
        .getByLabel("履歴トレンドの凡例")
        .locator("[data-history-legend-series]")
        .first(),
    ).toContainText("系列ID: ");
    // 取得できない系列は 0 や未記録と区別して明示する。
    await expect(
      page.getByText("系列が見つかりません。未記録やゼロ値とは区別します。"),
    ).toBeVisible();
    const geometry = await chart
      .locator("path.bi-trend__marker")
      .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
    expect(geometry.every((d) => d && !/NaN|Infinity/.test(d))).toBe(true);
    // 色は部品の枠の変数で、別のテーマ定義でも属性は変わらない。
    const colors = await chart
      .locator("path.bi-trend__marker")
      .evaluateAll((paths) =>
        paths.map(
          (path) => path.getAttribute("stroke") ?? path.getAttribute("fill"),
        ),
      );
    expect(colors.every((c) => c?.startsWith("var(--banto-chart-"))).toBe(true);
    await page.screenshot({
      path: info.outputPath(`history-${theme}.png`),
      fullPage: true,
    });
  });
}

test("minmax draws envelope lines, mixed bins are reported and expired still renders", async ({
  page,
}) => {
  await fixture(page);
  await load(page, "minmax");
  await reply(page);
  await expect(page.locator(".history-trend .mode")).toContainText(
    "区間ごとの最小・最大を縦の線で示し",
  );
  const chart = page.getByLabel("履歴トレンドのグラフ");
  await expect(chart.locator("path.bi-trend__line").first()).toBeVisible();
  await expect(chart.locator("path.bi-trend__marker")).toHaveCount(0);
  await load(page, "mixed");
  await reply(page);
  await expect(page.locator("[data-history-mixed]")).toBeVisible();
  await load(page, "expired");
  await reply(page);
  await expect(page.locator(".history-trend")).toContainText(
    "記録範囲・品質・系列の切れ目はまだ表示しません。",
  );
});

test("controller clears graphs, waits for retired reads and rejects wrong replies", async ({
  page,
}) => {
  await fixture(page);
  await load(page);
  await load(page);
  await load(page);
  await expect(page.locator("[data-fixture-count]")).toHaveText(
    "source呼出 1件",
  );
  await expect(page.getByRole("status")).toHaveText(
    "前の読取の終了を待っています",
  );
  await page.getByRole("button", { name: "応答", exact: true }).click();
  await expect(page.locator("[data-fixture-count]")).toHaveText(
    "source呼出 2件",
  );
  await page.getByRole("button", { name: "不正応答", exact: true }).click();
  await expect(page.locator("[data-history-phase]")).toHaveAttribute(
    "data-history-phase",
    "invalid",
  );
  await expect(page.locator(".history-trend .bi-trend__plot")).toHaveCount(0);
  await load(page);
  await page.getByRole("button", { name: "点数超過", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("点数が上限");
  await load(page);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "応答", exact: true }).click();
  await expect(page.locator("[data-history-phase]")).toHaveAttribute(
    "data-history-phase",
    "cancelled",
  );
  await page.getByRole("button", { name: "切断", exact: true }).click();
  await expect(page.locator("[data-history-phase]")).toHaveAttribute(
    "data-history-phase",
    "offline",
  );
});

test("extreme finite values and out-of-Date epochs never produce invalid path geometry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  await load(page, "extreme");
  await reply(page);
  await expect(page.locator(".history-trend .range")).toContainText("ms");
  const chart = page.getByLabel("履歴トレンドのグラフ");
  await expect(chart).toBeVisible();
  const valid = await chart
    .locator("svg")
    .evaluateAll((svgs) =>
      svgs.every((svg) =>
        [...svg.querySelectorAll("*")].every((element) =>
          [...element.attributes].every((a) => !/NaN|Infinity/.test(a.value)),
        ),
      ),
    );
  expect(valid).toBe(true);
  expect(errors).toEqual([]);
});

test("normal App has no fixture or automatic History source", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "表示プレビュー", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "履歴表示のローカル受入" }),
  ).toHaveCount(0);
  await expect(page.locator(".history-trend")).toHaveCount(0);
});
