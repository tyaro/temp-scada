import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";

// Only the test entry injects a service. The actual App, menu, Project lifetime,
// Modal and form remain production components.
const exampleRoot = `/@fs${process
  .cwd()
  .replaceAll("\\", "/")
  .replace(/^([A-Za-z]:)/, "/$1")}/examples`;
async function inject(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    const body = `
      const { createSubscriber } = await import("/node_modules/.vite/deps/svelte_reactivity.js");
      const { default: rawCases } = await import("${exampleRoot}/history-query-cases.json?import");
      const { default: minmaxCases } = await import("${exampleRoot}/history-minmax-cases.json?import");
      const { default: sample } = await import("${exampleRoot}/minimal.project.json?import");
      const { HistorySourceError } = await import("/src/lib/history/presentation.ts");
      let notify = () => {};
      const track = createSubscriber(update => {notify = update; return () => {};});
      const context = {version:1,kind:"historyContext",contextId:"context:1",
        projectId:sample.manifest.projectId,projectRevision:sample.manifest.projectRevision,
        series:[{seriesId:"bool",label:"状態"},{seriesId:"unknown",label:"旧系列"},{seriesId:"number",label:"温度"}]};
      const h = window.__historyHarness = {calls:[],active:0,maxActive:0};
      const source = {query(query,{signal}) {
        h.active++; h.maxActive = Math.max(h.maxActive,h.active);
        return new Promise((resolve,reject)=>h.calls.push({query,signal,
          resolve: value=>{h.active--;resolve(value);}, reject: error=>{h.active--;reject(error);}}));
      }};
      let service = {source,context};
      h.replace = (patch={}) => {service={source,context:{...structuredClone(context),...patch}};notify();};
      h.offline = () => {service=undefined;notify();};
      h.mutate = () => {context.series[0].label="MUTATED";};
      h.reply = (index,kind="raw",status="ready") => {
        const call=h.calls[index];
        const result=structuredClone((kind==="raw"?rawCases:minmaxCases)[0].expected);
        result.query=structuredClone(call.query);
        result.series=call.query.seriesIds.map(id=>result.series.find(row=>row.seriesId===id));
        result.status=status;
        if (status === "partial") result.series.find(row=>row.seriesId==="unknown").status="queryUnavailable";
        call.resolve(result);
      };
      h.fail = (index) => h.calls[index].reject(new HistorySourceError("tooManyPoints"));
      mount(App,{target:document.getElementById("app"),props:{get historyService(){track();return service;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, body) });
  });
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "履歴トレンド", exact: true });
const trend = (page: Page) => dialog(page).locator("[data-history-phase]");
async function open(page: Page) {
  const bar = page.getByRole("menubar", { name: "Designer メニューバー" });
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: "表示", exact: true }).click();
  else
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "履歴トレンド", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function form(page: Page, mode = "raw", all = false) {
  const root = dialog(page);
  for (const name of all
    ? ["状態 bool", "旧系列 unknown", "温度 number"]
    : ["温度 number"])
    await root.getByRole("checkbox", { name, exact: true }).check();
  await root
    .getByLabel("開始UTC", { exact: true })
    .fill(
      mode === "raw" ? "1970-01-01T00:00:00.500Z" : "1970-01-01T00:00:00.000Z",
    );
  await root
    .getByLabel("終了UTC", { exact: true })
    .fill(
      mode === "raw" ? "1970-01-01T00:00:02.000Z" : "1970-01-01T00:00:00.005Z",
    );
  await root.getByLabel("取得モード").selectOption(mode);
  await root.getByLabel("系列ごとの点数上限").fill(mode === "raw" ? "20" : "4");
}
async function load(page: Page) {
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
}
const calls = (page: Page) =>
  page.evaluate(() => (window as any).__historyHarness.calls.length);
const reply = (page: Page, index: number, kind = "raw", status = "ready") =>
  page.evaluate(
    ({ index, kind, status }) =>
      (window as any).__historyHarness.reply(index, kind, status),
    { index, kind, status },
  );
async function close(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  await expect(dialog(page)).toHaveCount(0);
}

test("normal entry explains offline, traps focus and restores it on Escape, including hidden menubar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".history-trend")).toHaveCount(0);
  await open(page);
  await expect(dialog(page)).toContainText("履歴サービスは未接続です");
  await expect(dialog(page)).toContainText("Hub に接続し、記録を開始");
  await expect(
    dialog(page).getByRole("button", { name: "取得", exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .focus();
  await page.keyboard.press("Tab");
  expect(
    await dialog(page).evaluate((node) =>
      node.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "表示", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "メニューバーを隠す", exact: true })
    .click();
  await open(page);
  await expect(dialog(page)).toContainText("履歴サービスは未接続です");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "メニュー", exact: true }),
  ).toBeFocused();
});

test("Project edits require renewed context and modal buttons isolate editor shortcuts", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("画面名", { exact: true }).fill("履歴確認の工程");
  await page
    .getByRole("button", { name: "画面設定を適用", exact: true })
    .click();
  const before = JSON.parse(
    (await downloadBytes(await downloadProject(page))).toString(),
  );
  await open(page);
  await expect(dialog(page)).toContainText("現在のProjectと一致しません");
  await page.evaluate(
    (revision) =>
      (window as any).__historyHarness.replace({ projectRevision: revision }),
    before.manifest.projectRevision,
  );
  await form(page);
  await load(page);
  await reply(page, 0);
  await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
  const acquire = dialog(page).getByRole("button", {
    name: "取得",
    exact: true,
  });
  await acquire.focus();
  for (const key of [
    "Control+a",
    "Control+d",
    "Control+g",
    "Control+z",
    "Control+y",
  ])
    await acquire.press(key);
  await expect(dialog(page)).toContainText("履歴系列一覧を確認しました");
  await close(page);
  const after = JSON.parse(
    (await downloadBytes(await downloadProject(page))).toString(),
  );
  expect(after).toEqual(before);
  expect(await calls(page)).toBe(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`actual App explicitly queries raw and minmax without changing Project in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await inject(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    const before = JSON.parse(
      (await downloadBytes(await downloadProject(page))).toString(),
    );
    await open(page);
    await expect(
      dialog(page).getByLabel("開始UTC", { exact: true }),
    ).toHaveValue("");
    await expect.poll(() => calls(page)).toBe(0);
    await form(page, "raw", true);
    await load(page);
    await expect.poll(() => calls(page)).toBe(1);
    await reply(page, 0);
    await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
    await expect(trend(page).locator("[data-history-point]")).toHaveCount(2);
    await trend(page).getByLabel("表示する履歴系列").selectOption("number");
    await expect(trend(page).locator("[data-history-point]")).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath(`history-app-${theme}.png`),
    });
    await dialog(page).getByLabel("取得モード").selectOption("minmax");
    await expect(trend(page)).toHaveAttribute("data-history-phase", "idle");
    await expect(trend(page).locator("svg")).toHaveCount(0);
    expect(await calls(page)).toBe(1);
    await form(page, "minmax", true);
    await load(page);
    await reply(page, 1, "minmax");
    await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
    await expect(trend(page).locator("[data-bin-state]")).toHaveCount(3);
    await trend(page).getByLabel("表示する履歴系列").selectOption("unknown");
    await expect(trend(page)).toContainText("系列が見つかりません");
    await close(page);
    const after = JSON.parse(
      (await downloadBytes(await downloadProject(page))).toString(),
    );
    expect(after).toEqual(before);
  });
}

test("service context is owned, mismatches and invalid or empty snapshots prevent querying", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await page.evaluate(() => (window as any).__historyHarness.mutate());
  await expect(
    dialog(page).getByRole("checkbox", { name: "状態 bool", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__historyHarness.replace({ projectRevision: 999 }),
  );
  await expect(dialog(page)).toContainText("現在のProjectと一致しません");
  await page.evaluate(() =>
    (window as any).__historyHarness.replace({
      series: [{ seriesId: "bad@id", label: "invalid" }],
    }),
  );
  await expect(dialog(page)).toContainText("履歴系列一覧を確認できません");
  await page.evaluate(() =>
    (window as any).__historyHarness.replace({ series: [] }),
  );
  await expect(dialog(page)).toContainText(
    "検索できる履歴系列が提供されていません",
  );
  await expect(
    dialog(page).getByRole("button", { name: "取得", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).__historyHarness.offline());
  await expect(dialog(page)).toContainText("履歴サービスは未接続です");
  expect(await calls(page)).toBe(0);
});

test("invalid edits clear results and cannot query; errors are safe and partial results remain explicit", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await form(page);
  await load(page);
  await reply(page, 0);
  await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
  await dialog(page)
    .getByLabel("終了UTC", { exact: true })
    .fill("2026-02-30T00:00:00.000Z");
  await expect(trend(page).locator("svg")).toHaveCount(0);
  await expect(
    dialog(page).getByRole("button", { name: "取得", exact: true }),
  ).toBeDisabled();
  await form(page);
  await load(page);
  await page.evaluate(() => (window as any).__historyHarness.fail(1));
  await expect(trend(page)).toContainText(
    "期間を短くするかmin/maxを選択してください",
  );
  await dialog(page)
    .getByRole("checkbox", { name: "旧系列 unknown", exact: true })
    .check();
  await load(page);
  await reply(page, 2, "raw", "partial");
  await expect(trend(page)).toHaveAttribute("data-history-phase", "partial");
  await expect(
    dialog(page).getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
});

test("close/reopen and service changes retain one physical slot and discard late results", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await form(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  for (let i = 0; i < 3; i++) {
    await close(page);
    await open(page);
    await form(page);
    await load(page);
    await expect(trend(page)).toContainText("前の読取の終了を待っています");
  }
  await page.evaluate(() => (window as any).__historyHarness.replace());
  await expect(trend(page)).toHaveAttribute("data-history-phase", "idle");
  await form(page);
  await load(page);
  expect(
    await page.evaluate(
      () => (window as any).__historyHarness.calls[0].signal.aborted,
    ),
  ).toBe(true);
  expect(await calls(page)).toBe(1);
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await expect(trend(page).locator("svg")).toHaveCount(0);
  await reply(page, 1);
  await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
  expect(
    await page.evaluate(() => (window as any).__historyHarness.maxActive),
  ).toBe(1);
  await page.evaluate(() => (window as any).__historyHarness.replace());
  await expect(trend(page).locator("svg")).toHaveCount(0);
  await expect(dialog(page).getByLabel("開始UTC", { exact: true })).toHaveValue(
    "",
  );
});

test("same-ID/revision Project replacement retires an active response", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await form(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await openProject(page, {
    name: "same-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await form(page);
  await load(page);
  await expect(trend(page)).toContainText("前の読取の終了を待っています");
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await expect(trend(page).locator("svg")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(trend(page)).toHaveAttribute("data-history-phase", "cancelled");
  await reply(page, 1);
  await expect(trend(page)).toHaveAttribute("data-history-phase", "cancelled");
});

test.describe("local time entry", () => {
  test.use({ timezoneId: "Asia/Tokyo" });
  test("local time inputs and recent buttons fill the UTC fields", async ({
    page,
  }) => {
    await inject(page);
    await page.goto("/");
    await open(page);
    const root = dialog(page);
    await expect(root).toContainText("UTC+09:00");
    await root.getByLabel("開始（ローカル時刻）").fill("2026-11-02T09:00");
    await root.getByLabel("終了（ローカル時刻）").fill("2026-11-02T09:30");
    await expect(root.getByLabel("開始UTC", { exact: true })).toHaveValue(
      "2026-11-02T00:00:00.000Z",
    );
    await expect(root.getByLabel("終了UTC", { exact: true })).toHaveValue(
      "2026-11-02T00:30:00.000Z",
    );
    await root.getByRole("button", { name: "直近10分", exact: true }).click();
    const from = Date.parse(
      await root.getByLabel("開始UTC", { exact: true }).inputValue(),
    );
    const to = Date.parse(
      await root.getByLabel("終了UTC", { exact: true }).inputValue(),
    );
    expect(to - from).toBe(600_000);
    await root.getByRole("button", { name: "直近1時間", exact: true }).click();
    const from2 = Date.parse(
      await root.getByLabel("開始UTC", { exact: true }).inputValue(),
    );
    expect(
      Date.parse(
        await root.getByLabel("終了UTC", { exact: true }).inputValue(),
      ) - from2,
    ).toBe(3_600_000);
  });
});
