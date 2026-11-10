import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

async function mockNativeHost(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 0;
    const host = {
      starts: [] as { projectJson: string; subscriptionId: string }[],
      stops: [] as string[],
      catalogRequests: 0,
      connected: false,
      rejectStart: false,
      emit(subscriptionId: string, update: unknown) {
        for (const { event, handler } of listeners.values())
          if (event === "scada:read")
            callbacks.get(handler)?.({
              event: "scada:read",
              id: 1,
              payload: { subscriptionId, update },
            });
      },
    };
    Object.assign(window, { __nativeReadHost: host });
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener(_event: string, eventId: number) {
          listeners.delete(eventId);
        },
      },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback(callback: (event: unknown) => void) {
          const id = ++nextId;
          callbacks.set(id, callback);
          return id;
        },
        async invoke(command: string, args?: Record<string, any>) {
          if (command === "plugin:event|listen") {
            const id = ++nextId;
            listeners.set(id, { event: args!.event, handler: args!.handler });
            return id;
          }
          if (command === "plugin:event|unlisten") return null;
          if (command === "hub_saved_endpoint") return "http://127.0.0.1:8722";
          if (command === "hub_connect") {
            host.connected = true;
            return { state: "connected", tagCount: 3 };
          }
          if (command === "hub_disconnect") {
            host.connected = false;
            return null;
          }
          if (command === "hub_read_start") {
            if (!host.connected) throw Error("not_connected");
            if (host.rejectStart) throw Error("unauthorized");
            host.starts.push(
              args as {
                projectJson: string;
                subscriptionId: string;
              },
            );
            return null;
          }
          if (command === "hub_read_stop") {
            host.stops.push(args!.subscriptionId);
            return null;
          }
          if (command === "hub_catalog") {
            host.catalogRequests++;
            throw Error("catalog_failed");
          }
          throw Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
}

async function currentSubscription(page: Page): Promise<string> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__nativeReadHost.starts.length),
    )
    .toBeGreaterThan(0);
  return page.evaluate(
    () => (window as any).__nativeReadHost.starts.at(-1).subscriptionId,
  );
}

async function publish(
  page: Page,
  subscriptionId: string,
  name: string,
  sequence: number,
) {
  const update = structuredClone(
    fixtures.find(
      (item) => item.name === (name === "unauthorized" ? "disconnected" : name),
    )!.update,
  );
  update.sequence = sequence;
  update.sdkGeneration =
    name === "disconnected" || name === "unauthorized" ? null : sequence;
  if (name === "unauthorized") {
    update.text.connection = "unauthorized";
    update.slots.connection = "unauthorized";
    update.text.lastError = "unauthorized";
    update.slots.lastError = "unauthorized";
  }
  await page.evaluate(
    ({ subscriptionId, update }) =>
      (window as any).__nativeReadHost.emit(subscriptionId, update),
    { subscriptionId, update },
  );
}

test("native shell delivers mock Hub values and retires old IPC sessions", async ({
  page,
}) => {
  await mockNativeHost(page);
  await page.goto("/");
  const input = {
    name: "read-presentation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  };
  await openProject(page, input);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__nativeReadHost.catalogRequests),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 50", exact: true })
    .click();
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveValue("Demo.Number");
  await expect(
    page.getByRole("button", { name: "タグを選択", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const number = mainCanvas(page)
    .locator('[data-tag-name="Demo.Number"]')
    .first();
  const first = await currentSubscription(page);
  await publish(page, first, "good", 1);
  await expect(number).toHaveAttribute("data-tag-state", "good");
  await expect(number.locator("[data-text-content]")).toHaveText("0");
  for (const [name, sequence] of [
    ["bad", 2],
    ["stale", 3],
    ["waiting", 4],
  ] as const) {
    await publish(page, first, name, sequence);
    await expect(number).toHaveAttribute(
      "data-tag-state",
      name === "waiting" ? "unresolved" : name,
    );
    await expect(number.locator("[data-text-content]")).not.toHaveText("0");
  }
  await openProject(page, input);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__nativeReadHost.starts.length),
    )
    .toBeGreaterThan(1);
  const second = await currentSubscription(page);
  expect(second).not.toBe(first);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => (window as any).__nativeReadHost.stops.includes(id),
        first,
      ),
    )
    .toBe(true);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await publish(page, first, "good", 99);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await publish(page, second, "good", 1);
  await expect(number).toHaveAttribute("data-tag-state", "good");

  const hub = page.locator(".app-header .hub-connection summary");
  await hub.click();
  await page.getByRole("button", { name: "切断", exact: true }).click();
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await expect
    .poll(() =>
      page.evaluate(
        (id) => (window as any).__nativeReadHost.stops.includes(id),
        second,
      ),
    )
    .toBe(true);
  await publish(page, second, "good", 99);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__nativeReadHost.starts.length),
    )
    .toBeGreaterThan(2);
  const third = await currentSubscription(page);
  await publish(page, third, "good", 1);
  await expect(number).toHaveAttribute("data-tag-state", "good");
  await publish(page, third, "unauthorized", 2);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await expect(hub).toContainText("要確認");
  await expect(
    page.getByRole("status").filter({ hasText: "Hubの読取認証が失効しました" }),
  ).toBeVisible();

  await page.evaluate(
    () => ((window as any).__nativeReadHost.rejectStart = true),
  );
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await publish(page, third, "good", 99);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await expect(
    page.getByRole("status").filter({ hasText: "読取: 認証が必要" }),
  ).toBeVisible();

  await page.reload();
  await openProject(page, input);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const restarted = await currentSubscription(page);
  await expect(number).toHaveAttribute("data-tag-state", "disconnected");
  await publish(page, restarted, "good", 1);
  await expect(number).toHaveAttribute("data-tag-state", "good");
});
