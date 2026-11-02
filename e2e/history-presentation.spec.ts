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
        `import HistoryFixture from "/src/lib/history/__fixtures__/HistoryPresentation.svelte"; mount(HistoryFixture,{target:document.getElementById("app")});`,
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
  test(`raw points preserve zero/false, nulls, unknown coverage and series in ${theme}`, async ({
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
    await expect(page.locator("[data-history-point]")).toHaveCount(2);
    await expect(
      page.locator('[data-history-point][data-value="0"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-history-point][data-value="1"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-history-null][data-null-reason="stale"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-coverage-reason="unknownCoverage"]'),
    ).toHaveCount(1);
    await page.getByLabel("表示する履歴系列").selectOption("number");
    await expect(
      page.locator('[data-history-null][data-null-reason="bad"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-history-point][data-value="0"]'),
    ).toHaveCount(1);
    await expect(
      page.locator(".history-trend path,.history-trend polyline"),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`history-${theme}.png`),
      fullPage: true,
    });
    await page.getByLabel("表示する履歴系列").selectOption("unknown");
    await expect(
      page.getByText("系列が見つかりません。未記録やゼロ値とは区別します。"),
    ).toBeVisible();
    await expect(page.locator("[data-history-point]")).toHaveCount(0);
  });
}

test("minmax keeps extrema/bool states, mixed bins have no bounds, expired remains explicit", async ({
  page,
}) => {
  await fixture(page);
  await load(page, "minmax");
  await reply(page);
  await expect(page.locator("[data-history-envelope]").first()).toBeVisible();
  await expect(page.locator("[data-history-point]")).toHaveCount(0);
  await expect(
    page.locator(".history-trend path,.history-trend polyline"),
  ).toHaveCount(0);
  await page.getByLabel("表示する履歴系列").selectOption("bool");
  expect(
    await page
      .locator("[data-history-envelope]")
      .evaluateAll((marks) =>
        marks.every((mark) =>
          ["0", "1"].includes(mark.getAttribute("data-value")!),
        ),
      ),
  ).toBe(true);
  await load(page, "mixed");
  await reply(page);
  await page.getByLabel("表示する履歴系列").selectOption("number");
  await expect(page.locator("[data-history-mixed]")).toBeVisible();
  await load(page, "expired");
  await reply(page);
  await expect(
    page.locator('[data-coverage-reason="expired"]').first(),
  ).toBeVisible();
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
  await expect(page.locator("[data-history-point]")).toHaveCount(0);
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

test("extreme finite values and out-of-Date epochs never produce invalid SVG geometry", async ({
  page,
}) => {
  await fixture(page);
  await load(page, "extreme");
  await reply(page);
  await expect(page.locator("[data-history-point]")).toHaveCount(2);
  await expect(page.locator(".history-trend .range")).toContainText("ms");
  const valid = await page
    .locator(".history-trend svg")
    .evaluateAll((svgs) =>
      svgs.every((svg) =>
        [...svg.querySelectorAll("*")].every((element) =>
          [...element.attributes].every((a) => !/NaN|Infinity/.test(a.value)),
        ),
      ),
    );
  expect(valid).toBe(true);
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
