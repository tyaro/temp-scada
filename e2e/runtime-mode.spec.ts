import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };

/**
 * The Runtime window (Runtime mode design §6, §9 O0b) against a mock host
 * with the wire shapes of `runtime.rs` / `main.rs` / `app_mode.rs`.
 */
interface RuntimeHostOptions {
  project?: "opened" | "unreadable" | "invalidBody";
  hub?: "connected" | "reconnectInEditor";
  alarm?: "notApplied" | "otherProject" | "differs" | "same";
}

async function mockRuntimeHost(page: Page, options: RuntimeHostOptions = {}) {
  await page.addInitScript(
    ({ options, projectJson }) => {
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let nextId = 0;
      const host = {
        calls: [] as string[],
        starts: [] as Record<string, unknown>[],
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
                return null;
              case "hub_read_stop":
                return null;
              case "runtime_alarm_status":
                return options.alarm ?? "same";
              case "auth_phase":
                return {
                  phase: "operational",
                  authDisabled: true,
                  hasAdmin: true,
                };
              case "auth_resolve":
                return {
                  identity: { id: "local", name: "ローカル", role: "viewer" },
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
    { options, projectJson: JSON.stringify(sample) },
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
