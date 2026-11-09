import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import rawCases from "../examples/history-query-cases.json" with { type: "json" };
import { openProject } from "./helpers/project-files";

// The desktop shell over a mocked Tauri IPC: the History service comes from
// `history_context` and its queries go to `history_query` / `history_cancel`
// (product-owner design §7.1). The App, menu, Modal and form are production.
const planned = {
  ...structuredClone(sample),
  recordingPlan: {
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
  },
};

async function mockNativeHost(page: Page) {
  await page.addInitScript((expected) => {
    const host = {
      contexts: [] as unknown[],
      queries: [] as {
        callId: string;
        query: any;
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }[],
      cancels: [] as string[],
      reply(index: number) {
        const call = host.queries[index];
        const result = structuredClone(expected);
        result.query = structuredClone(call.query);
        result.series = call.query.seriesIds.map((id: string) =>
          result.series.find((row: any) => row.seriesId === id),
        );
        call.resolve(result);
      },
      fail(index: number, code: string) {
        host.queries[index].reject(code);
      },
    };
    Object.assign(window, { __nativeHistoryHost: host });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        async invoke(command: string, args?: Record<string, any>) {
          if (command === "hub_saved_endpoint") return "http://127.0.0.1:8722";
          if (command === "hub_connect")
            return { state: "offline", cause: "test" };
          if (command === "history_context") {
            const project = JSON.parse(args!.projectJson);
            host.contexts.push(project);
            // The host answers only for the plan the recording DB applied.
            if (project.recordingPlan?.planId !== "plan-a") return null;
            return {
              version: 2,
              kind: "historyContext",
              contextId: "applied:1",
              historianNamespace: "historian:test",
              projectId: project.manifest.projectId,
              projectRevision: project.manifest.projectRevision,
              series: [{ seriesId: "number", label: "温度" }],
            };
          }
          if (command === "history_query")
            return new Promise((resolve, reject) =>
              host.queries.push({
                callId: args!.callId,
                query: args!.query,
                resolve,
                reject,
              }),
            );
          if (command === "history_cancel") {
            host.cancels.push(args!.callId);
            return null;
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
  }, rawCases[0].expected);
}

const host = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).__nativeHistoryHost;
    return {
      contexts: h.contexts.length,
      queries: h.queries.map((q: any) => q.callId),
      cancels: [...h.cancels],
    };
  });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "履歴トレンド", exact: true });
const trend = (page: Page) => dialog(page).locator("[data-history-phase]");

async function open(page: Page) {
  await page
    .getByRole("menubar", { name: "Designer メニューバー" })
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "履歴トレンド", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}

async function fill(page: Page) {
  const root = dialog(page);
  await root
    .getByRole("checkbox", { name: "温度 number", exact: true })
    .check();
  await root
    .getByLabel("開始UTC", { exact: true })
    .fill("1970-01-01T00:00:00.500Z");
  await root
    .getByLabel("終了UTC", { exact: true })
    .fill("1970-01-01T00:00:02.000Z");
  await root.getByLabel("取得モード").selectOption("raw");
  await root.getByLabel("系列ごとの点数上限").fill("20");
}

test("native shell reads history through the host commands", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockNativeHost(page);
  await page.goto("/");

  // The sample Project has no recording plan: the host gives no context.
  await expect.poll(async () => (await host(page)).contexts).toBe(1);
  await open(page);
  await expect(dialog(page)).toContainText("履歴サービスは未接続です");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await openProject(page, {
    name: "planned.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(planned)),
  });
  await expect.poll(async () => (await host(page)).contexts).toBe(2);
  await open(page);
  await expect(dialog(page)).toContainText("履歴系列一覧を確認しました");
  await fill(page);
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
  await expect.poll(async () => (await host(page)).queries.length).toBe(1);
  await expect(trend(page)).toHaveAttribute("data-history-phase", "loading");
  await page.evaluate(() => (window as any).__nativeHistoryHost.reply(0));
  await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
  await expect(trend(page).locator("[data-history-point]")).toHaveCount(2);

  // A host failure reaches the screen as its fixed code.
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
  await expect.poll(async () => (await host(page)).queries.length).toBe(2);
  await page.evaluate(() =>
    (window as any).__nativeHistoryHost.fail(1, "tooManyPoints"),
  );
  await expect(trend(page)).toHaveAttribute("data-history-phase", "error");

  // Closing during a query cancels it by its own call ID; the slot is
  // released only when the host settles it.
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
  await expect.poll(async () => (await host(page)).queries.length).toBe(3);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  const { queries, cancels } = await host(page);
  await expect
    .poll(async () => (await host(page)).cancels)
    .toEqual([queries[2]]);
  expect(cancels.length).toBeLessThanOrEqual(1);
  await page.evaluate(() =>
    (window as any).__nativeHistoryHost.fail(2, "cancelled"),
  );
  await open(page);
  await fill(page);
  await dialog(page).getByRole("button", { name: "取得", exact: true }).click();
  await expect.poll(async () => (await host(page)).queries.length).toBe(4);
  await page.evaluate(() => (window as any).__nativeHistoryHost.reply(3));
  await expect(trend(page)).toHaveAttribute("data-history-phase", "ready");
  expect((await host(page)).contexts).toBe(2);
});
