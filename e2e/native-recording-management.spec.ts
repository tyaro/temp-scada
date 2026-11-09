import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { openProject } from "./helpers/project-files";

// The desktop shell over a mocked Tauri IPC: the recording management
// service comes from `recording_context`, its inspection is
// `recording_status`, and an administrator's first setup is
// `recording_initial_setup` (product-owner design §5, §8-5). The App, menu,
// Modal and controller are production.
const plan = {
  version: 1,
  kind: "recordingPlan",
  planId: "plan-a",
  revision: 1,
  enabled: true,
  group: {
    groupId: "group",
    hubRef: "hub",
    periodMs: 1000,
    members: [
      {
        memberId: "member-0",
        externalName: "Plant.Number",
        valueType: "number",
      },
    ],
  },
};
const planned = { ...structuredClone(sample), recordingPlan: plan };

async function mockNativeHost(page: Page, role: "admin" | "viewer") {
  await page.addInitScript(
    ({ role, plan }) => {
      let nextId = 0;
      const host = {
        role,
        applied: false,
        refuseNext: true,
        setups: [] as string[],
        statuses: 0,
        historyContexts: 0,
      };
      Object.assign(window, { __recordingHost: host });
      const context = (project: any) => ({
        version: 1,
        kind: "recordingManagementContext",
        contextId: "host:test",
        projectId: project.manifest.projectId,
        projectRevision: project.manifest.projectRevision,
        deploymentId: "deployment:test",
        storeId: "store:test",
        historianNamespace: "historian:test",
      });
      const database = () =>
        host.applied
          ? {
              state: "available",
              snapshotCommit: 5,
              currentMappingRevision: 1,
              currentRetentionAppliedRevision: 1,
              applied: {
                appliedRevision: 1,
                commitVersion: 4,
                desired: plan,
                mappingRevision: 1,
                retentionAppliedRevision: 1,
              },
              latestActivation: {
                activationId: "activation:test",
                appliedRevision: 1,
                commitVersion: 5,
                sessionId: "session:test",
                state: "active",
                committedThrough: 0,
                endCommitVersion: null,
              },
              activeSessionId: "session:test",
              activeRetentionJobId: null,
              retentionFence: { cutoffMs: null, commitVersion: 0 },
            }
          : {
              state: "available",
              snapshotCommit: 0,
              currentMappingRevision: null,
              currentRetentionAppliedRevision: null,
              applied: null,
              latestActivation: null,
              activeSessionId: null,
              activeRetentionJobId: null,
              retentionFence: { cutoffMs: null, commitVersion: 0 },
            };
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          transformCallback() {
            return ++nextId;
          },
          async invoke(command: string, args: Record<string, any> = {}) {
            switch (command) {
              case "plugin:event|listen":
                return ++nextId;
              case "plugin:event|unlisten":
              case "hub_saved_endpoint":
                return null;
              case "hub_connect":
                return { state: "offline", cause: "test" };
              case "auth_phase":
                return {
                  phase: "initializing",
                  authDisabled: true,
                  hasAdmin: false,
                };
              case "auth_resolve":
                return {
                  identity: { id: "local", name: "ローカル", role: host.role },
                  kind: "local",
                  checked: 1,
                  current: 1,
                  stale: false,
                };
              case "history_context":
                host.historyContexts++;
                return null;
              case "recording_context":
                return context(JSON.parse(args.projectJson));
              case "recording_status":
                host.statuses++;
                return {
                  version: 1,
                  kind: "recordingInspectionResponse",
                  request: args.request,
                  database: database(),
                  host: {
                    state: "observed",
                    observedAtMs: 1000,
                    runRef: host.applied ? "run:1" : null,
                    sessionId: host.applied ? "session:test" : null,
                    phase: host.applied ? "running" : "idle",
                    stopRequested: false,
                    issue: "none",
                    cleanup: "unknown",
                    sourceShutdown: "unknown",
                    planRecoveryRequired: false,
                    retentionRearmRequired: false,
                    retentionJobPending: false,
                  },
                  sdk: { state: "unknown" },
                };
              case "recording_initial_setup":
                host.setups.push(
                  JSON.parse(args.projectJson).recordingPlan.planId,
                );
                if (host.refuseNext) {
                  host.refuseNext = false;
                  throw { kind: "tags_unresolved" };
                }
                host.applied = true;
                return { phase: "running" };
            }
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      });
    },
    { role, plan },
  );
}

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "記録管理状態", exact: true });
const host = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).__recordingHost;
    return {
      setups: [...h.setups],
      statuses: h.statuses,
      historyContexts: h.historyContexts,
    };
  });

async function open(page: Page) {
  await page
    .getByRole("menubar", { name: "Designer メニューバー" })
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "記録管理状態", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}

function file(project: unknown) {
  return {
    name: "recording.project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  };
}

test("an administrator inspects, retries and completes the first setup", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockNativeHost(page, "admin");
  await page.goto("/");
  await openProject(page, file(planned));
  await open(page);
  const root = dialog(page);
  const setup = root.getByRole("button", { name: "初回設定と開始" });
  // Not before an inspection shows the DB has no applied plan.
  await expect(setup).toBeDisabled();
  await root.getByRole("button", { name: "状態を照会", exact: true }).click();
  await expect(root.locator("[data-comparison]")).toHaveAttribute(
    "data-comparison",
    "notApplied",
  );
  await expect(setup).toBeEnabled();

  await setup.click();
  await expect(root.getByRole("alert")).toContainText(
    "希望設定のタグがHubのカタログにありません",
  );
  // The same command again after the failure.
  await expect(setup).toBeEnabled();
  const before = (await host(page)).historyContexts;
  await setup.click();
  await expect(root.locator('[data-recording-setup-result="ok"]')).toHaveText(
    "記録を開始しました",
  );
  await expect(root.locator("[data-comparison]")).toHaveAttribute(
    "data-comparison",
    "matches",
  );
  await expect(
    root.locator('section[aria-label="Hostの別時点観測"]'),
  ).toContainText("run:1");
  await expect(setup).toBeDisabled();
  const after = await host(page);
  expect(after.setups).toEqual(["plan-a", "plan-a"]);
  // History asks for the new applied plan's context.
  expect(after.historyContexts).toBeGreaterThan(before);
});

test("a viewer inspects but is not offered the first setup", async ({
  page,
}) => {
  await mockNativeHost(page, "viewer");
  await page.goto("/");
  await openProject(page, file(planned));
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "状態を照会", exact: true })
    .click();
  await expect(dialog(page).locator("[data-comparison]")).toHaveAttribute(
    "data-comparison",
    "notApplied",
  );
  await expect(
    dialog(page).getByRole("button", { name: "初回設定と開始" }),
  ).toHaveCount(0);
  expect((await host(page)).setups).toEqual([]);
});
