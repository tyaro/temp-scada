import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import fixtures from "../examples/recording-operations-cases.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";
import {
  openProject,
  downloadBytes,
  downloadProject,
} from "./helpers/project-files";
const project = {
  ...sample,
  recordingPlan: fixtures.bases.change.apply.desired,
};
const file = () => ({
  name: "async.project.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(project)),
});
async function inject(page: Page, mode = "async") {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const pattern =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(pattern);
    const body = `
    const {createSubscriber} = await import("/node_modules/.vite/deps/svelte_reactivity.js");
    const {unmount} = await import("/node_modules/.vite/deps/svelte.js");
    const {createAsyncPortHarness} = await import("/src/lib/__fixtures__/recording-async-port.ts");
    const {createAsyncRecordingOperationsCoordinator} = await import("/src/lib/recording-async/coordinator.ts");
    const {createOperationsHarness} = await import("/src/lib/__fixtures__/recording-operations-service.ts");
    const h=createAsyncPortHarness(), root=createAsyncRecordingOperationsCoordinator(h.port), sync=createOperationsHarness();
    let notify=()=>{};const track=createSubscriber(update=>{notify=update;return()=>{};});
    let asyncClient=${mode === "sync" ? "undefined" : "root.client"},service=${mode === "sync" || mode === "both" ? "sync.service" : "undefined"};
    const harness=window.__asyncHarness={h,root,sync,swapMode(){if(service){service=undefined;asyncClient=root.client;}else{asyncClient=undefined;service=sync.service;}notify();},replace(){const next=createAsyncPortHarness();harness.next=next;harness.nextRoot=createAsyncRecordingOperationsCoordinator(next.port);asyncClient=harness.nextRoot.client;notify();}};
    let app;harness.mount=()=>{app=mount(App,{target:document.getElementById("app"),props:{get recordingAsyncOperations(){track();return asyncClient;},get recordingOperationsService(){track();return service;}}});};
    harness.dispose=()=>unmount(app);harness.mount();`;
    await route.fulfill({ response, body: original.replace(pattern, body) });
  });
}
const dialog = (p: Page) =>
  p.getByRole("dialog", { name: "記録計画の操作", exact: true });
const button = (p: Page, name: string) =>
  dialog(p).getByRole("button", { name, exact: true });
async function open(p: Page) {
  const bar = p.getByRole("menubar", { name: "Designer メニューバー" });
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: "表示", exact: true }).click();
  else await p.getByRole("button", { name: "メニュー", exact: true }).click();
  await p
    .getByRole("menuitem", { name: "記録計画の操作", exact: true })
    .click();
  await expect(dialog(p)).toBeVisible();
}
async function prepare(p: Page, mode = "async") {
  await inject(p, mode);
  await p.goto("/");
  await openProject(p, file());
  await open(p);
}
async function preflight(p: Page) {
  await dialog(p).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(p).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(p, "新しい変更を検査").click();
  await expect(
    dialog(p).locator("[data-recording-async-admission]"),
  ).toHaveAttribute("data-recording-async-admission", "accepted");
}
const finish = (p: Page, index: number, kind = "default") =>
  p.evaluate(
    ({ index, kind }) => (window as any).__asyncHarness.h.finish(index, kind),
    { index, kind },
  );
async function applying(p: Page) {
  await preflight(p);
  await finish(p, 0);
  await expect(button(p, "この元runを停止してjoin")).toBeEnabled();
  await button(p, "この元runを停止してjoin").click();
  await expect(button(p, "同候補を適用")).toBeDisabled();
  await finish(p, 1);
  await expect(button(p, "同候補を適用")).toBeEnabled();
  await button(p, "同候補を適用").click();
}
for (const theme of ["light", "dark"] as const)
  test(`external async root explicit stages and receipt without changing saved Project (${theme})`, async ({
    page,
  }, info) => {
    await inject(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    await openProject(page, file());
    const before = await downloadBytes(await downloadProject(page));
    await open(page);
    await applying(page);
    await finish(page, 2);
    await expect(dialog(page)).toContainText("設定commit済み");
    await expect(dialog(page)).toContainText("再開は別操作");
    expect(
      await page.evaluate(() => (window as any).__asyncHarness.h.stops),
    ).toBe(1);
    expect(
      await page.evaluate(() => (window as any).__asyncHarness.h.writes),
    ).toBe(1);
    await dialog(page).screenshot({
      path: info.outputPath(`async-${theme}.png`),
    });
    await button(page, "閉じる").click();
    expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  });
test("unknown normal admission is recovered only by explicit inspection", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.configure({ autoAck: false }),
  );
  await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(page).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(page, "新しい変更を検査").click();
  await expect(
    dialog(page).locator("[data-recording-async-admission]"),
  ).toHaveAttribute("data-recording-async-admission", "awaitingAck");
  await page.evaluate(() => (window as any).__asyncHarness.h.ack(0, "unknown"));
  await expect(dialog(page)).toContainText("受付不明です");
  await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
  await button(page, "元要求の受付を照会").click();
  await finish(page, 0);
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
});
test("unconfirmed apply result is reconciled without replacing original completion or clearing recovery", async ({
  page,
}) => {
  await prepare(page);
  await applying(page);
  await finish(page, 2, "workerFailure");
  await expect(dialog(page)).toContainText("commit有無不明");
  await button(page, "元要求の結果を照会").click();
  await page.evaluate(() => (window as any).__asyncHarness.h.finishRead(0));
  await expect(dialog(page)).toContainText("設定commit済み");
  await expect(dialog(page)).toContainText("回復確認が必要");
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as any).__asyncHarness.root.client.current().completion.outcome
          .kind,
    ),
  ).toBe("failed");
});
test("close and App unmount preserve root evidence; remount cannot adopt old candidate", async ({
  page,
}) => {
  await prepare(page);
  await preflight(page);
  await button(page, "閉じる").click();
  await finish(page, 0);
  await open(page);
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
  await button(page, "閉じる").click();
  await page.evaluate(async () => {
    await (window as any).__asyncHarness.dispose();
    (window as any).__asyncHarness.mount();
  });
  await openProject(page, file());
  await open(page);
  await expect(dialog(page)).toContainText("検査済み・元runは停止していません");
  await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
  await expect(button(page, "以前の候補を破棄")).toBeEnabled();
});
test("same-ID Project reload retires a lease waiting view and never sends late admit", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.configure({ autoLease: false }),
  );
  await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(page).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(page, "新しい変更を検査").click();
  await expect(dialog(page)).toContainText("受付準備中");
  await button(page, "閉じる").click();
  await openProject(page, file());
  await page.evaluate(() => (window as any).__asyncHarness.h.issueLease(0));
  await open(page);
  expect(
    await page.evaluate(
      () => (window as any).__asyncHarness.h.admissions.length,
    ),
  ).toBe(0);
});
test("selected new service cannot send until old candidate is discarded and explicitly switched", async ({
  page,
}) => {
  await prepare(page);
  await preflight(page);
  await finish(page, 0);
  await page.evaluate(() => (window as any).__asyncHarness.replace());
  await expect(dialog(page)).toContainText("以前の対象の操作を監視");
  await expect(button(page, "選択した接続へ切替")).toBeDisabled();
  await button(page, "以前の候補を破棄").click();
  await expect(button(page, "選択した接続へ切替")).toBeEnabled();
  await button(page, "選択した接続へ切替").click();
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as any).__asyncHarness.next.leases.length,
    ),
  ).toBe(0);
});
for (const mode of ["sync", "async"])
  test(`${mode} to opposite mode prop swap preserves monitoring and blocks sending`, async ({
    page,
  }) => {
    await prepare(page, mode);
    if (mode === "async") await preflight(page);
    else {
      await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1");
      await dialog(page)
        .getByLabel("期待保持適用版", { exact: true })
        .fill("1");
      await button(page, "新しい変更を検査").click();
    }
    await page.evaluate(() => (window as any).__asyncHarness.swapMode());
    await expect(dialog(page)).toContainText("操作モードは固定");
    if (mode === "async") await finish(page, 0);
    else
      await page.evaluate(() => (window as any).__asyncHarness.sync.finish(0));
    await expect(dialog(page)).toContainText(
      "検査済み・元runは停止していません",
    );
    await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
    await expect(button(page, "新しい変更を検査")).toBeDisabled();
  });
test("simultaneous service injection refuses both", async ({ page }) => {
  await prepare(page, "both");
  await expect(dialog(page)).toContainText("設定が競合");
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).__asyncHarness.h.leases.length),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__asyncHarness.sync.calls.length),
  ).toBe(0);
});
test("malformed transport response blocks sends and never displays provider payload", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.configure({ autoAck: false }),
  );
  await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(page).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(page, "新しい変更を検査").click();
  await expect(
    dialog(page).locator("[data-recording-async-admission]"),
  ).toHaveAttribute("data-recording-async-admission", "awaitingAck");
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.admissions[0].resolve({
      error: "PRIVATE_PROVIDER_URL_TOKEN",
    }),
  );
  await expect(dialog(page).getByRole("alert")).toContainText(
    "正常終了を確認できません",
  );
  await expect(dialog(page)).not.toContainText("PRIVATE_PROVIDER_URL_TOKEN");
  await expect(button(page, "元要求の受付を照会")).toBeDisabled();
  await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
});
for (const stage of ["pause", "apply"])
  test(`client swap retires a ${stage} lease wait without losing old evidence`, async ({
    page,
  }) => {
    await prepare(page);
    await preflight(page);
    await finish(page, 0);
    if (stage === "apply") {
      await button(page, "この元runを停止してjoin").click();
      await finish(page, 1);
      await expect(button(page, "同候補を適用")).toBeEnabled();
    }
    await page.evaluate(() =>
      (window as any).__asyncHarness.h.configure({ autoLease: false }),
    );
    await button(
      page,
      stage === "pause" ? "この元runを停止してjoin" : "同候補を適用",
    ).click();
    await expect(dialog(page)).toContainText("受付準備中");
    const before = await page.evaluate(
      () => (window as any).__asyncHarness.h.admissions.length,
    );
    await page.evaluate(() => (window as any).__asyncHarness.replace());
    await expect(dialog(page)).toContainText("以前の対象の操作を監視");
    await page.evaluate(() => {
      const h = (window as any).__asyncHarness.h;
      h.issueLease(h.leases.length - 1);
    });
    await expect(button(page, "以前の候補を破棄")).toBeEnabled();
    expect(
      await page.evaluate(
        () => (window as any).__asyncHarness.h.admissions.length,
      ),
    ).toBe(before);
    expect(
      await page.evaluate(
        () => (window as any).__asyncHarness.next.leases.length,
      ),
    ).toBe(0);
    await expect(dialog(page)).toContainText(
      stage === "pause"
        ? "検査済み・元runは停止していません"
        : "元runの停止・joinを確認しました",
    );
  });
test("same-turn lease settlement before client prop replacement cannot dispatch to retired selection", async ({
  page,
}) => {
  await prepare(page);
  await preflight(page);
  await finish(page, 0);
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.configure({ autoLease: false }),
  );
  await button(page, "この元runを停止してjoin").click();
  await expect(dialog(page)).toContainText("受付準備中");
  await page.evaluate(() => {
    const a = (window as any).__asyncHarness;
    a.h.issueLease(a.h.leases.length - 1);
    a.replace();
  });
  await expect(dialog(page)).toContainText("以前の対象の操作を監視");
  expect(
    await page.evaluate(() => (window as any).__asyncHarness.h.stops),
  ).toBe(0);
});
test("cancel interrupted before dispatch can be explicitly requested after reconnect", async ({
  page,
}) => {
  await prepare(page);
  await preflight(page);
  await page.evaluate(() => {
    const a = (window as any).__asyncHarness;
    let interrupted = false;
    a.root.client.subscribe((s: any) => {
      if (s.cancelCall === "pending" && !interrupted) {
        interrupted = true;
        a.h.emit({ connected: false });
      }
    });
  });
  await button(page, "操作の取消を要求").click();
  await expect(dialog(page)).toContainText("接続切断");
  expect(
    await page.evaluate(() => (window as any).__asyncHarness.h.cancels.length),
  ).toBe(0);
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.emit({ connected: true }),
  );
  await expect(button(page, "操作の取消を要求")).toBeEnabled();
  await button(page, "操作の取消を要求").click();
  expect(
    await page.evaluate(() => (window as any).__asyncHarness.h.cancels.length),
  ).toBe(1);
});
test("cached reconciliation unknown stays valid after later original-operation quiescence confirmation", async ({
  page,
}) => {
  await prepare(page);
  await applying(page);
  await finish(page, 2, "workerFailure");
  await button(page, "元要求の結果を照会").click();
  await page.evaluate(() =>
    (window as any).__asyncHarness.h.finishRead(0, "receiptFound", {
      quiescence: "unknown",
    }),
  );
  await expect(dialog(page)).toContainText("設定commit済み");
  await page.evaluate(() => {
    const h = (window as any).__asyncHarness.h;
    h.emit({
      operation: {
        operationRef: h.operations[2].handle.operationRef,
        result: { ...h.result(2, "workerFailure"), quiescence: "confirmed" },
      },
    });
  });
  await expect(dialog(page)).toContainText("静止確認: 確認済み");
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  await expect(button(page, "元要求の結果を照会")).toBeEnabled();
});
