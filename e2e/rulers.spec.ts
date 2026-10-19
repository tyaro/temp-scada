import { test, expect, type Page } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";
const area = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
async function view(page: Page, name: string) {
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menu", { name: "表示", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
}
async function alignment(page: Page) {
  for (const axis of ["x", "y"] as const) {
    const delta = await page
      .getByTestId(`ruler-${axis}`)
      .evaluate((el, axis) => {
        const canvas = document.querySelector(
          '[aria-label="キャンバス操作領域"] .sheet > svg',
        ) as SVGSVGElement;
        const matrix = canvas.getScreenCTM()!;
        return [...el.querySelectorAll<SVGGElement>("g[data-value]")]
          .slice(0, 30)
          .map((tick) => {
            const v = Number(tick.dataset.value);
            const expected = new DOMPoint(
              axis === "x" ? v : 0,
              axis === "y" ? v : 0,
            ).matrixTransform(matrix);
            const actual = new DOMPoint(0, 0).matrixTransform(
              tick.getScreenCTM()!,
            );
            return Math.abs(actual[axis] - expected[axis]);
          });
      }, axis);
    expect(delta.length).toBeGreaterThan(0);
    expect(Math.max(...delta)).toBeLessThan(0.6);
  }
}
for (const zoom of ["0.25", "1", "4", "fit"]) {
  test(`rulers align with design coordinates at ${zoom} and after scrolling`, async ({
    page,
  }) => {
    await start(page);
    await page.getByLabel("表示倍率", { exact: true }).selectOption(zoom);
    await expect
      .poll(async () => {
        try {
          await alignment(page);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await area(page).evaluate((el) => {
      el.scrollLeft += 137;
      el.scrollTop += 83;
    });
    await expect
      .poll(async () => {
        try {
          await alignment(page);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
  });
}
test("ruler visibility preserves center, drafts and selection, persists, and stays hidden in preview", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("テキスト", { exact: true });
  const rulerBox = await page.getByTestId("ruler-x").boundingBox();
  const titleBox = await page
    .locator("main > section > .toolbar")
    .boundingBox();
  expect(titleBox!.y).toBeGreaterThanOrEqual(rulerBox!.y + rulerBox!.height);
  await input.fill("保持する未適用入力");
  const center = () =>
    svg(page).evaluate((el) => {
      const area = el.closest(
        '[aria-label="キャンバス操作領域"]',
      ) as HTMLElement;
      const box = area.getBoundingClientRect();
      const p = new DOMPoint(
        box.left + area.clientLeft + area.clientWidth / 2,
        box.top + area.clientTop + area.clientHeight / 2,
      ).matrixTransform((el as SVGSVGElement).getScreenCTM()!.inverse());
      return { x: p.x, y: p.y };
    });
  const before = await center();
  const box = await area(page).boundingBox();
  await view(page, "ルーラーを隠す");
  await expect(page.getByTestId("ruler-x")).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await center()).x - before.x))
    .toBeLessThan(1);
  await expect
    .poll(async () => Math.abs((await center()).y - before.y))
    .toBeLessThan(1);
  await expect(input).toHaveValue("保持する未適用入力");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  expect((await area(page).boundingBox())!.height).toBeCloseTo(
    box!.height + 22,
    0,
  );
  await view(page, "ルーラーを表示");
  await expect(page.getByTestId("ruler-x")).toBeVisible();
  await expect
    .poll(async () => {
      try {
        await alignment(page);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  await input.fill("BANTO / SCADA — Sample");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(page.getByTestId("ruler-x")).toHaveCount(0);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(page.getByTestId("ruler-x")).toBeVisible();
  await view(page, "ルーラーを隠す");
  await page.reload();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(page.getByTestId("ruler-x")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
for (const theme of ["light", "dark"]) {
  test(`rulers stay aligned through panel changes, narrow layout and CSS magnification in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
    await view(page, "左パネルを隠す");
    await expect
      .poll(async () => {
        try {
          await alignment(page);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
      .poll(async () => {
        try {
          await alignment(page);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.evaluate(() => (document.documentElement.style.zoom = "2"));
    await expect
      .poll(async () => {
        try {
          await alignment(page);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
  });
}
test("rulers follow shared definition dimensions and do not stamp a continuously armed part", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加", exact: true }).click();
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "定義を編集", exact: true }).click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  await expect
    .poll(async () => {
      try {
        await alignment(page);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
  await page
    .getByRole("button", { name: "連続配置ツール", exact: true })
    .click();
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  const before = await svg(page).locator("[data-object-id]").count();
  await page.getByTestId("ruler-x").click({ position: { x: 100, y: 10 } });
  await page.getByTestId("ruler-y").click({ position: { x: 10, y: 100 } });
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(before);
  await expect(page.getByTestId("selection-range")).toHaveCount(0);
});
test("unavailable preference storage keeps ruler toggles usable in the session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
  });
  await start(page);
  await view(page, "ルーラーを隠す");
  await expect(page.getByTestId("ruler-x")).toHaveCount(0);
  await expect(
    page.getByText(
      "ルーラーの設定を保存できません。このタブだけに適用します。",
      { exact: true },
    ),
  ).toBeVisible();
  await view(page, "ルーラーを表示");
  await expect(page.getByTestId("ruler-x")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});
