import { test, expect, type Page } from "@playwright/test";

// Issue #359: 共通部品 @banto-industrial/trend の TrendChart を、H1 の History の応答から
// 変換した区間（src/lib/history/trend-adapter.ts）で描けるかを確かめる。製品画面は使わない（/probes/trend.html）。

type Probe = {
  fetches: number;
  requests: { range: { startMs: number; endMs: number }; bins: number }[];
  range: { startMs: number; endMs: number };
  errors: string[];
  loaded: boolean;
  now: number;
};

const probe = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __trendProbe: Probe }).__trendProbe;
    return {
      fetches: p.fetches,
      requests: p.requests,
      range: p.range,
      errors: p.errors,
      loaded: p.loaded,
      now: p.now,
    };
  });

const plot = (page: Page) =>
  page
    .getByRole("img", { name: "実証のトレンド" })
    .or(page.locator('[aria-label="実証のトレンド"]'));

async function open(page: Page, theme: "light" | "dark") {
  const consoleErrors: string[] = [];
  page.on(
    "console",
    (m) => m.type() === "error" && consoleErrors.push(m.text()),
  );
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/probes/trend.html?theme=${theme}`);
  await expect
    .poll(async () => (await probe(page)).loaded, { timeout: 30_000 })
    .toBe(true);
  return consoleErrors;
}

for (const theme of ["light", "dark"] as const) {
  test(`draws H1 minmax bins with the shared TrendChart (${theme})`, async ({
    page,
  }) => {
    const consoleErrors = await open(page, theme);
    const state = await probe(page);
    expect(state.errors).toEqual([]);
    // 取得の区間の数は描画域の横幅から決まる（binCount）。
    const last = state.requests.at(-1)!;
    const box = (await plot(page).first().boundingBox())!;
    expect(last.bins).toBeGreaterThan(100);
    expect(last.bins).toBeLessThanOrEqual(Math.round(box.width));

    // 2 本のアナログの線（管理線の越えた区間の色替えの重ね描きを含む）と、bit の帯。
    const lines = page.locator("path.bi-trend__line");
    expect(await lines.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator("rect.bi-trend__bit-bg")).toHaveCount(1);
    await expect(page.locator("line.bi-trend__limit")).toHaveCount(1);
    await expect(page.locator(".bi-trend__legend-item")).toHaveCount(3);
    await expect(page.locator(".bi-trend__legend")).toContainText("流量");
    await expect(page.locator(".bi-trend__legend")).toContainText("ポンプ運転");

    // 欠測（gap の区間）で線が切れる: 流量の線は 2 つ以上の部分に分かれる。
    const d = (await lines.first().getAttribute("d")) ?? "";
    expect(d.match(/M/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    // 色はテーマのトークンで解決される（空や黒の既定に落ちない）。
    const colors = await page.evaluate(() => {
      const line = document.querySelector("path.bi-trend__line")!;
      const surface = document.querySelector(".bi-trend__plot")!;
      return {
        stroke: getComputedStyle(line).stroke,
        background: getComputedStyle(surface).backgroundColor,
      };
    });
    expect(colors.stroke).toMatch(/^rgb/);
    expect(colors.stroke).not.toBe("rgb(0, 0, 0)");
    const [r, g, b] = colors.background.match(/\d+/g)!.map(Number);
    const luminance = (r + g + b) / 3;
    if (theme === "dark") expect(luminance).toBeLessThan(100);
    else expect(luminance).toBeGreaterThan(150);

    expect(consoleErrors).toEqual([]);
  });
}

test("ctrl+wheel zooms the range and refetches through the adapter", async ({
  page,
}) => {
  await open(page, "light");
  const before = await probe(page);
  const box = (await plot(page).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => (await probe(page)).fetches)
    .toBeGreaterThan(before.fetches);
  await expect.poll(async () => (await probe(page)).loaded).toBe(true);
  const after = await probe(page);
  const width = (r: { startMs: number; endMs: number }) => r.endMs - r.startMs;
  expect(width(after.range)).toBeLessThan(width(before.range));
  expect(after.requests.at(-1)!.range).toEqual(after.range);
  expect(after.errors).toEqual([]);
});

async function ctrlWheel(page: Page, deltaY: number) {
  const box = (await plot(page).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

test("zooming out from the initial hour stays within the H1 query limit", async ({
  page,
}) => {
  await open(page, "light");
  const before = await probe(page);
  await ctrlWheel(page, 100);
  await expect
    .poll(async () => (await probe(page)).fetches)
    .toBeGreaterThan(before.fetches);
  await expect.poll(async () => (await probe(page)).loaded).toBe(true);
  const after = await probe(page);
  for (const request of after.requests)
    expect(request.range.endMs - request.range.startMs).toBeLessThanOrEqual(
      3_600_000,
    );
  expect(after.errors).toEqual([]);
});

test("repeated zoom-in with fractional spans keeps every bin inside the query", async ({
  page,
}) => {
  await open(page, "light");
  for (let i = 0; i < 8; i++) {
    const before = (await probe(page)).fetches;
    await ctrlWheel(page, -100);
    await expect
      .poll(async () => (await probe(page)).fetches)
      .toBeGreaterThan(before);
    await expect.poll(async () => (await probe(page)).loaded).toBe(true);
  }
  const state = await probe(page);
  // 1 秒で割り切れない幅（区間の数が小数になる場合）を実際に通したこと。
  expect(
    state.requests.some(
      (request) => (request.range.endMs - request.range.startMs) % 1000 !== 0,
    ),
  ).toBe(true);
  expect(state.errors).toEqual([]);
});
