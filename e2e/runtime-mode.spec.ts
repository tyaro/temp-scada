import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import rawCases from "../examples/history-query-cases.json" with { type: "json" };

/**
 * The Runtime window (Runtime mode design §6, §9 O0b) against a mock host
 * with the wire shapes of `runtime.rs` / `main.rs` / `app_mode.rs`.
 */
interface RuntimeHostOptions {
  project?: "opened" | "unreadable" | "invalidBody";
  hub?: "connected" | "reconnectInEditor";
  alarm?: "notApplied" | "otherProject" | "differs" | "same";
  /** `failOnce`: the first `runtime_read_start` fails, later ones succeed. */
  readStart?: "ok" | "failOnce";
  /** `firstAdmin`: the auth is on, no account exists and no one is signed in. */
  auth?: "operational" | "setup" | "transitioning" | "firstAdmin";
  /** What `recording_status` answers: no applied plan, or recording. */
  recording?: "unconfigured" | "running";
  /** `blocked`: listening to `alarm_changed` fails until the test sets `alarmListenBlocked = false`. */
  alarmListen?: "ok" | "blocked";
  /**
   * What `operation_view` answers (operation stage 3, O3c-1): the product's
   * `hub_unsupported`, or writable in the initializing phase. Either way the
   * Project gets the `write` definitions of `operationProject`.
   */
  operation?: "hubUnsupported" | "ready";
}

async function mockRuntimeHost(page: Page, options: RuntimeHostOptions = {}) {
  await page.addInitScript(
    ({ options, projectJson, historyResult }) => {
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let nextId = 0;
      const host = {
        calls: [] as string[],
        setups: [] as Record<string, unknown>[],
        account: null as null | { username: string; displayName: string },
        writes: [] as Record<string, unknown>[],
        latest: null as null | Record<string, unknown>,
        /** Overrides what `operation_view` answers in `blocked` when set. */
        operationBlocked: undefined as undefined | null | string,
        /** Milliseconds `operation_view` takes to answer. */
        viewDelayMs: 0,
        /** `operation_write` rejects without an answer (a lost IPC answer). */
        writeLost: false,
        seq: 1,
        starts: [] as Record<string, unknown>[],
        acks: [] as unknown[],
        alarmListenBlocked: options.alarmListen === "blocked",
        alarm: {
          monitored: { projectId: options.projectId },
          applied: {
            projectId: options.projectId,
            projectRevision: 1,
            appliedAtMs: 1,
            displays: {
              "cond-a": {
                name: "T-01 温度 H",
                message: "温度 高",
                severity: "high",
                limitLabel: null,
              },
            },
          },
          engine: {
            session: { id: "session-1", generation: 1 },
            seq: 10,
            unavailable: null,
            conditions: {
              "cond-a": {
                active: true,
                occurrence: "occ-1",
                recurrence: 0,
                acked: false,
                timer: null,
                unavailable: null,
                reportedUnavailable: null,
                orderKey: { generation: 1, seq: 1 },
                occurredAtMs: Date.UTC(2026, 10, 17, 0, 0, 1),
                observation: null,
              },
            },
          },
          status: "running",
          pendingConditionChanges: false,
          pendingDisplayChanges: false,
          pendingUnknown: false,
          historyWriteFailure: null,
          rereadFailure: null,
          buzzer: "quiet",
        } as any,
        /** While true, `alarm_snapshot` answers only when `releaseSnapshots()` is called. */
        holdSnapshots: false,
        unblockListenOnAck: false,
        heldSnapshots: [] as (() => void)[],
        releaseSnapshots() {
          const held = host.heldSnapshots.splice(0);
          for (const release of held) release();
        },
        emit(event: string, payload: unknown) {
          for (const listener of listeners.values())
            if (listener.event === event)
              callbacks.get(listener.handler)?.({ event, id: 1, payload });
        },
      };
      Object.assign(window, { __runtimeHost: host });
      Object.assign(window, {
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener(_event: string, eventId: number) {
            listeners.delete(eventId);
          },
        },
      });
      const encoder = new TextEncoder();
      function frame(header: unknown, body: Uint8Array): ArrayBuffer {
        const json = encoder.encode(JSON.stringify(header));
        const out = new Uint8Array(4 + json.length + body.length);
        new DataView(out.buffer).setUint32(0, json.length, true);
        out.set(json, 4);
        out.set(body, 4 + json.length);
        return out.buffer;
      }
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          transformCallback(callback: (event: unknown) => void) {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
          },
          async invoke(command: string, args?: Record<string, any>) {
            host.calls.push(command);
            switch (command) {
              case "plugin:event|listen": {
                if (args!.event === "alarm_changed" && host.alarmListenBlocked)
                  throw "listenFailed";
                const id = ++nextId;
                listeners.set(id, {
                  event: args!.event,
                  handler: args!.handler,
                });
                return id;
              }
              case "plugin:event|unlisten":
              case "plugin:window|set_title":
                return null;
              case "app_mode":
                return "runtime";
              case "runtime_project": {
                const kind = options.project ?? "opened";
                if (kind === "unreadable")
                  return frame(
                    {
                      status: "failed",
                      fileName: "plant.json",
                      reason: "unreadable",
                      detail: "os error 2",
                    },
                    new Uint8Array(),
                  );
                return frame(
                  {
                    status: "opened",
                    fileName: "plant.json",
                    projectDigest: "00",
                  },
                  encoder.encode(kind === "invalidBody" ? "{}" : projectJson),
                );
              }
              case "operation_view": {
                if (host.viewDelayMs)
                  await new Promise((done) =>
                    setTimeout(done, host.viewDelayMs),
                  );
                const ready = options.operation === "ready";
                return {
                  projectId: options.projectId,
                  projectDigest: "00",
                  blocked:
                    host.operationBlocked !== undefined
                      ? host.operationBlocked
                      : ready
                        ? null
                        : "hub_unsupported",
                  phase: ready ? "initializing" : "operational",
                  slots: ["running", "current"].map((slot) => ({
                    slot,
                    latest: slot === "running" ? host.latest : null,
                  })),
                };
              }
              case "operation_write": {
                host.writes.push(structuredClone(args!.request));
                if (host.writeLost) throw new Error("the answer was lost");
                host.latest = {
                  id: `record-${host.writes.length}`,
                  state: "finished",
                  outcome: "ok",
                  reason: null,
                  requestedAtMs: Date.UTC(2026, 10, 19, 1, 2, 3),
                  finishedAtMs: Date.UTC(2026, 10, 19, 1, 2, 4),
                  tag: "Plant.Run",
                  value: true,
                  auditId: 42,
                };
                return {
                  outcome: "ok",
                  reason: null,
                  tag: "Plant.Run",
                  value: true,
                  auditId: 42,
                  recordId: host.latest.id,
                  unrecorded: false,
                };
              }
              case "runtime_hub_connect":
                if (options.hub === "reconnectInEditor")
                  throw {
                    reason: "reconnectInEditor",
                    status: { state: "notConfigured" },
                  };
                return { state: "connected", tagCount: 3 };
              case "runtime_read_start":
                host.starts.push(args!);
                if (
                  options.readStart === "failOnce" &&
                  host.starts.length === 1
                )
                  throw "hub_unavailable";
                return null;
              case "hub_read_stop":
                return null;
              case "runtime_alarm_status":
                return options.alarm ?? "same";
              // The alarm commands Runtime may use (Runtime mode design §5).
              case "alarm_snapshot":
                if (host.holdSnapshots)
                  return new Promise((resolve) =>
                    host.heldSnapshots.push(() =>
                      resolve(structuredClone(host.alarm)),
                    ),
                  );
                return structuredClone(host.alarm);
              case "alarm_ack": {
                host.acks.push(structuredClone(args!.items));
                if (host.unblockListenOnAck) host.alarmListenBlocked = false;
                for (const item of args!.items)
                  host.alarm.engine.conditions[item.conditionId].acked = true;
                host.alarm.engine.seq += 10;
                return args!.items.map((item: any) => ({
                  conditionId: item.conditionId,
                  result: { kind: "accepted" },
                }));
              }
              case "alarm_history":
                return [];
              case "alarm_settings_get":
                return {
                  retention: { kind: "days", days: 365, count: 1_000_000 },
                  reread: {
                    intervalSec: 10,
                    timeoutSec: 5,
                    failureLimitSec: 30,
                    reconnectFailures: 3,
                  },
                  sound: { kind: "default" },
                  soundFallback: null,
                  warnings: [],
                  retentionStatus: null,
                };
              case "runtime_history_context":
                return {
                  version: 2,
                  kind: "historyContext",
                  contextId: "applied:1",
                  historianNamespace: "historian:test",
                  projectId: options.projectId,
                  projectRevision: 1,
                  series: [{ seriesId: "number", label: "温度" }],
                };
              case "history_query": {
                const result = structuredClone(historyResult);
                result.query = structuredClone(args!.query);
                result.series = args!.query.seriesIds.map((id: string) =>
                  result.series.find((row: any) => row.seriesId === id),
                );
                return result;
              }
              case "history_cancel":
                return null;
              case "runtime_recording_context":
                return {
                  version: 1,
                  kind: "recordingManagementContext",
                  contextId: "host:test",
                  projectId: options.projectId,
                  projectRevision: 1,
                  deploymentId: "deployment:test",
                  storeId: "store:test",
                  historianNamespace: "historian:test",
                };
              case "recording_status": {
                const running = options.recording === "running";
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
                return {
                  version: 1,
                  kind: "recordingInspectionResponse",
                  request: args!.request,
                  database: running
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
                        latestActivation: {
                          activationId: "activation:1",
                          appliedRevision: 1,
                          commitVersion: 5,
                          sessionId: "session:1",
                          state: "active",
                          committedThrough: 0,
                          endCommitVersion: null,
                        },
                        activeSessionId: "session:1",
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
                      },
                  host: running
                    ? {
                        state: "observed",
                        observedAtMs: 1000,
                        runRef: "run:1",
                        sessionId: "session:1",
                        phase: "running",
                        stopRequested: false,
                        issue: "none",
                        cleanup: "unknown",
                        sourceShutdown: "unknown",
                        planRecoveryRequired: false,
                        retentionRearmRequired: false,
                        retentionJobPending: false,
                      }
                    : { state: "unknown" },
                  sdk: { state: "unknown" },
                };
              }
              case "auth_setup":
                host.setups.push(args!);
                host.account = {
                  username: args!.username,
                  displayName: args!.displayName,
                };
                return {
                  success: true,
                  error: null,
                  superseded: false,
                  seq: ++host.seq,
                };
              case "auth_phase":
                if (options.auth === "firstAdmin")
                  return {
                    phase: "operational",
                    authDisabled: false,
                    hasAdmin: host.account !== null,
                  };
                return options.auth === "setup"
                  ? {
                      phase: "initializing",
                      authDisabled: true,
                      hasAdmin: false,
                    }
                  : options.auth === "transitioning"
                    ? {
                        phase: "transitioning",
                        authDisabled: true,
                        hasAdmin: true,
                      }
                    : {
                        phase: "operational",
                        authDisabled: true,
                        hasAdmin: true,
                      };
              case "auth_resolve":
                if (options.auth === "firstAdmin")
                  return {
                    identity: host.account && {
                      id: host.account.username,
                      name: host.account.displayName,
                      role: "admin",
                    },
                    kind: host.account ? "account" : null,
                    checked: host.seq,
                    current: host.seq,
                    stale: false,
                  };
                return {
                  identity: {
                    id: "local",
                    name: "ローカル",
                    role: options.auth ? "admin" : "viewer",
                  },
                  kind: "local",
                  checked: 1,
                  current: 1,
                  stale: false,
                };
            }
            throw Error(`Unexpected native command: ${command}`);
          },
        },
      });
    },
    {
      options: { ...options, projectId: sample.manifest.projectId },
      projectJson: JSON.stringify(
        options.operation ? operationProject() : sample,
      ),
      historyResult: rawCases[0].expected as any,
    },
  );
}

/** The sample with `write` on the motor type's slots (operation stage 3 §3). */
function operationProject() {
  const project = structuredClone(sample) as any;
  for (const type of project.equipmentTypes)
    for (const slot of type.slots)
      if (slot.name === "running")
        slot.write = {
          label: "運転指令",
          buttons: [
            { label: "運転", value: true },
            { label: "停止", value: false },
          ],
        };
      else if (slot.name === "current")
        slot.write = { label: "電流 設定", input: { min: 0, max: 100 } };
  return project;
}

const calls = (page: Page) =>
  page.evaluate(() => (window as any).__runtimeHost.calls as string[]);

test("shows only the operator view and the top bar, reading through runtime_read_start", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  const view = page.getByRole("region", { name: "運転表示" });
  await expect(view).toBeVisible();
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  const bar = await page.locator(".runtime-bar").boundingBox();
  const box = await view.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
  await expect(page.locator("[data-hub-status]")).toContainText(
    "Hub 接続中（3 件）",
  );
  await expect(page.getByRole("menubar")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "運転表示を終了（Esc）" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "表示プレビュー", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[data-runtime-alarm]")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__runtimeHost.starts.length),
    )
    .toBeGreaterThan(0);
  const start = await page.evaluate(
    () => (window as any).__runtimeHost.starts[0],
  );
  expect(Object.keys(start)).toEqual(["subscriptionId"]);
  const used = await calls(page);
  expect(used).not.toContain("hub_read_start");
  expect(used).not.toContain("hub_catalog");
  expect(used).not.toContain("hub_connect");
});

test("Editor keys do not reach an Editor screen", async ({ page }) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  const view = page.getByRole("region", { name: "運転表示" });
  await expect(view).toBeVisible();
  for (const key of [
    "Control+o",
    "Control+n",
    "Control+s",
    "Control+z",
    "Control+Shift+P",
    "F2",
    "Delete",
    "Escape",
  ])
    await page.keyboard.press(key);
  await expect(view).toBeVisible();
  await expect(page.getByRole("menubar")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/runtime.html");
  const used = await calls(page);
  for (const command of ["project_open", "project_save", "hub_connect"])
    expect(used).not.toContain(command);
});

test("a Project that cannot be read shows only its file name and reason", async ({
  page,
}) => {
  await mockRuntimeHost(page, { project: "unreadable" });
  await page.goto("/runtime.html");
  await expect(page.locator("[data-runtime-file]")).toHaveText("plant.json");
  await expect(page.locator("[data-runtime-reason]")).toHaveText(
    "ファイルを読めません",
  );
  await expect(page.getByRole("region", { name: "運転表示" })).toHaveCount(0);
  await expect(page.locator("[data-hub-status]")).toHaveCount(0);
  expect(await calls(page)).not.toContain("runtime_hub_connect");
});

test("a Project body of another format shows the format reason", async ({
  page,
}) => {
  await mockRuntimeHost(page, { project: "invalidBody" });
  await page.goto("/runtime.html");
  await expect(page.locator("[data-runtime-reason]")).toHaveText(
    "Project の形式が違います",
  );
  await expect(page.getByRole("region", { name: "運転表示" })).toHaveCount(0);
});

test("without a saved Hub it asks to connect in Editor and has no endpoint field", async ({
  page,
}) => {
  await mockRuntimeHost(page, { hub: "reconnectInEditor" });
  await page.goto("/runtime.html");
  await expect(page.locator("[data-runtime-hub-message]")).toContainText(
    "Editor で Hub に接続してから Runtime を使ってください",
  );
  await expect(page.locator("#hub-endpoint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "再接続" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "運転表示" })).toBeVisible();
  expect(await calls(page)).not.toContain("runtime_read_start");
});

for (const [alarm, text] of [
  ["notApplied", "警報の定義が適用されていません（Editor で適用してください）"],
  ["otherProject", "この端末の警報は、別の Project の定義で動いています"],
  ["differs", "警報の定義が、この Project と違います"],
] as const)
  test(`shows the alarm-definition notice: ${alarm}`, async ({ page }) => {
    await mockRuntimeHost(page, { alarm });
    await page.goto("/runtime.html");
    await expect(page.locator("[data-runtime-alarm]")).toHaveText(text);
  });

test("a second launch shows the already-running notice", async ({ page }) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  await expect(page.getByRole("region", { name: "運転表示" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__runtimeHost.calls.includes("plugin:event|listen"),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as any).__runtimeHost.emit("scada:second-instance", {
      reason: "otherProject",
    }),
  );
  await expect(page.locator("[data-runtime-second-instance]")).toContainText(
    "すでに起動しています。別の Project・別の mode で使うときは、いまの窓を閉じてから起動してください",
  );
});

test("the authentication popover at the right of the bar stays inside the window", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await page.locator(".runtime-auth summary").click();
  const popover = page.locator(".runtime-auth .auth-popover");
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
});

test("a failed read subscription start is shown and can be retried", async ({
  page,
}) => {
  await mockRuntimeHost(page, { readStart: "failOnce" });
  await page.goto("/runtime.html");
  await expect(page.locator("[data-runtime-stream]")).toHaveText(
    "読取: 購読開始失敗",
  );
  await expect(page.locator("[data-hub-status]")).toContainText(
    "Hub 接続中・読取停止",
  );
  await expect(page.locator("[data-hub-status]")).not.toContainText(
    "Hub 接続中（3 件）",
  );
  await page.getByRole("button", { name: "読取を再試行" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__runtimeHost.starts.length),
    )
    .toBe(2);
  await expect(page.locator("[data-hub-status]")).toContainText(
    "Hub 接続中（3 件）",
  );
  await expect(page.getByRole("button", { name: "読取を再試行" })).toHaveCount(
    0,
  );
  await expect(page.locator("[data-runtime-stream]")).not.toContainText(
    "購読開始失敗",
  );
  const subscriptionId = await page.evaluate(
    () => (window as any).__runtimeHost.starts[1].subscriptionId,
  );
  // A valid update from the retried subscription reaches the screen.
  const update = structuredClone(
    fixtures.find((item) => item.name === "good")!.update,
  );
  update.sequence = 1;
  update.sdkGeneration = 1;
  await page.evaluate(
    ({ subscriptionId, update }) =>
      (window as any).__runtimeHost.emit("scada:read", {
        subscriptionId,
        update,
      }),
    { subscriptionId, update },
  );
  await expect(page.locator("[data-runtime-stream]")).toHaveText(
    "読取: 受信中",
  );
  const number = page
    .getByTestId("operator-frame")
    .locator('[data-tag-name="Demo.Number"]')
    .first();
  await expect(number).toHaveAttribute("data-tag-state", "good");
  await expect(number.locator("[data-text-content]")).toHaveText("0");
  expect(await calls(page)).not.toContain("auth_config_apply");
});

test("the Runtime authentication popover leaves the move to operation and the settings to Editor", async ({
  page,
}) => {
  await mockRuntimeHost(page, { auth: "setup" });
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await page.locator(".runtime-auth summary").click();
  const popover = page.locator(".runtime-auth .auth-popover");
  await expect(popover).toContainText(
    "運用への移行は Editor で行ってください。",
  );
  await expect(popover.getByRole("button", { name: /運用へ移行/ })).toHaveCount(
    0,
  );
  await expect(popover.getByRole("form", { name: "運用への移行" })).toHaveCount(
    0,
  );
  await expect(popover.getByRole("button", { name: "認証設定…" })).toHaveCount(
    0,
  );
  await expect(
    popover.getByRole("button", { name: "利用者管理…" }),
  ).toBeVisible();
});

test("a Runtime in the middle of the move asks to re-run it in Editor", async ({
  page,
}) => {
  await mockRuntimeHost(page, { auth: "transitioning" });
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await page.locator(".runtime-auth summary").click();
  const popover = page.locator(".runtime-auth .auth-popover");
  await expect(popover.getByRole("alert")).toContainText(
    "Editor で管理者の資格情報を使って移行を再実行してください",
  );
  await expect(popover.getByRole("button", { name: /移行/ })).toHaveCount(0);
});

const alarmDialog = (page: Page) =>
  page.getByRole("dialog", { name: "アラーム一覧" });

test("the top bar alarm entry shows the alarm state and opens the alarm list; ACK goes to alarm_ack", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  const entry = page.locator("[data-runtime-alarm-entry]");
  await expect(entry).toHaveText("警報: 監視中");
  await entry.click();
  const dialog = alarmDialog(page);
  await expect(dialog).toBeVisible();
  const row = dialog.locator('[data-alarm-row="cond-a"]');
  await expect(row).toContainText("未確認（発生中）");
  await row.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "選んだ警報を ACK", exact: true })
    .click();
  await expect(row.locator("[data-alarm-row-result]")).toHaveText("受理");
  expect(await page.evaluate(() => (window as any).__runtimeHost.acks)).toEqual(
    [[{ conditionId: "cond-a", occurrence: "occ-1", recurrence: 0 }]],
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
  const used = await calls(page);
  expect(used).toContain("alarm_snapshot");
  expect(used).not.toContain("alarm_apply");
});

test("the operator view opens the same alarm list and the terminal settings have no sound import", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  const view = page.getByRole("region", { name: "運転表示" });
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await view.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  const dialog = alarmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-alarm-row="cond-a"]')).toBeVisible();
  await dialog.getByRole("button", { name: "端末設定", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "警報の端末設定" });
  await expect(settings).toBeVisible();
  await expect(settings.locator("[data-alarm-sound]")).toContainText(
    "既定のビープ",
  );
  await expect(
    settings.getByRole("button", { name: "ファイルを選ぶ" }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "既定に戻す" }),
  ).toBeVisible();
  await expect(settings).not.toContainText(
    "この版では端末設定を変更できません",
  );
  const used = await calls(page);
  expect(used).toContain("alarm_settings_get");
  expect(used).not.toContain("alarm_sound_import");
  expect(used).not.toContain("alarm_apply");
});

test("the top bar opens the history trend window over runtime_history_context", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await page.locator("[data-runtime-history-entry]").click();
  const dialog = page.getByRole("dialog", {
    name: "履歴トレンド",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("履歴系列一覧を確認しました");
  await dialog
    .getByRole("checkbox", { name: "温度 number", exact: true })
    .check();
  await dialog
    .getByLabel("開始UTC", { exact: true })
    .fill("1970-01-01T00:00:00.500Z");
  await dialog
    .getByLabel("終了UTC", { exact: true })
    .fill("1970-01-01T00:00:02.000Z");
  await dialog.getByLabel("取得モード").selectOption("raw");
  await dialog.getByLabel("系列ごとの点数上限").fill("20");
  await dialog.getByRole("button", { name: "取得", exact: true }).click();
  const trend = dialog.locator("[data-history-phase]");
  await expect(trend).toHaveAttribute("data-history-phase", "ready");
  await expect(trend.locator("[data-history-point]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-runtime-history-entry]")).toBeFocused();
  const used = await calls(page);
  expect(used).toContain("runtime_history_context");
  expect(used).toContain("history_query");
  expect(used).not.toContain("history_context");
});

/** The recording commands only Editor may call (Runtime mode design §5, §10-3 案 A). */
const recordingWrites = [
  "recording_context",
  "recording_initial_setup",
  "recording_resume",
  "recording_stop",
  "recording_reconfigure",
  "recording_owner_rebind",
];

test("the top bar shows the recording state read-only and leaves starting it to Editor", async ({
  page,
}) => {
  await mockRuntimeHost(page);
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  const status = page.locator("[data-runtime-recording]");
  await expect(status).toContainText("記録未設定");
  await expect(page.locator("[data-runtime-recording-note]")).toHaveText(
    "Runtime の運転中は記録されません。記録は Editor で開始します",
  );
  await expect(
    page.getByRole("button", { name: /記録を(再開|開始|停止)/ }),
  ).toHaveCount(0);
  // A click inspects again.
  await status.click();
  await expect
    .poll(async () =>
      (await calls(page)).filter((c) => c === "recording_status"),
    )
    .toHaveLength(2);
  await expect(status).toContainText("記録未設定");
  const used = await calls(page);
  expect(used).toContain("runtime_recording_context");
  for (const command of recordingWrites) expect(used).not.toContain(command);
  expect(used.some((c) => c.startsWith("recording_workflow_"))).toBe(false);
});

test("the top bar shows a running recording without the Editor note", async ({
  page,
}) => {
  await mockRuntimeHost(page, { recording: "running" });
  await page.goto("/runtime.html");
  await expect(page.locator("[data-runtime-recording]")).toContainText(
    "記録中",
  );
  await expect(page.locator("[data-runtime-recording-note]")).toHaveCount(0);
  const used = await calls(page);
  for (const command of recordingWrites) expect(used).not.toContain(command);
});

test("a Runtime with the auth on and no administrator creates the first one with auth_setup", async ({
  page,
}) => {
  await mockRuntimeHost(page, { auth: "firstAdmin" });
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  await expect(page.locator("[data-runtime-recording]")).toContainText(
    "記録: ログインが必要",
  );
  expect(await calls(page)).not.toContain("runtime_recording_context");

  await page.locator(".runtime-auth summary").click();
  const popover = page.locator(".runtime-auth .auth-popover");
  const form = popover.getByRole("form", { name: "最初の管理者を作成" });
  await expect(form).toBeVisible();
  await expect(popover.getByRole("form", { name: "ログイン" })).toHaveCount(0);
  await form.getByLabel("管理者のユーザー名").fill("admin");
  await form.getByLabel("表示名").fill("管理者");
  await form.getByLabel("パスワード", { exact: true }).fill("secret-pass");
  await form.getByLabel("パスワード（確認）").fill("other-pass");
  await form.getByRole("button", { name: "最初の管理者を作成" }).click();
  await expect(popover).toContainText("確認用のパスワードが一致しません。");
  expect(await calls(page)).not.toContain("auth_setup");

  await form.getByLabel("パスワード（確認）").fill("secret-pass");
  await form.getByRole("button", { name: "最初の管理者を作成" }).click();
  await expect(popover).toContainText(
    "最初の管理者を作成し、ログインしました。",
  );
  await expect(page.locator(".runtime-auth summary")).toContainText("管理者");
  await expect(form).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__runtimeHost.setups),
  ).toEqual([
    { username: "admin", password: "secret-pass", displayName: "管理者" },
  ]);
  expect(await calls(page)).not.toContain("auth_transition_to_operational");
  // Signed in, the recording state is read.
  await expect(page.locator("[data-runtime-recording]")).toContainText(
    "記録未設定",
  );
});

test("a failed alarm subscription keeps a warning until a refresh re-subscribes, then changes arrive", async ({
  page,
}) => {
  await mockRuntimeHost(page, { alarmListen: "blocked" });
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  const entry = page.locator("[data-runtime-alarm-entry]");
  // The snapshot is still read, but without the subscription it is not 監視中.
  await expect(entry).toHaveText("警報: 変化を受け取れません");
  await entry.click();
  const dialog = alarmDialog(page);
  const row = dialog.locator('[data-alarm-row="cond-a"]');
  await expect(row).toContainText("未確認（発生中）");
  await expect(entry).toHaveText("警報: 変化を受け取れません");

  // The host recovers; the refresh after ACK subscribes again.
  await page.evaluate(
    () => ((window as any).__runtimeHost.alarmListenBlocked = false),
  );
  await row.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "選んだ警報を ACK", exact: true })
    .click();
  await expect(row.locator("[data-alarm-row-result]")).toHaveText("受理");
  await expect(entry).toHaveText("警報: 監視中");

  // A new alarm reaches the list only through the subscription.
  await page.evaluate(() => {
    const host = (window as any).__runtimeHost;
    const engine = host.alarm.engine;
    engine.seq += 1;
    const state = {
      ...engine.conditions["cond-a"],
      acked: false,
      occurrence: "occ-b",
      orderKey: { generation: 1, seq: engine.seq },
    };
    engine.conditions["cond-b"] = state;
    host.emit("alarm_changed", {
      session: engine.session,
      seq: engine.seq,
      conditions: { "cond-b": state },
      engineUnavailable: null,
    });
  });
  await expect(dialog.locator('[data-alarm-row="cond-b"]')).toBeVisible();
  await expect(entry).toHaveText("警報: 監視中");
});

test("after re-subscribing, the top bar stays 再同期中 until a snapshot read after it arrives", async ({
  page,
}) => {
  await mockRuntimeHost(page, { alarmListen: "blocked" });
  await page.goto("/runtime.html");
  await expect(page.getByTestId("operator-frame")).toBeVisible();
  const entry = page.locator("[data-runtime-alarm-entry]");
  await expect(entry).toHaveText("警報: 変化を受け取れません");
  await entry.click();
  const dialog = alarmDialog(page);
  const row = dialog.locator('[data-alarm-row="cond-a"]');
  await expect(row).toContainText("未確認（発生中）");

  // The host recovers, and an alarm happens while nothing is subscribed (never redelivered).
  await page.evaluate(() => {
    const host = (window as any).__runtimeHost;
    // Recover only at the ACK, so the retry timer cannot subscribe first.
    host.unblockListenOnAck = true;
    host.holdSnapshots = true;
    const engine = host.alarm.engine;
    engine.seq += 1;
    engine.conditions["cond-b"] = {
      ...engine.conditions["cond-a"],
      occurrence: "occ-b",
      orderKey: { generation: 1, seq: engine.seq },
    };
  });
  // The refresh after ACK subscribes again; the snapshot it reads is held.
  await row.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "選んだ警報を ACK", exact: true })
    .click();
  await expect(row.locator("[data-alarm-row-result]")).toHaveText("受理");
  await expect(entry).toHaveText("警報: 再同期中");
  await expect(dialog.locator('[data-alarm-row="cond-b"]')).toHaveCount(0);

  // The read already in flight before the subscription does not end the resync;
  // a fresh read follows it.
  const held = () =>
    page.evaluate(() => (window as any).__runtimeHost.heldSnapshots.length);
  await expect.poll(held).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__runtimeHost.releaseSnapshots());
  await expect.poll(held).toBeGreaterThan(0);
  await expect(entry).toHaveText("警報: 再同期中");

  await page.evaluate(() => {
    const host = (window as any).__runtimeHost;
    host.holdSnapshots = false;
    host.releaseSnapshots();
  });
  await expect(entry).toHaveText("警報: 監視中");
  await expect(dialog.locator('[data-alarm-row="cond-b"]')).toBeVisible();
});

test.describe("the faceplate's operation rows (operation stage 3, O3c-1)", () => {
  const pump = "[data-equipment-link='0199f700-0000-7000-8000-000000000002']";

  test("the product's hub_unsupported disables every row with its reason", async ({
    page,
  }) => {
    await mockRuntimeHost(page, { operation: "hubUnsupported" });
    await page.goto("/runtime.html");
    await page.locator(pump).first().click();
    const rows = page.getByRole("region", { name: "機器の操作" });
    await expect(rows).toBeVisible();
    await expect(rows.locator("[data-operation-disabled]")).toHaveText(
      "Hub が書込みに対応していません",
    );
    await expect(rows.locator("[data-operation-banner]")).toHaveCount(0);
    await expect(rows.getByRole("button", { name: "運転" })).toBeDisabled();
    await expect(rows.getByRole("button", { name: "設定" })).toBeDisabled();
    await expect(page.getByText("表示確認（書込みなし）")).toHaveCount(0);
  });

  test("a button asks with 取消 focused and 実行 sends operation_write", async ({
    page,
  }) => {
    await mockRuntimeHost(page, { operation: "ready" });
    await page.goto("/runtime.html");
    await page.locator(pump).first().click();
    const rows = page.getByRole("region", { name: "機器の操作" });
    await expect(rows.locator("[data-operation-banner]")).toHaveText(
      "初期設定中: ログインなしで書込みできます",
    );
    // An input outside the range is stopped before the confirmation.
    await rows.getByRole("textbox", { name: /電流 設定/ }).fill("120");
    await rows.getByRole("button", { name: "設定" }).click();
    await expect(rows.getByRole("alert")).toHaveText("値が範囲の外です");
    await expect(page.getByRole("dialog", { name: "操作の確認" })).toHaveCount(
      0,
    );

    await rows.getByRole("button", { name: "運転", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "操作の確認" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await expect(
      dialog.locator("[data-operation-confirm-value]"),
    ).toContainText("→ 運転（true）");
    await dialog.getByRole("button", { name: "実行" }).click();
    await expect(dialog).toHaveCount(0);
    const result = rows.locator(
      "[data-operation-slot='running'] [data-operation-result]",
    );
    await expect(result).toContainText("書込みました");
    await expect(result).toContainText("要求値 運転（true）");
    const writes = await page.evaluate(
      () => (window as any).__runtimeHost.writes,
    );
    expect(writes).toEqual([
      {
        projectId: sample.manifest.projectId,
        projectDigest: "00",
        screenId: expect.any(String),
        objectId: expect.any(String),
        equipmentId: "0199f700-0000-7000-8000-000000000002",
        slotName: "running",
        expectedValue: true,
        buttonIndex: 0,
      },
    ]);
    const objectId = await page
      .locator(pump)
      .first()
      .getAttribute("data-object-id");
    expect(writes[0].objectId).toBe(objectId);
  });

  test("an open faceplate reads the host again and is released when busy ends", async ({
    page,
  }) => {
    await mockRuntimeHost(page, { operation: "ready" });
    await page.addInitScript(() => {
      const wait = setInterval(() => {
        const host = (window as any).__runtimeHost;
        if (host) {
          host.operationBlocked = "busy";
          clearInterval(wait);
        }
      });
    });
    await page.goto("/runtime.html");
    await page.locator(pump).first().click();
    const rows = page.getByRole("region", { name: "機器の操作" });
    const run = rows.getByRole("button", { name: "運転", exact: true });
    await expect(run).toBeDisabled();
    // Another write ends: the next read releases the rows without reopening.
    await page.evaluate(() => {
      (window as any).__runtimeHost.operationBlocked = null;
    });
    await expect(run).toBeEnabled({ timeout: 10_000 });
  });

  test("a faceplate whose reads take longer than the refresh still loads", async ({
    page,
  }) => {
    await mockRuntimeHost(page, { operation: "ready" });
    await page.addInitScript(() => {
      const wait = setInterval(() => {
        const host = (window as any).__runtimeHost;
        if (host) {
          host.viewDelayMs = 2_500;
          clearInterval(wait);
        }
      });
    });
    await page.goto("/runtime.html");
    await page.locator(pump).first().click();
    const rows = page.getByRole("region", { name: "機器の操作" });
    await expect(
      rows.getByRole("button", { name: "運転", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
  });

  test("a write whose answer is lost reads as unknown, not as refused", async ({
    page,
  }) => {
    await mockRuntimeHost(page, { operation: "ready" });
    await page.goto("/runtime.html");
    await page.evaluate(() => {
      (window as any).__runtimeHost.writeLost = true;
    });
    await page.locator(pump).first().click();
    const rows = page.getByRole("region", { name: "機器の操作" });
    await rows.getByRole("button", { name: "運転", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "操作の確認" });
    await dialog.getByRole("button", { name: "実行" }).click();
    const slot = rows.locator("[data-operation-slot='running']");
    const notice = slot.locator("[data-operation-notice]");
    await expect(notice).toContainText(
      "結果不明。現在値と実行記録を確認してください",
    );
    await expect(notice).toContainText("要求値 運転（true）");
    await expect(slot).not.toContainText("受け付けませんでした");
    // Another operation's row arrives in the record: it is shown, and the
    // notice of the lost answer stays (the two cannot be matched).
    await page.evaluate(() => {
      (window as any).__runtimeHost.latest = {
        id: "another-operation",
        state: "finished",
        outcome: "refused",
        reason: "busy",
        requestedAtMs: Date.UTC(2026, 10, 19, 1, 2, 3),
        finishedAtMs: Date.UTC(2026, 10, 19, 1, 2, 4),
        tag: "Plant.Run",
        value: false,
        auditId: null,
      };
    });
    await expect(slot.locator("[data-operation-result]")).toContainText(
      "送っていません",
      { timeout: 10_000 },
    );
    await expect(notice).toContainText(
      "結果不明。現在値と実行記録を確認してください",
    );
  });
});
