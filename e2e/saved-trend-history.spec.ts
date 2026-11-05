import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/trend.project.json" with { type: "json" };
import { chooseTheme, mainCanvas } from "./helpers/designer";
import {
  openProject,
  downloadBytes,
  downloadProject,
} from "./helpers/project-files";
const exampleRoot = `/@fs${process
  .cwd()
  .replaceAll("\\", "/")
  .replace(/^([A-Za-z]:)/, "/$1")}/examples`;

function fixture() {
  const project = structuredClone(sample);
  project.trends[0] = {
    ...project.trends[0],
    name: "保存温度",
    windowMs: 1500,
    maxPointsPerSeries: 20,
    pens: [
      {
        id: "pen:n",
        seriesId: "number",
        label: " 表示温度 ",
        color: "#aB12Ef",
      },
      { id: "pen:b", seriesId: "bool", label: " 運転 ", color: "#12aBcD" },
      { id: "pen:u", seriesId: "unknown", label: " 旧系列 ", color: "#FF0000" },
    ],
  };
  return project;
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "履歴トレンド", exact: true });
const plot = (page: Page) => dialog(page).locator("[data-history-phase]");
const calls = (page: Page) =>
  page.evaluate(() => (window as any).__savedHistory.calls.length);
async function inject(
  page: Page,
  project: ReturnType<typeof fixture>,
  patch: object = {},
) {
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
      const project=${JSON.stringify(project)};
      let notify=()=>{};
      const track=createSubscriber(update=>{notify=update;return ()=>{};});
      const context={version:2,kind:"historyContext",contextId:"context:1",historianNamespace:"archive:a",
        projectId:project.manifest.projectId,projectRevision:project.manifest.projectRevision,
        series:[{seriesId:"bool",label:"一覧状態"},{seriesId:"unknown",label:"一覧旧系列"},{seriesId:"number",label:"一覧温度"}],...${JSON.stringify(patch)}};
      const h=window.__savedHistory={calls:[],active:0,maxActive:0};
      const source={query(query,{signal}){h.active++;h.maxActive=Math.max(h.maxActive,h.active);
        return new Promise(resolve=>h.calls.push({query,signal,resolve:value=>{h.active--;resolve(value);}}));}};
      let service={source,context};
      h.replace=patch=>{const next={...structuredClone(context),...patch};if(next.version===1)delete next.historianNamespace;service={source,context:next};notify();};
      h.reply=index=>{const call=h.calls[index],result=structuredClone((call.query.mode==="raw"?rawCases:minmaxCases)[0].expected);
        result.query=structuredClone(call.query);result.series=call.query.seriesIds.map(id=>result.series.find(row=>row.seriesId===id));call.resolve(result);};
      mount(App,{target:document.getElementById("app"),props:{get historyService(){track();return service;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, body) });
  });
}
async function start(page: Page, project = fixture(), patch: object = {}) {
  await inject(page, project, patch);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/");
  await openProject(page, {
    name: "saved-trend.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  // Loading a Project retains the current mode.
  const preview = page.getByRole("button", {
    name: "表示プレビュー",
    exact: true,
  });
  if (await preview.isVisible()) await preview.click();
}
async function openMain(page: Page, keyboard = false) {
  const action = mainCanvas(page).getByRole("button", {
    name: "保存温度の履歴を開く",
    exact: true,
  });
  if (keyboard) {
    await action.focus();
    await page.keyboard.press("Enter");
  } else await action.click();
  await expect(dialog(page)).toBeVisible();
}
async function load(page: Page, to = "1970-01-01T00:00:02.000Z") {
  await dialog(page).getByLabel("終了UTC", { exact: true }).fill(to);
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
}
async function close(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  await expect(dialog(page)).toHaveCount(0);
}
async function reply(page: Page, index: number) {
  await page.evaluate((i) => (window as any).__savedHistory.reply(i), index);
}
async function openPopup(page: Page, screenId: string) {
  await page
    .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
    .click();
  const chooser = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await chooser.locator(`input[value="${screenId}"]`).check();
  await chooser
    .getByRole("button", { name: "小窓を表示", exact: true })
    .click();
  const popup = page.locator(`[data-preview-popup="${screenId}"]`);
  // Opening a Popup schedules its header focus after the chooser closes.
  // Let that transition finish before sending keyboard input to a card.
  await expect(popup.locator("[data-popup-move]")).toBeFocused();
  return popup;
}
for (const theme of ["light", "dark"] as const)
  test(`saved raw preset opens explicitly, uses ID presentation and stays separate from historic identity in ${theme}`, async ({
    page,
  }, info) => {
    const project = fixture();
    await start(page, project);
    await chooseTheme(page, theme);
    await expect.poll(() => calls(page)).toBe(0);
    await openMain(page, true);
    await expect(
      dialog(page).getByLabel("終了UTC", { exact: true }),
    ).toHaveValue("");
    await expect(
      dialog(page).getByRole("button", { name: "取得", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog(page).getByLabel("開始UTC", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(dialog(page).getByLabel("取得モード")).toBeDisabled();
    await expect(dialog(page).getByLabel("系列ごとの点数上限")).toHaveAttribute(
      "readonly",
      "",
    );
    await load(page);
    await expect.poll(() => calls(page)).toBe(1);
    expect(
      await page.evaluate(() => (window as any).__savedHistory.calls[0].query),
    ).toEqual({
      version: 1,
      kind: "query",
      requestId: "history:1",
      seriesIds: ["number", "bool", "unknown"],
      fromMs: 500,
      toMs: 2000,
      mode: "raw",
      maxPointsPerSeries: 20,
    });
    await reply(page, 0);
    await expect(plot(page)).toHaveAttribute("data-history-phase", "ready");
    await expect(plot(page).locator(".pen-identity")).toContainText(
      "別名: 表示温度",
    );
    await expect(plot(page).locator("h3")).not.toContainText("表示温度");
    await expect(plot(page).locator("h3")).not.toContainText("一覧温度");
    expect(
      await plot(page)
        .locator("[data-history-point]")
        .first()
        .evaluate((el) => getComputedStyle(el).fill),
    ).toBe("rgb(171, 18, 239)");
    await plot(page).getByLabel("表示する履歴系列").selectOption("bool");
    expect(
      await plot(page)
        .locator("[data-history-point]")
        .first()
        .evaluate((el) => getComputedStyle(el).fill),
    ).toBe("rgb(18, 171, 205)");
    await plot(page).getByLabel("表示する履歴系列").selectOption("unknown");
    await expect(plot(page)).toContainText("系列が見つかりません");
    await plot(page).getByLabel("表示する履歴系列").selectOption("number");
    await page.screenshot({
      path: info.outputPath(`saved-history-${theme}.png`),
    });
    await dialog(page)
      .getByLabel("終了UTC", { exact: true })
      .fill("1970-01-01T00:00:02.001Z");
    await expect(plot(page)).toHaveAttribute("data-history-phase", "idle");
    await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
    await close(page);
    await expect(
      mainCanvas(page).getByRole("button", {
        name: "保存温度の履歴を開く",
        exact: true,
      }),
    ).toBeFocused();
    await openMain(page);
    await expect(
      dialog(page).getByLabel("終了UTC", { exact: true }),
    ).toHaveValue("");
    await dialog(page)
      .getByRole("button", {
        name: "保存トレンドを解除して手動検索",
        exact: true,
      })
      .click();
    await expect(dialog(page).getByRole("checkbox")).toHaveCount(3);
    await expect(dialog(page).getByLabel("取得モード")).toBeEnabled();
    await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
    await close(page);
    expect(
      JSON.parse((await downloadBytes(await downloadProject(page))).toString()),
    ).toEqual(project);
  });
for (const [label, patch, message] of [
  [
    "v1",
    { version: 1, historianNamespace: undefined },
    "この接続は保存Trendの系列対応を提供していません",
  ],
  [
    "different namespace",
    { historianNamespace: "archive:other" },
    "namespaceが一致しません",
  ],
  [
    "missing pen",
    { series: [{ seriesId: "number", label: "温度" }] },
    "全系列が接続先の一覧にありません",
  ],
] as const)
  test(`unresolved ${label} preset never queries or silently loses a pen`, async ({
    page,
  }) => {
    // v1 must omit namespace entirely, so replace the injected source after start.
    await start(page, fixture(), label === "v1" ? {} : patch);
    if (label === "v1")
      await page.evaluate(() => {
        (window as any).__savedHistory.replace({
          version: 1,
          historianNamespace: undefined,
        });
      });
    await openMain(page);
    await expect(dialog(page)).toContainText(message);
    await dialog(page)
      .getByLabel("終了UTC", { exact: true })
      .fill("1970-01-01T00:00:02.000Z");
    await expect(
      dialog(page).getByRole("button", { name: "取得", exact: true }),
    ).toBeDisabled();
    expect(await calls(page)).toBe(0);
  });
test("saved minmax renders independent envelopes in the pen color, not alias as segment metadata", async ({
  page,
}) => {
  const project = fixture();
  project.trends[0].mode = "minmax";
  project.trends[0].windowMs = 5;
  project.trends[0].maxPointsPerSeries = 4;
  await start(page, project);
  await openMain(page);
  await load(page, "1970-01-01T00:00:00.005Z");
  await reply(page, 0);
  await expect(plot(page)).toHaveAttribute("data-history-phase", "ready");
  await expect(
    plot(page).locator("[data-history-envelope]").first(),
  ).toBeVisible();
  expect(
    await plot(page)
      .locator("[data-history-envelope]")
      .first()
      .evaluate((el) => getComputedStyle(el).stroke),
  ).toBe("rgb(171, 18, 239)");
  await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
});
test("Popup close/reopen and source replacement retain one physical slot and clear stale presentation", async ({
  page,
}) => {
  const project = fixture();
  await start(page, project);
  let popup = await openPopup(page, project.screens[0].id);
  await popup
    .getByRole("button", { name: "保存温度の履歴を開く", exact: true })
    .click();
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  // Simulate an external Popup owner close while the modal owns focus.
  await popup
    .getByRole("button", { name: "小窓を閉じる：プロセス画面", exact: true })
    .evaluate((el: HTMLButtonElement) => el.click());
  await expect(dialog(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).__savedHistory.calls[0].signal.aborted,
    ),
  ).toBe(true);
  popup = await openPopup(page, project.screens[0].id);
  await popup
    .getByRole("button", { name: "保存温度の履歴を開く", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(dialog(page).getByLabel("終了UTC", { exact: true })).toHaveValue(
    "",
  );
  await load(page);
  await expect(plot(page)).toContainText("前の読取の終了を待っています");
  expect(await calls(page)).toBe(1);
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await expect(plot(page)).toHaveAttribute("data-history-phase", "loading");
  await reply(page, 1);
  await expect(plot(page)).toHaveAttribute("data-history-phase", "ready");
  await page.evaluate(() =>
    (window as any).__savedHistory.replace({ contextId: "context:2" }),
  );
  await expect(plot(page)).toHaveAttribute("data-history-phase", "idle");
  await expect(dialog(page).getByLabel("終了UTC", { exact: true })).toHaveValue(
    "",
  );
  expect(
    await page.evaluate(() => (window as any).__savedHistory.maxActive),
  ).toBe(1);
});
test("Inspector opens saved history and Project replacement retires its owner", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await mainCanvas(page)
    .locator(`[data-object-id="${sample.screens[0].objects.at(-1)!.id}"]`)
    .click();
  await page.getByRole("button", { name: "履歴を開く", exact: true }).click();
  await load(page);
  const replacement = fixture();
  replacement.trends[0].pens[0].color = "#0000FF";
  await openProject(page, {
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(dialog(page)).toHaveCount(0);
  await reply(page, 0);
  await mainCanvas(page)
    .locator(`[data-object-id="${sample.screens[0].objects.at(-1)!.id}"]`)
    .click();
  await page.getByRole("button", { name: "履歴を開く", exact: true }).click();
  await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
});

test("different saved definitions share the physical read slot and never recolor a late result", async ({
  page,
}) => {
  const project = fixture();
  project.trends.push({
    ...structuredClone(project.trends[0]),
    id: "trend:2",
    name: "別定義",
    pens: [
      { id: "pen:2", seriesId: "number", label: "別名2", color: "#0000FF" },
    ],
  });
  const object = structuredClone(project.screens[0].objects.at(-1)!);
  object.id = "0199f000-0000-7000-8000-000000000041";
  object.order = 7;
  object.x = 540;
  object.y = 350;
  object.shape = { type: "trend", trendId: "trend:2" } as typeof object.shape;
  project.screens[0].objects.push(object);
  await start(page, project);
  await openMain(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await close(page);
  await mainCanvas(page)
    .getByRole("button", { name: "別定義の履歴を開く", exact: true })
    .click();
  await expect(dialog(page).getByLabel("終了UTC", { exact: true })).toHaveValue(
    "",
  );
  await load(page);
  expect(await calls(page)).toBe(1);
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
  await reply(page, 1);
  await expect(plot(page)).toHaveAttribute("data-history-phase", "ready");
  await expect(plot(page).locator(".pen-identity")).toContainText("別名2");
  expect(
    await plot(page)
      .locator("[data-history-point]")
      .first()
      .evaluate((el) => getComputedStyle(el).fill),
  ).toBe("rgb(0, 0, 255)");
  expect(
    await page.evaluate(() => (window as any).__savedHistory.maxActive),
  ).toBe(1);
});
for (const origin of ["main", "popup"] as const)
  test(`${origin} saved preset retires when its origin screen is left`, async ({
    page,
  }) => {
    const project = fixture();
    project.screens.push({
      ...structuredClone(project.screens[0]),
      id: "0199f000-0000-7000-8000-000000000050",
      name: "別画面",
      objects: [],
    });
    await start(page, project);
    if (origin === "main") await openMain(page);
    else {
      const popup = await openPopup(page, project.screens[0].id);
      await popup
        .getByRole("button", { name: "保存温度の履歴を開く", exact: true })
        .click();
    }
    await load(page);
    await expect.poll(() => calls(page)).toBe(1);
    // An external navigation can invalidate a modal owner without a modal click.
    await page
      .getByRole("navigation", { name: "画面タブ", exact: true })
      .getByRole("button", { name: "別画面", exact: true })
      .evaluate((el: HTMLButtonElement) => el.click());
    await expect(dialog(page)).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as any).__savedHistory.calls[0].signal.aborted,
      ),
    ).toBe(true);
    await reply(page, 0);
    await page
      .getByRole("navigation", { name: "画面タブ", exact: true })
      .getByRole("button", { name: "プロセス画面", exact: true })
      .click();
    await openMain(page);
    await expect(plot(page).locator("[data-history-point]")).toHaveCount(0);
    await expect(
      dialog(page).getByLabel("終了UTC", { exact: true }),
    ).toHaveValue("");
  });
