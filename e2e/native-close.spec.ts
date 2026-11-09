import { expect, test, type Locator, type Page } from "@playwright/test";

// The confirmation before the desktop window closes, over a mocked Tauri
// IPC (product-owner design §6.1): the host holds the close and sends
// `scada:close`, the shell asks or shows the exit's wait, and answers with
// `app_close_reply`. NativeShell, CloseConfirm and the Modal are production.
// The first event is sent until it is shown: the shell subscribes after it
// mounts.
async function mockNativeHost(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 0;
    const host = {
      replies: [] as { id: number; reply: string }[],
      refuse: false,
      emit(payload: unknown) {
        for (const { event, handler } of listeners.values())
          if (event === "scada:close")
            callbacks.get(handler)?.({ event, id: 1, payload });
      },
    };
    Object.assign(window, { __closeHost: host });
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
        async invoke(command: string, args: Record<string, any> = {}) {
          switch (command) {
            case "plugin:event|listen": {
              const id = ++nextId;
              listeners.set(id, { event: args.event, handler: args.handler });
              return id;
            }
            case "plugin:event|unlisten":
            case "hub_saved_endpoint":
            case "history_context":
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
                identity: { id: "local", name: "ローカル", role: "admin" },
                kind: "local",
                checked: 1,
                current: 1,
                stale: false,
              };
            case "app_close_reply":
              host.replies.push({ id: args.id, reply: args.reply });
              if (host.refuse && args.reply !== "shown") throw "stale_prompt";
              return null;
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
  });
}

const emit = (page: Page, payload: unknown) =>
  page.evaluate((p) => (window as any).__closeHost.emit(p), payload);
const replies = (page: Page) =>
  page.evaluate(() => [...(window as any).__closeHost.replies]);
const question = (page: Page) =>
  page.getByRole("dialog", { name: "終了の確認", exact: true });
const exiting = (page: Page) =>
  page.getByRole("dialog", { name: "終了しています", exact: true });

async function ready(page: Page) {
  await mockNativeHost(page);
  await page.goto("/");
}

/** Send the first event until `shown` is visible (the app loads first). */
async function first(page: Page, payload: unknown, shown: Locator) {
  await expect
    .poll(
      async () => {
        await emit(page, payload);
        return shown.isVisible();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test("a Candidate is asked before the exit and a cancel keeps the window", async ({
  page,
}) => {
  await ready(page);
  await first(page, { id: 1, kind: "candidate" }, question(page));
  await expect(question(page)).toContainText(
    "未完了の変更候補があります。破棄して終了しますか。",
  );
  await expect
    .poll(() => replies(page))
    .toContainEqual({
      id: 1,
      reply: "shown",
    });
  await question(page).getByRole("button", { name: "キャンセル" }).click();
  await expect(question(page)).toBeHidden();
  expect((await replies(page)).at(-1)).toEqual({ id: 1, reply: "cancel" });

  // The next close asks again; the discard exits.
  await emit(page, { id: 2, kind: "candidate" });
  await question(page).getByRole("button", { name: "破棄して終了" }).click();
  await expect(question(page)).toBeHidden();
  await expect(exiting(page)).toContainText("変更候補を破棄して終了します。");
  expect((await replies(page)).at(-1)).toEqual({ id: 2, reply: "discard" });
  // The notice cannot be dismissed while the exit runs.
  await page.keyboard.press("Escape");
  await expect(exiting(page)).toBeVisible();
});

test("accepted work in progress is only shown while the exit waits", async ({
  page,
}) => {
  await ready(page);
  await first(page, { id: 1, kind: "waiting" }, exiting(page));
  await expect(exiting(page)).toContainText(
    "記録の操作が終わるまで待って終了します。",
  );
  await expect(question(page)).toHaveCount(0);
  expect(await replies(page)).toEqual([]);
});

test("a refused discard drops the notice", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => ((window as any).__closeHost.refuse = true));
  await first(page, { id: 7, kind: "candidate" }, question(page));
  await question(page).getByRole("button", { name: "破棄して終了" }).click();
  await expect(question(page)).toBeHidden();
  await expect(exiting(page)).toBeHidden();
});
