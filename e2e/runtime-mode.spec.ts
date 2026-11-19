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
  auth?: "operational" | "setup" | "transitioning";
}

async function mockRuntimeHost(page: Page, options: RuntimeHostOptions = {}) {
  await page.addInitScript(
    ({ options, projectJson, historyResult }) => {
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let nextId = 0;
      const host = {
        calls: [] as string[],
        starts: [] as Record<string, unknown>[],
        acks: [] as unknown[],
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
                return structuredClone(host.alarm);
              case "alarm_ack": {
                host.acks.push(structuredClone(args!.items));
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
              case "auth_phase":
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
      projectJson: JSON.stringify(sample),
      historyResult: rawCases[0].expected as any,
    },
  );
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
