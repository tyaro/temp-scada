import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import { openProject } from "./helpers/project-files";

// The desktop shell over a mocked Tauri IPC: the recording management
// service comes from `recording_context`, its inspection is
// `recording_status`, and an administrator's first setup, stop,
// reconfiguration and resume are `recording_initial_setup`,
// `recording_stop`, `recording_reconfigure` and `recording_resume`
// (product-owner design §5, §8-5). The App, menu, Modal and controller are
// production.
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

type Activation = "active" | "closed" | "interrupted";

/** The host starts with no applied plan, or with one whose latest activation
 * is in the given state; `failures` are the error kinds each command answers
 * first, in order. */
async function mockNativeHost(
  page: Page,
  role: "admin" | "viewer",
  start: { activation?: Activation; failures?: Record<string, string[]> } = {},
) {
  await page.addInitScript(
    ({ role, plan, start }) => {
      let nextId = 0;
      const host = {
        role,
        applied: start.activation !== undefined,
        activation: (start.activation ?? null) as Activation | null,
        activations: start.activation ? 1 : 0,
        failures: start.failures ?? {
          recording_initial_setup: ["tags_unresolved"],
        },
        setups: [] as string[],
        calls: [] as string[],
        statuses: 0,
        historyContexts: 0,
      };
      const fail = (command: string) => {
        const kind = host.failures[command]?.shift();
        if (kind) throw { kind };
      };
      const begin = () => {
        host.activation = "active";
        host.activations++;
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
      const running = () => host.activation === "active";
      const database = () =>
        host.applied
          ? {
              state: "available",
              snapshotCommit: 6,
              currentMappingRevision: 1,
              currentRetentionAppliedRevision: 1,
              applied: {
                appliedRevision: 1,
                commitVersion: 4,
                desired: plan,
                mappingRevision: 1,
                retentionAppliedRevision: 1,
              },
              latestActivation: host.activation && {
                activationId: `activation:${host.activations}`,
                appliedRevision: 1,
                commitVersion: 5,
                sessionId: `session:${host.activations}`,
                state: host.activation,
                committedThrough: 0,
                endCommitVersion: host.activation === "active" ? null : 6,
              },
              activeSessionId:
                host.activation === "active"
                  ? `session:${host.activations}`
                  : null,
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
                    runRef: running() ? `run:${host.activations}` : null,
                    sessionId: running() ? `session:${host.activations}` : null,
                    phase: running()
                      ? "running"
                      : host.activation === "closed"
                        ? "joined"
                        : "idle",
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
                fail(command);
                host.applied = true;
                begin();
                return { phase: "running", owner: "installed" };
              case "recording_stop":
                host.calls.push(command);
                fail(command);
                host.activation = "closed";
                return { phase: "joined" };
              case "recording_reconfigure":
                host.calls.push(command);
                fail(command);
                return { applied: "applied", enabled: true };
              case "recording_resume":
                host.calls.push(command);
                fail(command);
                begin();
                return { phase: "running", owner: "installed" };
            }
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      });
    },
    { role, plan, start },
  );
}

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "記録管理状態", exact: true });
const host = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).__recordingHost;
    return {
      setups: [...h.setups],
      calls: [...h.calls],
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

test("an administrator stops, applies the plan while stopped and resumes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockNativeHost(page, "admin", {
    activation: "active",
    failures: { recording_reconfigure: ["plan_conflict"] },
  });
  await page.goto("/");
  await openProject(page, file(planned));
  await open(page);
  const root = dialog(page);
  const stop = root.locator("[data-recording-stop]");
  const reconfigure = root.locator("[data-recording-reconfigure]");
  const resume = root.locator("[data-recording-resume]");
  const result = root.locator("[data-recording-control-result]");
  await expect(stop).toBeDisabled();
  await root.getByRole("button", { name: "状態を照会", exact: true }).click();
  await expect(root.locator("[data-comparison]")).toHaveAttribute(
    "data-comparison",
    "matches",
    { timeout: 30000 },
  );
  // While recording, only stopping is offered.
  await expect(stop).toBeEnabled();
  await expect(reconfigure).toBeDisabled();
  await expect(resume).toBeDisabled();
  await expect(
    root.getByRole("button", { name: "初回設定と開始" }),
  ).toBeDisabled();

  await stop.click();
  await expect(result).toHaveAttribute("data-recording-control-result", "ok");
  await expect(result).toHaveAttribute("data-recording-control-action", "stop");
  await expect(result).toHaveText("記録を停止しました");
  await expect(
    root.locator('section[aria-label="Hostの別時点観測"]'),
  ).toContainText("join完了");
  await expect(stop).toBeDisabled();
  await expect(reconfigure).toBeEnabled();
  await expect(resume).toBeEnabled();

  await reconfigure.click();
  await expect(result).toHaveAttribute(
    "data-recording-control-result",
    "failed",
  );
  await expect(root.getByRole("alert")).toHaveText(
    "計画の版がDBと合いません。Projectの計画のrevisionを上げてから適用してください",
  );
  await expect(reconfigure).toBeEnabled();
  const before = (await host(page)).historyContexts;
  await reconfigure.click();
  await expect(result).toHaveAttribute("data-recording-control-result", "ok");
  await expect(result).toContainText("Projectの計画をDBに適用しました");
  await expect(result).toContainText("「記録を再開」で開始します");
  await expect
    .poll(async () => (await host(page)).historyContexts)
    .toBeGreaterThan(before);

  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(result).toHaveAttribute(
    "data-recording-control-action",
    "resume",
  );
  await expect(result).toHaveText("記録を再開しました");
  await expect(
    root.locator('section[aria-label="Hostの別時点観測"]'),
  ).toContainText("run:2");
  await expect(stop).toBeEnabled();
  await expect(resume).toBeDisabled();
  expect((await host(page)).calls).toEqual([
    "recording_stop",
    "recording_reconfigure",
    "recording_reconfigure",
    "recording_resume",
  ]);
});

test("an interrupted recording is shown and resumed after a failure", async ({
  page,
}) => {
  await mockNativeHost(page, "admin", {
    activation: "interrupted",
    failures: { recording_resume: ["hub_unavailable"] },
  });
  await page.goto("/");
  await openProject(page, file(planned));
  await open(page);
  const root = dialog(page);
  await root.getByRole("button", { name: "状態を照会", exact: true }).click();
  await expect(root.locator("[data-recording-interrupted]")).toContainText(
    "前回の記録は終了を確認できないまま中断しました",
    { timeout: 30000 },
  );
  const resume = root.locator("[data-recording-resume]");
  await expect(root.locator("[data-recording-stop]")).toBeDisabled();
  await resume.click();
  await expect(root.getByRole("alert")).toHaveText(
    "Hubから現在値を取得できませんでした",
  );
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(root.locator("[data-recording-control-result]")).toHaveText(
    "記録を再開しました",
  );
  await expect(root.locator("[data-recording-interrupted]")).toHaveCount(0);
  expect((await host(page)).calls).toEqual([
    "recording_resume",
    "recording_resume",
  ]);
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
  await expect(
    dialog(page).locator(
      "[data-recording-stop], [data-recording-reconfigure], [data-recording-resume]",
    ),
  ).toHaveCount(0);
  expect((await host(page)).setups).toEqual([]);
});
