import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import fixtures from "../examples/recording-operations-cases.json" with { type: "json" };
import { chooseTheme, chooseMenuItem } from "./helpers/designer";
import {
  openProject,
  downloadBytes,
  downloadProject,
} from "./helpers/project-files";
const project = {
  ...sample,
  recordingPlan: fixtures.bases.change.apply.desired,
};
const file = (value = project) => ({
  name: "operations.project.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(value)),
});
async function inject(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const pattern =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(pattern);
    const body = `
  const {createSubscriber} = await import("/node_modules/.vite/deps/svelte_reactivity.js");
  const {unmount} = await import("/node_modules/.vite/deps/svelte.js");
  const {createOperationsHarness} = await import("/src/lib/__fixtures__/recording-operations-service.ts");
  let notify=()=>{};const track=createSubscriber(update=>{notify=update;return()=>{};});
  const h=createOperationsHarness();let service=h.service;
  const harness=window.__operationsHarness={h,replace(){service=createOperationsHarness().service;notify();},offline(){service=undefined;notify();}};
  let app;harness.mount=()=>{app=mount(App,{target:document.getElementById("app"),props:{get recordingOperationsService(){track();return service;}}});};
  harness.dispose=()=>unmount(app);harness.mount();
  `;
    await route.fulfill({ response, body: original.replace(pattern, body) });
  });
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "記録計画の操作", exact: true });
const button = (page: Page, name: string) =>
  dialog(page).getByRole("button", { name, exact: true });
async function open(page: Page) {
  await chooseMenuItem(page, "記録", "記録計画の操作");
  await expect(dialog(page)).toBeVisible();
}
const phase = (page: Page, value: string) =>
  expect(
    dialog(page).locator("[data-recording-operations-phase]"),
  ).toHaveAttribute("data-recording-operations-phase", value);
const finish = (
  page: Page,
  index: number,
  kind = "default",
  patch: Record<string, unknown> = {},
) =>
  page.evaluate(
    ({ index, kind, patch }) =>
      (window as any).__operationsHarness.h.finish(index, kind, patch),
    { index, kind, patch },
  );
async function prepare(page: Page) {
  await inject(page);
  await page.goto("/");
  await openProject(page, file());
  await open(page);
}
async function preflight(page: Page) {
  await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(page).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(page, "新しい変更を検査").click();
  await phase(page, "preflighting");
}
async function applying(page: Page) {
  await preflight(page);
  await finish(page, 0);
  await button(page, "この元runを停止してjoin").click();
  await finish(page, 1);
  await button(page, "同候補を適用").click();
  await phase(page, "applying");
}
test("ordinary App is offline and shields shortcuts without changing Project", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  await open(page);
  await expect(dialog(page)).toContainText("記録操作サービスは未接続です");
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Delete");
  await expect(dialog(page)).toBeVisible();
  await button(page, "閉じる").click();
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
for (const theme of ["light", "dark"] as const)
  test(`explicit three-stage operation, immutable desired and no restart (${theme})`, async ({
    page,
  }, testInfo) => {
    await inject(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    await openProject(page, file());
    const before = await downloadBytes(await downloadProject(page));
    await open(page);
    expect(
      await page.evaluate(
        () => (window as any).__operationsHarness.h.calls.length,
      ),
    ).toBe(0);
    await applying(page);
    expect(
      await page.evaluate(() => (window as any).__operationsHarness.h.stops),
    ).toBe(1);
    await expect(button(page, "操作の取消を要求")).toBeEnabled();
    await finish(page, 2);
    await phase(page, "completed");
    await expect(dialog(page)).toContainText("適用commit確認済み");
    await expect(dialog(page)).toContainText("静止確認: 確認済み");
    await dialog(page).screenshot({
      path: testInfo.outputPath(`recording-operations-${theme}.png`),
    });
    expect(
      await page.evaluate(() =>
        (window as any).__operationsHarness.h.calls.map(
          (c: any) => c.handle.request.stage,
        ),
      ),
    ).toEqual(["preflight", "pauseJoin", "apply"]);
    await button(page, "閉じる").click();
    expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  });
test("expected revision validation never dispatches an invalid enabled request", async ({
  page,
}) => {
  await prepare(page);
  await button(page, "新しい変更を検査").click();
  await expect(dialog(page).getByRole("alert")).toContainText("期待版を確認");
  await dialog(page).getByLabel("期待mapping版", { exact: true }).fill("1e3");
  await dialog(page).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(page, "新しい変更を検査").click();
  expect(
    await page.evaluate(
      () => (window as any).__operationsHarness.h.calls.length,
    ),
  ).toBe(0);
});
for (const kind of ["replay", "conflict"])
  test(`${kind} preflight does not stop or apply`, async ({ page }) => {
    await prepare(page);
    await preflight(page);
    await finish(page, 0, kind);
    await phase(page, "completed");
    await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
    await expect(button(page, "同候補を適用")).toBeDisabled();
    expect(
      await page.evaluate(() => (window as any).__operationsHarness.h.stops),
    ).toBe(0);
  });
test("close and reopen preserve pending operation and late receipt", async ({
  page,
}) => {
  await prepare(page);
  await applying(page);
  await button(page, "閉じる").click();
  await finish(page, 2);
  await open(page);
  await expect(dialog(page)).toContainText("適用commit確認済み");
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.cancels),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.writes),
  ).toBe(1);
});
test("service replacement keeps old owner gated until safe completion and explicit target switch", async ({
  page,
}) => {
  await prepare(page);
  await applying(page);
  await page.evaluate(() => (window as any).__operationsHarness.replace());
  await expect(dialog(page)).toContainText("以前の対象の操作を監視");
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  await expect(button(page, "現在の対象を確認")).toBeDisabled();
  await finish(page, 2);
  await expect(button(page, "現在の対象を確認")).toBeEnabled();
  await button(page, "現在の対象を確認").click();
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
});
test("same-ID Project replacement cannot use the old candidate", async ({
  page,
}) => {
  await prepare(page);
  await preflight(page);
  await finish(page, 0);
  await button(page, "閉じる").click();
  await openProject(page, file());
  await open(page);
  await expect(dialog(page)).toContainText("以前の対象の操作を監視");
  await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.stops),
  ).toBe(0);
  await button(page, "以前の候補を破棄").click();
  await button(page, "現在の対象を確認").click();
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
});
test("deadline keeps operation pending and explicit cancel does not drop a late result", async ({
  page,
}) => {
  await page.clock.install();
  await prepare(page);
  await preflight(page);
  await page.clock.fastForward(10001);
  await expect(dialog(page)).toContainText("期限超過・結果待ち");
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.cancels),
  ).toBe(0);
  await button(page, "操作の取消を要求").click();
  await expect(dialog(page)).toContainText("送信済み（結果待ち）");
  await finish(page, 0);
  await phase(page, "candidate");
  await button(page, "この元runを停止してjoin").click();
  await expect(button(page, "操作の取消を要求")).toBeDisabled();
});
test("explicit original-request reconciliation keeps receipt and recovery latch without retry", async ({
  page,
}) => {
  await prepare(page);
  await applying(page);
  await finish(page, 2, "workerFailure");
  await phase(page, "uncertain");
  await button(page, "元要求の結果を照会").click();
  await expect(button(page, "元要求の結果を照会")).toBeDisabled();
  await page.evaluate(() =>
    (window as any).__operationsHarness.h.finishRead(0),
  );
  await phase(page, "blocked");
  await expect(dialog(page)).toContainText("適用commit確認済み");
  await expect(dialog(page)).toContainText("回復確認: 必要");
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  await button(page, "元要求の結果を照会").click();
  await page.evaluate(() =>
    (window as any).__operationsHarness.h.finishRead(1, "notFound"),
  );
  await expect(dialog(page)).toContainText("適用commit確認済み");
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.writes),
  ).toBe(1);
});
test("external owner survives App disposal and remount", async ({ page }) => {
  await prepare(page);
  await preflight(page);
  await page.evaluate(() => (window as any).__operationsHarness.dispose());
  await finish(page, 0);
  await page.evaluate(() => (window as any).__operationsHarness.mount());
  await open(page);
  await phase(page, "candidate");
  expect(
    await page.evaluate(() => (window as any).__operationsHarness.h.cancels),
  ).toBe(0);
  await expect(dialog(page)).toContainText("受理済みの変更");
});
test("operation request IDs do not depend on randomUUID", async ({ page }) => {
  await prepare(page);
  // Existing Designer startup has its own UUID use; isolate this operation boundary.
  await page.evaluate(() =>
    Object.defineProperty(window.crypto, "randomUUID", { value: undefined }),
  );
  await preflight(page);
  expect(
    await page.evaluate(
      () => (window as any).__operationsHarness.h.calls.length,
    ),
  ).toBe(1);
});
