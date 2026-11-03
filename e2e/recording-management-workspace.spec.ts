import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import fixtures from "../examples/recording-management-cases.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";
import {
  openProject,
  downloadBytes,
  downloadProject,
} from "./helpers/project-files";
async function inject(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    const body = `
      import { createSubscriber } from "/node_modules/.vite/deps/svelte_reactivity.js";
      import { unmount } from "/node_modules/.vite/deps/svelte.js";
      import fixtures from "/@fs${process.cwd()}/examples/recording-management-cases.json?import";
      import sample from "/@fs${process.cwd()}/examples/minimal.project.json?import";
      let notify=()=>{};
      const track=createSubscriber(update=>{notify=update;return()=>{};});
      const context={...fixtures.bases.context,projectId:sample.manifest.projectId,projectRevision:sample.manifest.projectRevision};
      const h=window.__recordingHarness={calls:[],active:0,maxActive:0};
      const inspect=function(request,{signal,deadlineMonotonicMs}) {
        h.active++;h.maxActive=Math.max(h.maxActive,h.active);
        return new Promise((resolve,reject)=>h.calls.push({request,signal,deadlineMonotonicMs,
          resolve(value){h.active--;resolve(value);},reject(){h.active--;reject(Error("PRIVATE SERVICE ERROR"));}}));
      };
      let service={context,inspect},sequence=1;
      h.replace=(patch={})=>{service={inspect,context:{...structuredClone(context),contextId:"context:"+(++sequence),...patch}};notify();};
      h.offline=()=>{service=undefined;notify();};
      h.reply=(index,base="observed",patch={})=> {
        const call=h.calls[index],response={...structuredClone(fixtures.bases[base]),request:structuredClone(call.request),...patch};
        call.resolve(response);
      };
      const app=mount(App,{target:document.getElementById("app"),props:{get recordingManagementService(){track();return service;}}});
      h.dispose=()=>unmount(app);
    `;
    await route.fulfill({ response, body: original.replace(mount, body) });
  });
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "記録管理状態", exact: true });
const phase = (page: Page) =>
  dialog(page).locator("[data-recording-management-phase]");
async function open(page: Page) {
  const bar = page.getByRole("menubar", { name: "Designer メニューバー" });
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: "表示", exact: true }).click();
  else
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "記録管理状態", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
const load = async (page: Page) =>
  dialog(page).getByRole("button", { name: "状態を照会", exact: true }).click();
const close = async (page: Page) =>
  dialog(page).getByRole("button", { name: "閉じる", exact: true }).click();
const reply = async (page: Page, index: number, base = "observed") =>
  page.evaluate(
    ({ index, base }) => (window as any).__recordingHarness.reply(index, base),
    { index, base },
  );
const calls = (page: Page) =>
  page.evaluate(() => (window as any).__recordingHarness.calls.length);
const hasPhase = async (page: Page, value: string) =>
  expect(phase(page)).toHaveAttribute("data-recording-management-phase", value);
const currentProject = {
  ...sample,
  recordingPlan: fixtures.bases.active.database.applied.desired,
};
function file(project = sample) {
  return {
    name: "recording.project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  };
}

test("ordinary App opens offline without automatic reads and shields background shortcuts", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  await open(page);
  await hasPhase(page, "offline");
  await expect(dialog(page)).toContainText("記録管理サービスは未接続です");
  await expect(
    dialog(page).getByRole("button", { name: "状態を照会" }),
  ).toBeDisabled();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Delete");
  await expect(dialog(page)).toBeVisible();
  await close(page);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
for (const theme of ["light", "dark"] as const)
  test(`explicit inspection shows independent DB/Host/SDK observations and preserves Project (${theme})`, async ({
    page,
  }, testInfo) => {
    await inject(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    await openProject(page, file(currentProject));
    const before = await downloadBytes(await downloadProject(page));
    await open(page);
    await hasPhase(page, "idle");
    expect(await calls(page)).toBe(0);
    await load(page);
    await expect.poll(() => calls(page)).toBe(1);
    await reply(page, 0);
    await hasPhase(page, "ready");
    await dialog(page).screenshot({
      path: testInfo.outputPath("recording-management.png"),
    });
    await expect(dialog(page).locator("[data-comparison]")).toHaveAttribute(
      "data-comparison",
      "matches",
    );
    const db = dialog(page).locator('section[aria-label="DBの適用状態"]'),
      host = dialog(page).locator('section[aria-label="Hostの別時点観測"]');
    await expect(db).toContainText("session:1");
    await expect(host).toContainText("session:other");
    await expect(host).toContainText("記録worker稼働");
    await expect(
      dialog(page).locator('section[aria-label="保持と回復の状態"]'),
    ).toContainText("未提供");
    await expect(
      dialog(page).locator('section[aria-label="SDKの独立観測"]'),
    ).toContainText("backoff");
    await expect(
      dialog(page).getByRole("button", { name: "適用", exact: true }),
    ).toHaveCount(0);
    await close(page);
    expect(await downloadBytes(await downloadProject(page))).toEqual(before);
    await expect(page.getByTestId("save-state")).toContainText(
      "書き出し要求後の変更なし",
    );
  });
test("close/reopen and same-function service replacement keep one physical read", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await close(page);
  expect(
    await page.evaluate(
      () => (window as any).__recordingHarness.calls[0].signal.aborted,
    ),
  ).toBe(true);
  await open(page);
  await hasPhase(page, "idle");
  expect(await calls(page)).toBe(1);
  await load(page);
  await expect(phase(page)).toContainText("前の照会の終了待ち");
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await page.evaluate(() => (window as any).__recordingHarness.replace());
  await hasPhase(page, "idle");
  await load(page);
  await reply(page, 1);
  await expect.poll(() => calls(page)).toBe(3);
  await reply(page, 2);
  await hasPhase(page, "ready");
  expect(
    await page.evaluate(() => (window as any).__recordingHarness.maxActive),
  ).toBe(1);
});
test("same-ID/revision Project replacement retires visible results and active reads", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await openProject(page, file());
  await expect(dialog(page)).not.toBeVisible();
  await open(page);
  await load(page);
  await expect(phase(page)).toContainText("前の照会の終了待ち");
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  await reply(page, 1);
  await hasPhase(page, "ready");
  await close(page);
  await openProject(page, file());
  await open(page);
  await hasPhase(page, "idle");
  await expect(dialog(page).locator("[data-comparison]")).toHaveCount(0);
});
test("DB failure stays partial observation while unknown SDK and null gates stay unknown", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await reply(page, 0, "unavailable");
  await hasPhase(page, "ready");
  await expect(dialog(page)).toContainText("DB照会失敗 / 部分観測");
  await expect(dialog(page).locator("[data-comparison]")).toHaveAttribute(
    "data-comparison",
    "unavailable",
  );
  await load(page);
  await expect.poll(() => calls(page)).toBe(2);
  await reply(page, 1, "active");
  await hasPhase(page, "ready");
  await expect(dialog(page)).toContainText("Host状態は未提供です");
  await expect(dialog(page)).toContainText("SDK接続状態は未提供です");
});
test("invalid context and mismatched Project disable reads, invalid response and rejection never show raw error", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await page.evaluate(() =>
    (window as any).__recordingHarness.replace({ storeId: null }),
  );
  await hasPhase(page, "invalidContext");
  await expect(
    dialog(page).getByRole("button", { name: "状態を照会" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as any).__recordingHarness.replace({ projectRevision: 99 }),
  );
  await hasPhase(page, "contextMismatch");
  expect(await calls(page)).toBe(0);
  await page.evaluate(() => (window as any).__recordingHarness.replace());
  await hasPhase(page, "idle");
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await page.evaluate(() =>
    (window as any).__recordingHarness.calls[0].resolve({
      secret: "PRIVATE PAYLOAD",
    }),
  );
  await hasPhase(page, "invalidResponse");
  await expect(dialog(page)).not.toContainText("PRIVATE");
  await load(page);
  await expect.poll(() => calls(page)).toBe(2);
  await page.evaluate(() =>
    (window as any).__recordingHarness.calls[1].reject(),
  );
  await hasPhase(page, "serviceFailure");
  await expect(dialog(page)).not.toContainText("PRIVATE");
});
test("cancel and timeout hide late results while pending still waits for cleanup", async ({
  page,
}) => {
  await page.clock.install();
  await inject(page);
  await page.goto("/");
  await open(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await dialog(page).getByRole("button", { name: "照会を取消" }).click();
  await hasPhase(page, "cancelled");
  await load(page);
  await expect(phase(page)).toContainText("前の照会の終了待ち");
  await reply(page, 0);
  await expect.poll(() => calls(page)).toBe(2);
  // Advance the real realm clock together with timers; the fixed UI budget is 10s.
  await page.clock.fastForward(10001);
  await hasPhase(page, "timeout");
  await reply(page, 1);
  await hasPhase(page, "timeout");
  await expect(dialog(page).locator("[data-comparison]")).toHaveCount(0);
});
test("App disposal requests abort and keeps external reader cleanup independent", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await open(page);
  await load(page);
  await expect.poll(() => calls(page)).toBe(1);
  await page.evaluate(() => (window as any).__recordingHarness.dispose());
  expect(
    await page.evaluate(
      () => (window as any).__recordingHarness.calls[0].signal.aborted,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).__recordingHarness.active),
  ).toBe(1);
  await reply(page, 0);
  expect(
    await page.evaluate(() => (window as any).__recordingHarness.active),
  ).toBe(0);
});
