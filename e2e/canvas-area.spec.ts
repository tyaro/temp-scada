import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
import sample from "../examples/tag-binding.project.json" with { type: "json" };

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "references.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await button(page, "編集").click();
  await expect(viewport(page)).toBeVisible();
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
}

for (const [width, height, minimum] of [
  [1280, 800, 520],
  [1440, 900, 640],
] as const) {
  test(`overlays the dock and minimap on the canvas at ${width}x${height}`, async ({
    page,
  }) => {
    await open(page, width, height);
    const canvas = (await viewport(page).boundingBox())!;
    const dock = await box(page, ".favorites-dock");
    const map = await box(page, ".canvas-navigation .minimap");
    const status = await box(page, ".status-row");
    test.info().annotations.push({
      type: "canvas",
      description: `${width}x${height}: ${Math.round(canvas.width)}x${Math.round(canvas.height)}`,
    });
    // 専用帯がなくなり、ドックとミニマップは図面の内側に重なる。
    expect(canvas.height).toBeGreaterThanOrEqual(minimum);
    for (const item of [dock, map]) {
      expect(item.y).toBeGreaterThanOrEqual(canvas.y);
      expect(item.y + item.height).toBeLessThanOrEqual(
        canvas.y + canvas.height,
      );
    }
    expect(Math.abs(status.y - (canvas.y + canvas.height))).toBeLessThan(2);
    // タグ参照の見出しは帯を取らず、ステータス行のボタンになる。
    await expect(
      page.locator("summary", { hasText: "タグ参照 ·" }),
    ).toHaveCount(0);
    const toggle = page.locator(".references-toggle");
    await expect(toggle).toHaveText(/タグ参照 1/);

    // ドックとミニマップの間の空きは図面へ素通しになる。
    const gap = {
      x: (dock.x + dock.width + map.x) / 2,
      y: map.y + map.height / 2,
    };
    if (gap.x > dock.x + dock.width + 4 && gap.x < map.x - 4) {
      const target = await page.evaluate(
        ({ x, y }) =>
          !!document
            .elementFromPoint(x, y)
            ?.closest('[aria-label="キャンバス操作領域"]'),
        gap,
      );
      expect(target).toBe(true);
    }
  });
}

test("the overlaid dock and minimap stay usable and do not block canvas wheel", async ({
  page,
}) => {
  await open(page, 1440, 900);
  const scroll = () =>
    viewport(page).evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  const map = button(page, "ミニマップで表示位置を移動");
  await map.click({ position: { x: 10, y: 10 } });
  const before = await scroll();
  await map.click({ position: { x: 100, y: 60 } });
  await expect.poll(scroll).not.toEqual(before);
  // ドックの左の空き（図面の上）でホイールすると図面がスクロールする。
  const dock = await box(page, ".favorites-dock");
  const canvas = (await viewport(page).boundingBox())!;
  const moved = await scroll();
  await page.mouse.move(
    canvas.x + Math.max(40, (dock.x - canvas.x) / 2),
    dock.y + dock.height / 2,
  );
  await page.mouse.wheel(0, -200);
  await expect.poll(scroll).not.toEqual(moved);
  // ドックの部品は押せる（連続配置の準備になる）。
  await expect(
    page.locator(".favorites-dock").getByRole("button").first(),
  ).toBeEnabled();
});

test("the status row button opens and closes the tag reference panel", async ({
  page,
}) => {
  await open(page, 1440, 900);
  const toggle = page.getByRole("button", {
    name: /^Project のタグ参照 · 1 タグ \/ \d+ 配置$/,
  });
  const panel = page.getByRole("region", {
    name: "Project のタグ参照",
    exact: true,
  });
  const closed = (await viewport(page).boundingBox())!.height;
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  const opened = (await viewport(page).boundingBox())!.height;
  expect(closed - opened).toBeGreaterThan(150);
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect
    .poll(async () => (await viewport(page).boundingBox())!.height)
    .toBeCloseTo(closed, 0);
});

test("adds a screen from the tab plus, the tree heading and the screen menu", async ({
  page,
}) => {
  await open(page, 1440, 900);
  const tabs = page.getByRole("navigation", { name: "画面タブ" });
  const tab = tabs.locator("[data-screen-tab]");
  const count = await tab.count();
  await tabs
    .getByRole("button", { name: "画面を追加（画面タブ）", exact: true })
    .click();
  await expect(tab).toHaveCount(count + 1);
  await expect(tab.last()).toHaveAttribute("aria-current", "page");
  await expect(tab.last()).toHaveText(`画面 ${count + 1}`);

  const sidebar = page.locator(".project-sidebar");
  await sidebar
    .getByRole("button", { name: "画面を追加（画面一覧）", exact: true })
    .first()
    .click();
  await expect(tab).toHaveCount(count + 2);
  const row = sidebar.locator(".screen-row").last();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeInViewport();

  await tab.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "画面を追加", exact: true }).click();
  await expect(tab).toHaveCount(count + 3);
  await expect(tab.last()).toHaveAttribute("aria-current", "page");
});

test("adding a screen while editing a Symbol definition leaves the definition", async ({
  page,
}) => {
  await open(page, 1440, 900);
  await selectPanel(page, "部品");
  await button(page, "ポンプを追加").click();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").first().click();
  await expect(button(page, "画面へ戻る")).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "画面タブ" });
  const tab = tabs.locator("[data-screen-tab]");
  const count = await tab.count();
  await tabs
    .getByRole("button", { name: "画面を追加（画面タブ）", exact: true })
    .click();
  await expect(button(page, "画面へ戻る")).toHaveCount(0);
  await expect(tab).toHaveCount(count + 1);
  await expect(tab.last()).toHaveAttribute("aria-current", "page");
});

test("edit and preview keep the canvas top and height close (L-4)", async ({
  page,
}) => {
  await open(page, 1920, 1080);
  const edit = (await viewport(page).boundingBox())!;
  await button(page, "表示プレビュー").click();
  await expect(viewport(page)).toBeVisible();
  await expect
    .poll(async () => (await viewport(page).boundingBox())!.height)
    .not.toBe(0);
  const preview = (await viewport(page).boundingBox())!;
  test.info().annotations.push({
    type: "edit-preview",
    description: `edit ${Math.round(edit.y)}/${Math.round(edit.height)} preview ${Math.round(preview.y)}/${Math.round(preview.height)}`,
  });
  // 下の帯がなくなったので、往復での高さの差はルーラーと読取状態の行の分に収まる。
  expect(Math.abs(preview.height - edit.height)).toBeLessThan(80);
});
