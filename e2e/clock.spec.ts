import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileCommand, mainCanvas, selectPanel } from "./helpers/designer";

// 端末のローカル時刻で出すので、時刻帯と時刻を固定する。
test.use({ timezoneId: "Asia/Tokyo" });
const start = "2026-01-05T03:04:09+09:00";
// 時計は進み続けるので、挿入のあとに 03:10:08 で止め、1 秒進めて 03:10:09 から始める。以降は runFor で進めた分だけ変わる。
const paused = "2026-01-05T03:10:08+09:00";

async function insertClock(page: Page) {
  await page.clock.install({ time: new Date(start) });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", {
    name: "部品パレット",
    exact: true,
  });
  await palette.getByRole("searchbox", { name: "部品を検索" }).fill("時計");
  await palette
    .getByRole("button", { name: "時計を追加", exact: true })
    .click();
  await page.clock.pauseAt(new Date(paused));
  await advance(page, 1000);
}

/** 文字の配置は animation frame で決まるので、進めたあとに数フレーム回す。 */
async function advance(page: Page, ms: number) {
  await page.clock.runFor(ms);
  await page.clock.runFor(100);
}

const clockText = (page: Page) =>
  mainCanvas(page).locator("[data-object-id] text", {
    hasText: /^\d{4}\/\d{2}\/\d{2}|^\d{2}:\d{2}/,
  });

test("a clock is added from the palette, shows the fixed time and follows the format", async ({
  page,
}) => {
  await insertClock(page);
  const form = page.locator('form[data-editor-form="object"]');
  await expect(clockText(page).first()).toHaveText("2026/01/05 03:10");
  // 秒を出さない書式は分が変わるまで同じ。
  await advance(page, 1000);
  await expect(clockText(page).first()).toHaveText("2026/01/05 03:10");

  await form.getByLabel("時計の表示", { exact: true }).selectOption("date");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(clockText(page).first()).toHaveText("2026/01/05");

  await form.getByLabel("時計の表示", { exact: true }).selectOption("time");
  await form.getByLabel("時計の秒", { exact: true }).selectOption("on");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(clockText(page).first()).toHaveText("03:10:10");
  await advance(page, 1000);
  await expect(clockText(page).first()).toHaveText("03:10:11");
  await advance(page, 60_000);
  await expect(clockText(page).first()).toHaveText("03:11:11");

  await form.getByLabel("時計の表示", { exact: true }).selectOption("dateTime");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(clockText(page).first()).toHaveText("2026/01/05 03:11:11");
  await expect(page.locator(".error")).toHaveCount(0);

  // 文字を含むので反転できない。
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "左右反転", exact: true }),
  ).toBeDisabled();
});

test("a clock keeps ticking in the preview and saves only the chosen format", async ({
  page,
}) => {
  await insertClock(page);
  const form = page.locator('form[data-editor-form="object"]');
  await form.getByLabel("時計の秒", { exact: true }).selectOption("on");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(clockText(page).first()).toHaveText("2026/01/05 03:10:09");

  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(clockText(page).first()).toHaveText(/^2026\/01\/05 03:10:/);
  await advance(page, 2000);
  await expect(clockText(page).first()).toHaveText("2026/01/05 03:10:11");

  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const project = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  const placed = project.screens[0].objects.at(-1);
  expect(placed.shape).toEqual({
    type: "clock",
    format: "dateTime",
    seconds: true,
    style: { fontSize: 18, fontWeight: "normal", align: "left" },
  });
});
