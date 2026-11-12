import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import fixtures from "../examples/recording-operations-cases.json" with { type: "json" };
import { chooseMenuItem } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// UX review 2026-11-11 P1-7: the expected revisions of a new change come
// from the last recording management inspection of the same target, instead
// of being copied by hand. The async operations port and the management
// service are the test harnesses; the App and both dialogs are production.
const exampleRoot = `/@fs${process
  .cwd()
  .replaceAll("\\", "/")
  .replace(/^([A-Za-z]:)/, "/$1")}/examples`;
const project = {
  ...sample,
  recordingPlan: fixtures.bases.change.apply.desired,
};
const file = () => ({
  name: "expected.project.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(project)),
});
async function inject(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const pattern =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(pattern);
    const body = `
    const {createAsyncPortHarness} = await import("/src/lib/__fixtures__/recording-async-port.ts");
    const {createAsyncRecordingOperationsCoordinator} = await import("/src/lib/recording-async/coordinator.ts");
    const { default: fixtures } = await import("${exampleRoot}/recording-management-cases.json?import");
    const { default: sample } = await import("${exampleRoot}/minimal.project.json?import");
    const h=createAsyncPortHarness(), root=createAsyncRecordingOperationsCoordinator(h.port);
    const m=window.__managementHarness={calls:[]};
    const inspect=(request)=>new Promise((resolve)=>m.calls.push({request,resolve}));
    m.reply=(index,base)=>{const call=m.calls[index];call.resolve({...structuredClone(fixtures.bases[base]),request:structuredClone(call.request)});};
    const service={context:{...fixtures.bases.context,projectId:sample.manifest.projectId,projectRevision:sample.manifest.projectRevision},inspect};
    mount(App,{target:document.getElementById("app"),props:{recordingAsyncOperations:root.client,recordingManagementService:service}});`;
    await route.fulfill({ response, body: original.replace(pattern, body) });
  });
}
const operations = (p: Page) =>
  p.getByRole("dialog", { name: "記録計画の操作", exact: true });
const management = (p: Page) =>
  p.getByRole("dialog", { name: "記録管理状態", exact: true });
async function inspect(p: Page, base = "active") {
  await chooseMenuItem(p, "記録", "記録管理状態");
  await management(p)
    .getByRole("button", { name: "状態を照会", exact: true })
    .click();
  await expect
    .poll(() =>
      p.evaluate(() => (window as any).__managementHarness.calls.length),
    )
    .toBe(1);
  await p.evaluate(
    (base) => (window as any).__managementHarness.reply(0, base),
    base,
  );
  await expect(
    management(p).locator("[data-recording-management-phase]"),
  ).toHaveAttribute("data-recording-management-phase", "ready");
  await management(p)
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
}
async function openOperations(p: Page) {
  await chooseMenuItem(p, "記録", "記録計画の操作");
  await expect(operations(p)).toBeVisible();
  await expect(
    operations(p).getByRole("button", { name: "新しい変更を検査" }),
  ).toBeEnabled({ timeout: 30_000 });
}
const field = (p: Page, name: string) =>
  operations(p).getByLabel(name, { exact: true });

test("the inspection's revisions fill the expected fields", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await openProject(page, file());
  await inspect(page);
  await openOperations(page);
  const source = operations(page).locator("[data-expected-source]");
  await expect(source).toHaveAttribute("data-expected-source", "inspection");
  await expect(source).toContainText(
    "の版を入れました: 適用版 2 · mapping版 4 · 保持適用版 3",
  );
  // The fields are under "details", already filled.
  await operations(page).getByText("期待版を手で直す").click();
  await expect(field(page, "期待適用版")).toHaveValue("2");
  await expect(field(page, "期待mapping版")).toHaveValue("4");
  await expect(field(page, "期待保持適用版")).toHaveValue("3");
  // An edit is the user's: the line says the values differ.
  await field(page, "期待適用版").fill("5");
  await expect(source).toHaveAttribute("data-expected-source", "edited");
  await expect(field(page, "期待mapping版")).toHaveValue("4");
});

test("an inspection that could not read the DB fills nothing", async ({
  page,
}) => {
  await inject(page);
  await page.goto("/");
  await openProject(page, file());
  await inspect(page, "unavailable");
  await openOperations(page);
  const source = operations(page).locator("[data-expected-source]");
  await expect(source).toHaveAttribute("data-expected-source", "manual");
  await expect(field(page, "期待適用版")).toHaveValue("");
  await expect(field(page, "期待mapping版")).toHaveValue("");
});
